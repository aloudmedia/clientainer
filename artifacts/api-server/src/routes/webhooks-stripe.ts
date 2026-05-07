import { Router, raw as rawBodyParser } from "express";
import { db, workspacesTable, topupsTable, subscriptionsTable, retainerPackagesTable } from "@workspace/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { verifyWebhookEvent } from "../lib/stripe";
import type Stripe from "stripe";

const router = Router();

async function applyConfirmedTopup(topup: any) {
  // ── Switch-package purchase ──────────────────────────────────────────────
  // When `switchToPackageId` is set, this top-up is a "buy a new retainer"
  // purchase: replace the subscription's package and reset balances from the
  // new package, instead of adding hours to the old one. CAS + subscription
  // update run inside a single transaction so we never end up with
  // status=confirmed but the switch unapplied.
  if (topup.switchToPackageId) {
    const [newPkg] = await db.select().from(retainerPackagesTable)
      .where(eq(retainerPackagesTable.id, topup.switchToPackageId));
    if (!newPkg || newPkg.workspaceId !== topup.workspaceId) {
      // Target package is gone or moved workspace between purchase and webhook.
      // Mark the topup failed (CAS-protected) so the customer can be refunded
      // out-of-band; do NOT credit anything to the old subscription.
      await db.update(topupsTable).set({ status: "failed", updatedAt: new Date() })
        .where(and(eq(topupsTable.id, topup.id), ne(topupsTable.status, "confirmed")));
      return;
    }
    const newTotalMinutes = newPkg.type === "unlimited"
      ? 999999
      : (newPkg.totalHours ?? 0) * 60 + (newPkg.totalMinutes ?? 0);
    await db.transaction(async (tx) => {
      const updated = await tx.update(topupsTable).set({
        status: "confirmed",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
        .where(and(eq(topupsTable.id, topup.id), ne(topupsTable.status, "confirmed")))
        .returning({ id: topupsTable.id });
      if (updated.length === 0) return; // sibling event already applied this switch
      await tx.update(subscriptionsTable).set({
        packageId: newPkg.id,
        totalMinutes: newTotalMinutes,
        usedMinutes: 0,
        currency: newPkg.currency,
        status: "active",
      }).where(eq(subscriptionsTable.id, topup.subscriptionId));
    });
    return;
  }

  // Defensive guard: a normal top-up always has a `bundleId`. If we ever see a
  // confirmed-but-non-switch topup with no bundle, it likely means
  // `switchToPackageId` was nulled by a package deletion (FK on delete: set
  // null). Refuse to fall through and credit phantom hours to the old plan.
  if (!topup.bundleId) return;

  // Atomic compare-and-swap on status: only the first successful update returns
  // a row, so concurrent overlapping events (e.g. checkout.session.completed +
  // payment_intent.succeeded arriving in parallel) cannot double-credit.
  const updated = await db.update(topupsTable).set({
    status: "confirmed",
    completedAt: new Date(),
    updatedAt: new Date(),
  })
    .where(and(eq(topupsTable.id, topup.id), ne(topupsTable.status, "confirmed")))
    .returning({ id: topupsTable.id });

  if (updated.length === 0) return;

  const minutesToAdd = topup.hoursToCredit * 60;
  await db.update(subscriptionsTable)
    .set({ totalMinutes: sql`${subscriptionsTable.totalMinutes} + ${minutesToAdd}` })
    .where(eq(subscriptionsTable.id, topup.subscriptionId));
}

async function applyFailedTopup(topup: any, status: "failed" | "cancelled") {
  // Never demote a confirmed (already credited) top-up — atomic guard.
  await db.update(topupsTable).set({
    status,
    updatedAt: new Date(),
  })
    .where(and(eq(topupsTable.id, topup.id), ne(topupsTable.status, "confirmed")));
}

async function findTopupForEvent(event: Stripe.Event, workspaceId: number) {
  const obj = event.data.object as any;
  const metadataTopupId = obj?.metadata?.topupId;
  let topup: any | undefined;

  if (metadataTopupId) {
    const id = parseInt(metadataTopupId, 10);
    if (Number.isFinite(id)) {
      [topup] = await db.select().from(topupsTable).where(eq(topupsTable.id, id));
    }
  }
  if (!topup && obj?.id && event.type.startsWith("checkout.session.")) {
    [topup] = await db.select().from(topupsTable)
      .where(eq(topupsTable.stripeCheckoutSessionId, obj.id));
  }
  if (!topup && obj?.id && event.type.startsWith("payment_intent.")) {
    [topup] = await db.select().from(topupsTable)
      .where(eq(topupsTable.stripePaymentIntentId, obj.id));
  }
  if (!topup || topup.workspaceId !== workspaceId) return null;
  return topup;
}

async function handleEvent(event: Stripe.Event, workspaceId: number) {
  const topup = await findTopupForEvent(event, workspaceId);
  if (!topup) return;

  const obj = event.data.object as any;

  // Persist any newly-seen Stripe ids so future events can correlate.
  const updates: any = {};
  if (event.type.startsWith("checkout.session.")) {
    if (!topup.stripeCheckoutSessionId && obj?.id) updates.stripeCheckoutSessionId = obj.id;
    if (!topup.stripePaymentIntentId && obj?.payment_intent) {
      updates.stripePaymentIntentId = typeof obj.payment_intent === "string"
        ? obj.payment_intent : obj.payment_intent?.id;
    }
  } else if (event.type.startsWith("payment_intent.")) {
    if (!topup.stripePaymentIntentId && obj?.id) updates.stripePaymentIntentId = obj.id;
  }
  if (Object.keys(updates).length > 0) {
    await db.update(topupsTable).set(updates).where(eq(topupsTable.id, topup.id));
    Object.assign(topup, updates);
  }

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "payment_intent.succeeded":
      await applyConfirmedTopup(topup);
      break;
    case "checkout.session.expired":
      await applyFailedTopup(topup, "cancelled");
      break;
    case "checkout.session.async_payment_failed":
    case "payment_intent.payment_failed":
    case "payment_intent.canceled":
      await applyFailedTopup(topup, event.type === "payment_intent.canceled" ? "cancelled" : "failed");
      break;
    default:
      // ignore
      break;
  }
}

// POST /webhooks/stripe/:workspaceId
// Raw body parser scoped to this route only so signature verification works.
router.post(
  "/webhooks/stripe/:workspaceId",
  rawBodyParser({ type: "*/*", limit: "1mb" }),
  async (req, res) => {
    try {
      const workspaceId = parseInt(req.params.workspaceId as string, 10);
      if (!Number.isFinite(workspaceId)) return res.status(400).end();

      const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId));
      if (!workspace || !workspace.stripeSecretKey || !workspace.stripeWebhookSecret) {
        return res.status(404).end();
      }

      const sig = req.headers["stripe-signature"] as string | undefined;
      const rawBody = req.body as Buffer;

      let event: Stripe.Event;
      try {
        event = verifyWebhookEvent(
          workspace.stripeSecretKey,
          rawBody,
          sig,
          workspace.stripeWebhookSecret,
        );
      } catch (err: any) {
        req.log.warn({ workspaceId, err: err?.message }, "Invalid Stripe webhook signature");
        return res.status(400).end();
      }

      try {
        await handleEvent(event, workspaceId);
      } catch (err) {
        req.log.error({ err, eventId: event.id }, "Error handling Stripe webhook event");
      }

      return res.status(204).end();
    } catch (err) {
      req.log.error({ err }, "Stripe webhook handler error");
      return res.status(500).end();
    }
  },
);

export default router;
