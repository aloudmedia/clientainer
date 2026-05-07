import { Router } from "express";
import { db, workspacesTable, styleSettingsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin, loadDbUser, requireOwner } from "../lib/auth";
import { getCurrentUsage } from "../lib/plan-guards";
import { PLANS } from "@workspace/db";
import { CreateWorkspaceBody, UpdateWorkspaceBody } from "@workspace/api-zod";

const router = Router();

function formatWorkspace(ws: any) {
  return {
    id: ws.id,
    slug: ws.slug,
    name: ws.name,
    ownerId: ws.ownerId,
    plan: ws.plan,
    platformSubscriptionStatus: ws.platformSubscriptionStatus ?? null,
    platformCurrentPeriodEnd: ws.platformCurrentPeriodEnd ?? null,
    hasActivePlatformSubscription: Boolean(ws.platformStripeSubscriptionId),
    paymentProcessor: ws.paymentProcessor ?? "stripe",
    gocardlessConnected: Boolean(ws.gocardlessAccessToken),
    stripeConnected: Boolean(ws.stripeSecretKey),
    createdAt: ws.createdAt,
  };
}

// POST /workspaces — any authenticated user can create their first workspace.
// Customers who do so are atomically promoted to "admin" (they're now running
// their own agency). Owner role can only be assigned manually by another owner.
router.post("/workspaces", loadDbUser, async (req, res) => {
  try {
    const dbUser = (req as any).dbUser;
    const body = CreateWorkspaceBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const slug = body.data.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-");

    const [existing] = await db.select().from(workspacesTable).where(eq(workspacesTable.ownerId, dbUser.id));
    if (existing) return res.status(409).json({ error: "You already have a workspace" });

    const [slugTaken] = await db.select().from(workspacesTable).where(eq(workspacesTable.slug, slug));
    if (slugTaken) return res.status(409).json({ error: "That URL slug is already taken" });

    const [workspace] = await db.insert(workspacesTable).values({
      slug,
      name: body.data.name,
      ownerId: dbUser.id,
      plan: (body.data.plan as any) ?? "free",
      // paymentProcessor defaults to "stripe" via the DB column default.
    }).returning();

    await db.insert(styleSettingsTable).values({
      workspaceId: workspace.id,
      companyName: body.data.name,
    });

    // Promote the user to admin if they were a customer — they're now running an agency.
    // Never demote an "owner" (platform superadmin).
    if (dbUser.role === "customer") {
      await db.update(usersTable)
        .set({ role: "admin" })
        .where(eq(usersTable.id, dbUser.id));
    }

    return res.status(201).json(formatWorkspace(workspace));
  } catch (err) {
    req.log.error({ err }, "Error creating workspace");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workspaces/me — any authenticated user can ask whether they own a workspace.
// 404 (not 403) on "no workspace" so the onboarding flow can branch on it.
router.get("/workspaces/me", loadDbUser, async (req, res) => {
  try {
    const dbUser = (req as any).dbUser;
    const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.ownerId, dbUser.id));
    if (!workspace) return res.status(404).json({ error: "No workspace found" });
    return res.json(formatWorkspace(workspace));
  } catch (err) {
    req.log.error({ err }, "Error getting workspace");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /workspaces/:slug — currently only payment processor selection.
router.patch("/workspaces/:slug", requireAdmin, async (req, res) => {
  try {
    const slug = (req.params.slug as string).toLowerCase();
    const dbUser = (req as any).dbUser;

    const body = UpdateWorkspaceBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.slug, slug));
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    if (workspace.ownerId !== dbUser.id) return res.status(403).json({ error: "You do not own this workspace" });

    const updateData: any = {};
    if (body.data.paymentProcessor !== undefined) {
      updateData.paymentProcessor = body.data.paymentProcessor;
    }
    if (Object.keys(updateData).length === 0) {
      return res.json(formatWorkspace(workspace));
    }

    const [updated] = await db.update(workspacesTable)
      .set(updateData)
      .where(eq(workspacesTable.id, workspace.id))
      .returning();

    return res.json(formatWorkspace(updated));
  } catch (err) {
    req.log.error({ err }, "Error updating workspace");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workspaces/:slug (public)
router.get("/workspaces/:slug", async (req, res) => {
  try {
    const slug = (req.params.slug as string).toLowerCase();
    const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.slug, slug));
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const [style] = await db.select().from(styleSettingsTable)
      .where(eq(styleSettingsTable.workspaceId, workspace.id));

    return res.json({
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      companyName: style?.companyName ?? workspace.name,
      logoUrl: style?.logoUrl ?? null,
      primaryColor: style?.primaryColor ?? "#6366f1",
      accentColor: style?.accentColor ?? "#8b5cf6",
      fontFamily: style?.fontFamily ?? "Inter",
      welcomeMessage: style?.welcomeMessage ?? null,
      supportEmail: style?.supportEmail ?? null,
      paymentProcessor: workspace.paymentProcessor ?? "stripe",
      gocardlessConnected: Boolean(workspace.gocardlessAccessToken),
      stripeConnected: Boolean(workspace.stripeSecretKey),
    });
  } catch (err) {
    req.log.error({ err }, "Error getting workspace by slug");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /owner/workspaces/:slug/plan — manually set a workspace's plan (e.g. comp to Free, no Stripe).
// When setting to "free", we also clear the platform subscription fields so the comp is "clean".
router.post("/owner/workspaces/:slug/plan", requireOwner, async (req, res) => {
  try {
    const slug = (req.params.slug as string).toLowerCase();
    const planId = String(req.body?.plan ?? "");
    if (!(planId in PLANS)) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.slug, slug));
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const updates: any = { plan: planId };
    if (planId === "free") {
      // Detach the workspace from any prior Stripe subscription so the comp
      // is "clean" — no leftover customer/subscription/period bookkeeping.
      updates.platformSubscriptionStatus = null;
      updates.platformStripeSubscriptionId = null;
      updates.platformStripeCustomerId = null;
      updates.platformCurrentPeriodEnd = null;
    }

    const [updated] = await db.update(workspacesTable)
      .set(updates)
      .where(eq(workspacesTable.id, workspace.id))
      .returning();

    const [clients, retainers, requestsThisMonth] = await Promise.all([
      getCurrentUsage(updated.id, "clients"),
      getCurrentUsage(updated.id, "retainers"),
      getCurrentUsage(updated.id, "requests"),
    ]);
    const plan = PLANS[(updated.plan as keyof typeof PLANS)] ?? PLANS.free;
    const isPaid = updated.platformSubscriptionStatus === "active" || updated.platformSubscriptionStatus === "trialing";
    const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, updated.ownerId));

    return res.json({
      id: updated.id,
      slug: updated.slug,
      name: updated.name,
      plan: updated.plan,
      platformSubscriptionStatus: updated.platformSubscriptionStatus ?? null,
      platformCurrentPeriodEnd: updated.platformCurrentPeriodEnd ?? null,
      ownerEmail: owner?.email ?? null,
      usage: { clients, retainers, requestsThisMonth },
      mrrUsd: isPaid ? plan.priceUsd : 0,
      createdAt: updated.createdAt,
    });
  } catch (err) {
    req.log.error({ err }, "Error setting workspace plan");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /owner/workspaces — platform owner overview of every workspace's plan, status, usage.
router.get("/owner/workspaces", requireOwner, async (req, res) => {
  try {
    const allWorkspaces = await db.select().from(workspacesTable);
    const owners = await db.select().from(usersTable);
    const ownerById = new Map(owners.map(u => [u.id, u]));

    const rows = await Promise.all(allWorkspaces.map(async (ws) => {
      const [clients, retainers, requestsThisMonth] = await Promise.all([
        getCurrentUsage(ws.id, "clients"),
        getCurrentUsage(ws.id, "retainers"),
        getCurrentUsage(ws.id, "requests"),
      ]);
      const plan = PLANS[(ws.plan as keyof typeof PLANS)] ?? PLANS.free;
      const isPaid = ws.platformSubscriptionStatus === "active" || ws.platformSubscriptionStatus === "trialing";
      const owner = ownerById.get(ws.ownerId);
      return {
        id: ws.id,
        slug: ws.slug,
        name: ws.name,
        plan: ws.plan,
        platformSubscriptionStatus: ws.platformSubscriptionStatus ?? null,
        platformCurrentPeriodEnd: ws.platformCurrentPeriodEnd ?? null,
        ownerEmail: owner?.email ?? null,
        usage: { clients, retainers, requestsThisMonth },
        mrrUsd: isPaid ? plan.priceUsd : 0,
        createdAt: ws.createdAt,
      };
    }));

    return res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Error listing owner workspaces");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
