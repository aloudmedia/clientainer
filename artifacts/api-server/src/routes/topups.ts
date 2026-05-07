import { Router } from "express";
import { db, topupsTable, topupBundlesTable, subscriptionsTable, workspacesTable, retainerPackagesTable } from "@workspace/db";
import { eq, and, inArray, isNotNull } from "drizzle-orm";
import { loadDbUser, loadPortalWorkspace } from "../lib/auth";
import { CreateTopupBody, PurchasePackageBody } from "@workspace/api-zod";
import { createBillingRequest, createBillingRequestFlow, GoCardlessError, type GcEnv } from "../lib/gocardless";
import { createCheckoutSession, StripeConfigError } from "../lib/stripe";

const router = Router();

function formatTopup(t: any) {
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    customerId: t.customerId,
    subscriptionId: t.subscriptionId,
    bundleId: t.bundleId ?? null,
    status: t.status,
    processor: t.processor,
    hoursToCredit: t.hoursToCredit,
    amount: Number(t.amount),
    currency: t.currency,
    redirectUrl: t.redirectUrl ?? null,
    completedAt: t.completedAt ?? null,
    createdAt: t.createdAt,
  };
}

/**
 * Validate the customer-supplied returnUrl. We require:
 *  - Same host as the incoming request (or the public host from REPLIT_DOMAINS).
 *  - HTTPS in production, HTTP/HTTPS in development.
 *  - Path equal to `/${workspace.slug}/topup-complete` (no trailing extras, no fragment).
 * Anything else is rejected to prevent open-redirect abuse via GoCardless or Stripe.
 */
function validateReturnUrl(rawUrl: string, req: any, workspaceSlug: string): URL | null {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return null; }

  if (parsed.hash || parsed.username || parsed.password) return null;

  const allowedHosts = new Set<string>();
  const replitDomains = process.env.REPLIT_DOMAINS;
  if (replitDomains) {
    for (const d of replitDomains.split(",")) {
      const trimmed = d.trim().toLowerCase();
      if (trimmed) allowedHosts.add(trimmed);
    }
  }
  if (process.env.NODE_ENV !== "production") {
    const reqHost = req.headers.host;
    if (reqHost) allowedHosts.add(String(reqHost).toLowerCase());
    allowedHosts.add("localhost");
    allowedHosts.add("127.0.0.1");
  }

  if (allowedHosts.size === 0) return null;
  if (!allowedHosts.has(parsed.host.toLowerCase())) return null;

  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") return null;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const expected = `/${workspaceSlug}/topup-complete`;
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  if (pathname !== expected) return null;

  return parsed;
}

