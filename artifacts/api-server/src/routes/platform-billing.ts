import { Router } from "express";
import { db, workspacesTable, PLANS, PUBLIC_PLAN_IDS, type PlanId, type BillingInterval } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireWorkspaceAdmin } from "../lib/auth";
import {
  createPlatformCheckoutSession,
  createBillingPortalSession,
  PlatformStripeConfigError,
} from "../lib/platform-stripe";

const router = Router();

const APP_BASE_URL = (() => {
  const domains = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (domains) return `https://${domains}`;
  return process.env.APP_BASE_URL ?? "http://localhost:5000";
})();

router.get("/platform/plans", (_req, res) => {
  // Public so the pricing UI can render without auth. Legacy "free" plan is
  // omitted — every new workspace starts on a paid trial.
  res.json(PUBLIC_PLAN_IDS.map(id => {
    const p = PLANS[id];
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      priceUsd: p.priceUsd,
      priceUsdMonthly: p.priceUsdMonthly,
      priceUsdAnnual: p.priceUsdAnnual,
      perUser: p.perUser,
      interval: p.interval,
      features: p.features,
      limits: p.limits,
    };
  }));
});

router.get("/platform/subscription", requireWorkspaceAdmin, async (req, res) => {
  const ws = (req as any).workspace as typeof workspacesTable.$inferSelect;
  res.json({
    plan: ws.plan,
    status: ws.platformSubscriptionStatus,
    currentPeriodEnd: ws.platformCurrentPeriodEnd,
    stripeCustomerId: ws.platformStripeCustomerId,
    hasActiveSubscription: Boolean(ws.platformStripeSubscriptionId),
  });
});

router.post("/platform/checkout", requireWorkspaceAdmin, async (req, res) => {
  try {
    const ws = (req as any).workspace as typeof workspacesTable.$inferSelect;
    const dbUser = (req as any).dbUser;

    const planId = req.body?.planId as PlanId;
    if (planId !== "basic" && planId !== "professional" && planId !== "agency") {
      return res.status(400).json({ error: "Invalid plan" });
    }
    const intervalRaw = req.body?.interval as string | undefined;
    const interval: BillingInterval = intervalRaw === "year" ? "year" : "month";

    const session = await createPlatformCheckoutSession({
      workspaceId: ws.id,
      workspaceSlug: ws.slug,
      planId,
      interval,
      customerEmail: dbUser?.email,
      existingStripeCustomerId: ws.platformStripeCustomerId,
      successUrl: `${APP_BASE_URL}/${ws.slug}/admin/settings?tab=billing&billing=success`,
      cancelUrl: `${APP_BASE_URL}/${ws.slug}/admin/settings?tab=billing&billing=cancelled`,
    });

    return res.json({ url: session.url });
  } catch (err: any) {
    if (err instanceof PlatformStripeConfigError) {
      req.log.warn({ err: err.message }, "Platform Stripe not configured");
      return res.status(503).json({ error: "Billing is not configured. Please contact support." });
    }
    req.log.error({ err }, "Error creating platform checkout session");
    return res.status(500).json({ error: "Could not start checkout" });
  }
});

router.post("/platform/portal", requireWorkspaceAdmin, async (req, res) => {
  try {
    const ws = (req as any).workspace as typeof workspacesTable.$inferSelect;
    if (!ws.platformStripeCustomerId) {
      return res.status(400).json({ error: "No active subscription to manage" });
    }

    const session = await createBillingPortalSession(
      ws.platformStripeCustomerId,
      `${APP_BASE_URL}/${ws.slug}/admin/settings?tab=billing`,
    );
    return res.json({ url: session.url });
  } catch (err: any) {
    if (err instanceof PlatformStripeConfigError) {
      return res.status(503).json({ error: "Billing is not configured." });
    }
    req.log.error({ err }, "Error creating billing portal session");
    return res.status(500).json({ error: "Could not open portal" });
  }
});

export default router;
