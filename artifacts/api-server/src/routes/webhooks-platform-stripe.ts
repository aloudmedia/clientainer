import { Router, raw as rawBodyParser } from "express";
import { db, workspacesTable, type PlanId } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyPlatformWebhookEvent, PlatformStripeConfigError } from "../lib/platform-stripe";
import type Stripe from "stripe";

const router = Router();

function planFromPriceId(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  if (
    priceId === process.env.PLATFORM_STRIPE_PRICE_BASIC_MONTHLY ||
    priceId === process.env.PLATFORM_STRIPE_PRICE_BASIC_ANNUAL
  ) return "basic";
  if (
    priceId === process.env.PLATFORM_STRIPE_PRICE_PRO_MONTHLY ||
    priceId === process.env.PLATFORM_STRIPE_PRICE_PRO_ANNUAL ||
    priceId === process.env.PLATFORM_STRIPE_PRICE_PRO  // legacy fallback
  ) return "professional";
  if (
    priceId === process.env.PLATFORM_STRIPE_PRICE_AGENCY_MONTHLY ||
    priceId === process.env.PLATFORM_STRIPE_PRICE_AGENCY_ANNUAL ||
    priceId === process.env.PLATFORM_STRIPE_PRICE_AGENCY  // legacy fallback
  ) return "agency";
  return null;
}

async function handleEvent(event: Stripe.Event, log: any) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "subscription") return;
      const wsIdRaw = session.client_reference_id ?? (session.metadata?.workspaceId as string | undefined);
      const workspaceId = wsIdRaw ? parseInt(wsIdRaw, 10) : NaN;
      if (!Number.isFinite(workspaceId)) return;
      const planId = (session.metadata?.planId as PlanId | undefined) ?? null;

      // Only persist Stripe identifiers here. The actual plan grant is driven
      // by `customer.subscription.created/updated` events, so we never grant a
      // paid tier until the subscription is `active` or `trialing`.
      const updates: any = {};
      if (typeof session.customer === "string") updates.platformStripeCustomerId = session.customer;
      else if (session.customer && "id" in session.customer) updates.platformStripeCustomerId = session.customer.id;
      if (typeof session.subscription === "string") updates.platformStripeSubscriptionId = session.subscription;
      else if (session.subscription && "id" in session.subscription) updates.platformStripeSubscriptionId = session.subscription.id;
      void planId;

      if (Object.keys(updates).length > 0) {
        await db.update(workspacesTable).set(updates).where(eq(workspacesTable.id, workspaceId));
      }
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const priceId = sub.items.data[0]?.price?.id ?? null;
      const planId = planFromPriceId(priceId);
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

      const wsIdMeta = (sub.metadata?.workspaceId as string | undefined);
      const workspaceId = wsIdMeta ? parseInt(wsIdMeta, 10) : NaN;

      const updates: any = {
        platformStripeSubscriptionId: sub.id,
        platformStripeCustomerId: customerId,
        platformSubscriptionStatus: sub.status as any,
        platformCurrentPeriodEnd: (sub as any).current_period_end
          ? new Date((sub as any).current_period_end * 1000)
          : null,
      };
      // Entitlement = plan tier — must follow the actual subscription status.
      // Only `active` and `trialing` grant the paid tier; every other state
      // (incomplete, past_due, canceled, incomplete_expired, unpaid) drops the
      // workspace back to Free so plan limits re-engage immediately.
      if (planId && (sub.status === "active" || sub.status === "trialing")) {
        updates.plan = planId;
      } else {
        updates.plan = "free";
      }

      if (Number.isFinite(workspaceId)) {
        await db.update(workspacesTable).set(updates).where(eq(workspacesTable.id, workspaceId));
      } else {
        // Fall back to looking up by customer id.
        await db.update(workspacesTable).set(updates).where(eq(workspacesTable.platformStripeCustomerId, customerId));
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      await db.update(workspacesTable).set({
        plan: "free",
        platformSubscriptionStatus: "canceled",
        platformStripeSubscriptionId: null,
      }).where(eq(workspacesTable.platformStripeCustomerId, customerId));
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      if (!customerId) return;
      await db.update(workspacesTable)
        .set({ platformSubscriptionStatus: "past_due" })
        .where(eq(workspacesTable.platformStripeCustomerId, customerId));
      break;
    }

    default:
      log?.debug({ type: event.type }, "Unhandled platform Stripe webhook event");
      break;
  }
}

router.post(
  "/webhooks/platform-stripe",
  rawBodyParser({ type: "*/*", limit: "1mb" }),
  async (req, res) => {
    try {
      let event: Stripe.Event;
      try {
        event = verifyPlatformWebhookEvent(req.body as Buffer, req.headers["stripe-signature"] as string | undefined);
      } catch (err: any) {
        if (err instanceof PlatformStripeConfigError) {
          req.log.warn("Platform Stripe webhook received but not configured");
          return res.status(503).end();
        }
        req.log.warn({ err: err?.message }, "Invalid platform Stripe webhook signature");
        return res.status(400).end();
      }

      try {
        await handleEvent(event, req.log);
      } catch (err) {
        req.log.error({ err, eventId: event.id }, "Error handling platform Stripe webhook event");
      }
      return res.status(204).end();
    } catch (err) {
      req.log.error({ err }, "Platform Stripe webhook handler error");
      return res.status(500).end();
    }
  },
);

export default router;