// POST /topups (customer initiates a top-up)
router.post("/topups", loadPortalWorkspace, loadDbUser, async (req, res) => {
  let pendingTopupId: number | null = null;
  try {
    const dbUser = (req as any).dbUser;
    const workspace = (req as any).workspace;

    const body = CreateTopupBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const processor = workspace.paymentProcessor as "stripe" | "gocardless";
    if (processor === "gocardless" && !workspace.gocardlessAccessToken) {
      return res.status(422).json({ error: "This workspace has not connected GoCardless yet." });
    }
    if (processor === "stripe" && !workspace.stripeSecretKey) {
      return res.status(422).json({ error: "This workspace has not connected Stripe yet." });
    }

    const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, body.data.subscriptionId));
    if (!sub || sub.workspaceId !== workspace.id) {
      return res.status(404).json({ error: "Subscription not found" });
    }
    if (sub.customerId !== dbUser.id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const [pkg] = await db.select().from(retainerPackagesTable).where(eq(retainerPackagesTable.id, sub.packageId));
    if (pkg?.type === "bundle" || pkg?.type === "credits") {
      return res.status(400).json({ error: "Fixed-price retainers (Bundle or Credits) cannot be topped up." });
    }

    const [bundle] = await db.select().from(topupBundlesTable).where(eq(topupBundlesTable.id, body.data.bundleId));
    if (!bundle || bundle.workspaceId !== workspace.id || bundle.packageId !== sub.packageId || !bundle.isActive) {
      return res.status(404).json({ error: "Bundle not found for this retainer" });
    }

    const validatedReturn = validateReturnUrl(body.data.returnUrl, req, workspace.slug);
    if (!validatedReturn) {
      return res.status(400).json({ error: "Invalid returnUrl" });
    }

    const amountMajor = Number(bundle.price);
    const amountMinor = Math.round(amountMajor * 100);

    // 1. Persist a pending topup so we have an id to embed in the return URL
    const [pendingTopup] = await db.insert(topupsTable).values({
      workspaceId: workspace.id,
      customerId: dbUser.id,
      subscriptionId: sub.id,
      bundleId: bundle.id,
      status: "pending",
      processor,
      hoursToCredit: bundle.hours,
      amount: String(amountMajor),
      currency: bundle.currency,
    }).returning();
    pendingTopupId = pendingTopup.id;

    // 2. Build the return URL with the topup id appended (validated above).
    const sep = validatedReturn.search ? "&" : "?";
    const returnUrlWithId = `${validatedReturn.toString()}${sep}topupId=${pendingTopup.id}`;

    let redirectUrl: string;

    if (processor === "stripe") {
      // ── Stripe Checkout flow ───────────────────────────────────────────
      const session = await createCheckoutSession(workspace.stripeSecretKey, {
        amountMinor,
        currency: bundle.currency,
        productName: `Top-up: ${bundle.name}`,
        productDescription: `+${bundle.hours}h to your retainer`,
        successUrl: returnUrlWithId,
        cancelUrl: returnUrlWithId,
        customerEmail: dbUser.email ?? undefined,
        metadata: {
          workspaceId: String(workspace.id),
          subscriptionId: String(sub.id),
          bundleId: String(bundle.id),
          topupId: String(pendingTopup.id),
        },
        idempotencyKey: `topup-stripe-ws${workspace.id}-sub${sub.id}-bun${bundle.id}-t${pendingTopup.id}`,
      });

      if (!session.url) {
        throw new Error("Stripe Checkout did not return a redirect URL");
      }
      redirectUrl = session.url;

      const [topup] = await db.update(topupsTable)
        .set({
          status: "submitted",
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId: typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id ?? null,
          redirectUrl,
        })
        .where(eq(topupsTable.id, pendingTopup.id))
        .returning();

      return res.status(201).json({
        topupId: topup.id,
        redirectUrl,
      });
    }

    // ── GoCardless flow ───────────────────────────────────────────────────
    const env = (workspace.gocardlessEnvironment ?? "sandbox") as GcEnv;

    const billingRequest = await createBillingRequest(
      workspace.gocardlessAccessToken,
      env,
      {
        amount: amountMinor,
        currency: bundle.currency,
        description: `Top-up: ${bundle.name} (+${bundle.hours}h)`,
        metadata: {
          workspaceId: String(workspace.id),
          subscriptionId: String(sub.id),
          bundleId: String(bundle.id),
          topupId: String(pendingTopup.id),
        },
      },
      `topup-br-ws${workspace.id}-sub${sub.id}-bun${bundle.id}-t${pendingTopup.id}`,
    );

    await db.update(topupsTable)
      .set({ gcBillingRequestId: billingRequest.id })
      .where(eq(topupsTable.id, pendingTopup.id));

    const flow = await createBillingRequestFlow(
      workspace.gocardlessAccessToken,
      env,
      {
        billingRequestId: billingRequest.id,
        redirectUri: returnUrlWithId,
        exitUri: returnUrlWithId,
        prefilledCustomer: {
          email: dbUser.email,
          given_name: dbUser.name?.split(" ")[0],
          family_name: dbUser.name?.split(" ").slice(1).join(" ") || undefined,
        },
      },
    );

    redirectUrl = flow.authorisation_url;

    const [topup] = await db.update(topupsTable)
      .set({
        status: "submitted",
        gcBillingRequestFlowId: flow.id,
        redirectUrl,
      })
      .where(eq(topupsTable.id, pendingTopup.id))
      .returning();

    return res.status(201).json({
      topupId: topup.id,
      redirectUrl,
    });
  } catch (err) {
    if (pendingTopupId != null) {
      try {
        await db.update(topupsTable)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(topupsTable.id, pendingTopupId));
      } catch (cleanupErr) {
        req.log.error({ cleanupErr, pendingTopupId }, "Failed to mark orphaned topup as failed");
      }
    }
    if (err instanceof GoCardlessError) {
      req.log.error({ err: err.message, status: err.status, body: err.body }, "GoCardless error creating topup");
      return res.status(502).json({ error: `GoCardless: ${err.message}` });
    }
    if (err instanceof StripeConfigError) {
      return res.status(422).json({ error: err.message });
    }
    if ((err as any)?.type?.startsWith?.("Stripe")) {
      const e = err as any;
      req.log.error({ err: e.message, type: e.type, code: e.code }, "Stripe error creating topup");
      return res.status(502).json({ error: `Stripe: ${e.message}` });
    }
    req.log.error({ err }, "Error creating topup");
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /portal/package-purchase — customer purchases a different package and
 * the active subscription is switched to it on confirmation.
 *
 * Mirrors POST /topups (same validations, same Stripe Checkout pattern, same
 * topupsTable record + return URL contract) but with `switchToPackageId` set,
 * which the webhook uses to swap packages atomically instead of crediting
 * extra hours. GoCardless is intentionally not supported here — switching
 * plans needs the synchronous payment confirmation that Stripe Checkout gives
 * us; deferred bank-debit confirmation would leave the customer in limbo.
 */
router.post("/portal/package-purchase", loadPortalWorkspace, loadDbUser, async (req, res) => {
  let pendingTopupId: number | null = null;
  try {
    const dbUser = (req as any).dbUser;
    const workspace = (req as any).workspace;

    const body = PurchasePackageBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    if (workspace.paymentProcessor !== "stripe") {
      return res.status(422).json({ error: "Plan switching is only available for Stripe-connected workspaces." });
    }
    if (!workspace.stripeSecretKey) {
      return res.status(422).json({ error: "This workspace has not connected Stripe yet." });
    }

    // Customer must already have an active subscription to switch FROM.
    const [currentSub] = await db.select().from(subscriptionsTable).where(
      and(
        eq(subscriptionsTable.customerId, dbUser.id),
        eq(subscriptionsTable.workspaceId, workspace.id),
        eq(subscriptionsTable.status, "active"),
      ),
    );
    if (!currentSub) {
      return res.status(409).json({ error: "You need an active retainer before you can switch to another." });
    }

    // Validate the target package belongs to this workspace, is active, has a price.
    const [newPkg] = await db.select().from(retainerPackagesTable).where(eq(retainerPackagesTable.id, body.data.packageId));
    if (!newPkg || newPkg.workspaceId !== workspace.id || !newPkg.isActive) {
      return res.status(404).json({ error: "Package not found" });
    }
    if (newPkg.id === currentSub.packageId) {
      return res.status(409).json({ error: "You are already on this retainer." });
    }
    const priceMajor = Number(newPkg.price);
    if (!Number.isFinite(priceMajor) || priceMajor <= 0) {
      return res.status(422).json({ error: "This retainer cannot be self-purchased — please contact your account manager." });
    }

    // Enforce eligibility: target must be a sibling in the same retainer group
    // as the customer's current package. This matches what the portal UI shows
    // and prevents tampering the request body to switch to an arbitrary
    // workspace package (e.g., a different client's bespoke retainer).
    const [currentPkg] = await db.select().from(retainerPackagesTable).where(eq(retainerPackagesTable.id, currentSub.packageId));
    if (!currentPkg || currentPkg.groupId == null || newPkg.groupId !== currentPkg.groupId) {
      return res.status(403).json({ error: "This retainer isn't available for self-switch from your current plan." });
    }

    // Block concurrent in-flight switch purchases for this subscription so two
    // overlapping checkouts can't both confirm and stomp on each other.
    const existing = await db.select({ id: topupsTable.id }).from(topupsTable).where(and(
      eq(topupsTable.subscriptionId, currentSub.id),
      isNotNull(topupsTable.switchToPackageId),
      inArray(topupsTable.status, ["pending", "submitted"]),
    )).limit(1);
    if (existing.length > 0) {
      return res.status(409).json({ error: "You already have a retainer switch in progress. Please complete or cancel it before starting another." });
    }

    const validatedReturn = validateReturnUrl(body.data.returnUrl, req, workspace.slug);
    if (!validatedReturn) {
      return res.status(400).json({ error: "Invalid returnUrl" });
    }

    const amountMinor = Math.round(priceMajor * 100);
    const newPackageMinutes = (newPkg.totalHours ?? 0) * 60 + (newPkg.totalMinutes ?? 0);

    const [pendingTopup] = await db.insert(topupsTable).values({
      workspaceId: workspace.id,
      customerId: dbUser.id,
      subscriptionId: currentSub.id,
      switchToPackageId: newPkg.id,
      status: "pending",
      processor: "stripe",
      // Always 0 for switch purchases. The webhook's switch branch reads
      // package allocation directly from the new package, and 0 is a safe
      // fall-through value if `switchToPackageId` somehow becomes NULL (FK
      // set-null on package delete) — we'd rather credit nothing than credit
      // the new package's hours to the old plan.
      hoursToCredit: 0,
      amount: String(priceMajor),
      currency: newPkg.currency,
    }).returning();
    pendingTopupId = pendingTopup.id;

    const sep = validatedReturn.search ? "&" : "?";
    const returnUrlWithId = `${validatedReturn.toString()}${sep}topupId=${pendingTopup.id}`;

    const session = await createCheckoutSession(workspace.stripeSecretKey, {
      amountMinor,
      currency: newPkg.currency,
      productName: `Switch to ${newPkg.name}`,
      productDescription: newPkg.description ?? `Switch your retainer to ${newPkg.name}`,
      successUrl: returnUrlWithId,
      cancelUrl: returnUrlWithId,
      customerEmail: dbUser.email ?? undefined,
      metadata: {
        workspaceId: String(workspace.id),
        subscriptionId: String(currentSub.id),
        switchToPackageId: String(newPkg.id),
        topupId: String(pendingTopup.id),
      },
      idempotencyKey: `switch-stripe-ws${workspace.id}-sub${currentSub.id}-pkg${newPkg.id}-t${pendingTopup.id}`,
    });

    if (!session.url) throw new Error("Stripe Checkout did not return a redirect URL");

    const [topup] = await db.update(topupsTable)
      .set({
        status: "submitted",
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id ?? null,
        redirectUrl: session.url,
      })
      .where(eq(topupsTable.id, pendingTopup.id))
      .returning();

    return res.status(201).json({ topupId: topup.id, redirectUrl: session.url });
  } catch (err) {
    if (pendingTopupId != null) {
      try {
        await db.update(topupsTable)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(topupsTable.id, pendingTopupId));
      } catch (cleanupErr) {
        req.log.error({ cleanupErr, pendingTopupId }, "Failed to mark orphaned switch-purchase as failed");
      }
    }
    if (err instanceof StripeConfigError) {
      return res.status(422).json({ error: err.message });
    }
    if ((err as any)?.type?.startsWith?.("Stripe")) {
      const e = err as any;
      req.log.error({ err: e.message, type: e.type, code: e.code }, "Stripe error creating package-purchase");
      return res.status(502).json({ error: `Stripe: ${e.message}` });
    }
    req.log.error({ err }, "Error creating package-purchase");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /topups/:id
router.get("/topups/:id", loadDbUser, async (req, res) => {
  try {
    const dbUser = (req as any).dbUser;
    const id = parseInt(req.params.id as string, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const [topup] = await db.select().from(topupsTable).where(eq(topupsTable.id, id));
    if (!topup) return res.status(404).json({ error: "Top-up not found" });

    const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.id, topup.workspaceId));
    const isOwner = workspace?.ownerId === dbUser.id;
    const isCustomer = topup.customerId === dbUser.id;
    if (!isOwner && !isCustomer) return res.status(403).json({ error: "Forbidden" });

    return res.json(formatTopup(topup));
  } catch (err) {
    req.log.error({ err }, "Error fetching topup");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
