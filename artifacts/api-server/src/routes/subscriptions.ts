import { Router } from "express";
import { db, subscriptionsTable, usersTable, retainerPackagesTable, workspacesTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { requireWorkspaceAdmin, loadPortalWorkspace, loadDbUser, resolvePortalIdentity } from "../lib/auth";
import { getCurrentUsage } from "../lib/plan-guards";
import { getPlan, isWithinLimit } from "@workspace/db";
import {
  CreateSubscriptionBody,
  ListSubscriptionsQueryParams,
  GetSubscriptionParams,
  UpdateSubscriptionParams,
  UpdateSubscriptionBody,
  TopUpSubscriptionBody,
} from "@workspace/api-zod";

const router = Router();

function formatSubscriptionRecord(sub: any, customer?: any, pkg?: any) {
  const remaining = Math.max(0, sub.totalMinutes - sub.usedMinutes);
  const threshold = sub.lowBalanceThresholdMinutes ?? 60;
  const isLowBalance = sub.totalMinutes < 999999 && remaining < threshold;
  return {
    id: sub.id,
    customerId: sub.customerId,
    packageId: sub.packageId,
    status: sub.status,
    totalMinutes: sub.totalMinutes,
    usedMinutes: sub.usedMinutes,
    remainingMinutes: remaining,
    startDate: sub.startDate,
    endDate: sub.endDate,
    createdAt: sub.createdAt,
    rolloverHours: sub.rolloverHours,
    billingCycleDay: sub.billingCycleDay,
    minimumMinutesPerRequest: sub.minimumMinutesPerRequest,
    hourlyRate: sub.hourlyRate != null ? Number(sub.hourlyRate) : null,
    currency: sub.currency ?? "USD",
    lowBalanceThresholdMinutes: threshold,
    isLowBalance,
    customer: customer
      ? { id: customer.id, clerkUserId: customer.clerkUserId, email: customer.email, name: customer.name, role: customer.role, paymentMethod: customer.paymentMethod ?? null, createdAt: customer.createdAt }
      : undefined,
    package: pkg
      ? { id: pkg.id, name: pkg.name, description: pkg.description, type: pkg.type, price: Number(pkg.price), currency: pkg.currency, totalHours: pkg.totalHours, totalMinutes: pkg.totalMinutes, isActive: pkg.isActive, createdAt: pkg.createdAt }
      : undefined,
  };
}

async function formatSubscription(sub: any) {
  const [customer] = await db.select().from(usersTable).where(eq(usersTable.id, sub.customerId));
  const [pkg] = await db.select().from(retainerPackagesTable).where(eq(retainerPackagesTable.id, sub.packageId));
  return formatSubscriptionRecord(sub, customer, pkg);
}

// GET /subscriptions (workspace-scoped)
router.get("/subscriptions", loadPortalWorkspace, loadDbUser, async (req, res) => {
  try {
    const dbUser = (req as any).dbUser;
    const workspace = (req as any).workspace;
    const query = ListSubscriptionsQueryParams.safeParse(req.query);
    const params = query.success ? query.data : {};

    let subs;
    if (dbUser.role === "admin" || dbUser.role === "owner") {
      if (workspace.ownerId !== dbUser.id && dbUser.role !== "owner") return res.status(403).json({ error: "Forbidden" });
      if (params.customerId) {
        subs = await db.select().from(subscriptionsTable).where(
          and(eq(subscriptionsTable.customerId, params.customerId), eq(subscriptionsTable.workspaceId, workspace.id))
        );
      } else {
        subs = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.workspaceId, workspace.id));
      }
    } else {
      // Portal user (primary or secondary). Resolve to effective customer.
      // Anyone with portal access (requests OR retainers) can see the list of
      // subscriptions for their effective customer so they can pick which one
      // to file a request against. Sensitive details remain in the row but
      // the rich balance UI is gated separately on the client.
      const identity = await resolvePortalIdentity(dbUser, workspace.id);
      if (identity.kind === "none" || identity.effectiveCustomerId === null) {
        return res.status(403).json({ error: "No portal access" });
      }
      if (!identity.canAccessRequests && !identity.canAccessRetainers) {
        return res.status(403).json({ error: "No portal access" });
      }
      subs = await db.select().from(subscriptionsTable).where(
        and(eq(subscriptionsTable.customerId, identity.effectiveCustomerId), eq(subscriptionsTable.workspaceId, workspace.id))
      );
    }

    if (params.status) {
      subs = subs.filter(s => s.status === params.status);
    }

    const formatted = await Promise.all(subs.map(formatSubscription));
    return res.json(formatted);
  } catch (err) {
    req.log.error({ err }, "Error listing subscriptions");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /subscriptions (admin only, workspace-scoped)
router.post("/subscriptions", requireWorkspaceAdmin, async (req, res) => {
  try {
    const dbUser = (req as any).dbUser;
    const workspace = (req as any).workspace;
    const body = CreateSubscriptionBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const customerId = body.data.customerId ?? dbUser.id;

    // Plan-limit check on `clients` only counts an additional client when
    // this customer doesn't already have a subscription in the workspace.
    const plan = getPlan(workspace.plan);
    const clientsLimit = plan.limits.clients;
    if (clientsLimit !== null) {
      const [existing] = await db.select({ id: subscriptionsTable.id })
        .from(subscriptionsTable)
        .where(and(eq(subscriptionsTable.workspaceId, workspace.id), eq(subscriptionsTable.customerId, customerId)))
        .limit(1);
      if (!existing) {
        const current = await getCurrentUsage(workspace.id, "clients");
        if (!isWithinLimit(clientsLimit, current)) {
          return res.status(402).json({
            error: `Your ${plan.name} plan is limited to ${clientsLimit} clients.`,
            currentPlan: plan.id,
            requiredPlan: plan.id === "free" ? "professional" : "agency",
            resource: "clients",
            limit: clientsLimit,
            current,
          });
        }
      }
    }

    const [pkg] = await db.select().from(retainerPackagesTable).where(eq(retainerPackagesTable.id, body.data.packageId));
    if (!pkg) return res.status(404).json({ error: "Package not found" });
    if (pkg.workspaceId != null && pkg.workspaceId !== workspace.id) {
      return res.status(404).json({ error: "Package not found" });
    }

    if (body.data.rolloverHours === true && pkg.type !== "ongoing") {
      return res.status(422).json({ error: "Rollover hours can only be enabled on ongoing retainers." });
    }

    const totalMinutes = pkg.type === "unlimited" ? 999999 : (pkg.totalHours * 60) + pkg.totalMinutes;

    const [sub] = await db.insert(subscriptionsTable).values({
      workspaceId: workspace.id,
      customerId,
      packageId: body.data.packageId,
      status: "active",
      totalMinutes,
      usedMinutes: 0,
      rolloverHours: body.data.rolloverHours ?? false,
      billingCycleDay: body.data.billingCycleDay ?? null,
      minimumMinutesPerRequest: body.data.minimumMinutesPerRequest ?? 0,
      hourlyRate: (pkg.type === "bundle" || pkg.type === "credits") ? null : (body.data.hourlyRate != null ? String(body.data.hourlyRate) : null),
      currency: body.data.currency ?? pkg.currency ?? "USD",
      lowBalanceThresholdMinutes: body.data.lowBalanceThresholdMinutes ?? 60,
    }).returning();

    return res.status(201).json(await formatSubscription(sub));
  } catch (err) {
    req.log.error({ err }, "Error creating subscription");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /subscriptions/:id
router.get("/subscriptions/:id", loadPortalWorkspace, loadDbUser, async (req, res) => {
  try {
    const params = GetSubscriptionParams.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid params" });

    const dbUser = (req as any).dbUser;
    const workspace = (req as any).workspace;
    const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, params.data.id));
    if (!sub) return res.status(404).json({ error: "Subscription not found" });
    if (sub.workspaceId !== workspace.id) return res.status(404).json({ error: "Subscription not found" });

    if (dbUser.role !== "admin" && dbUser.role !== "owner") {
      const identity = await resolvePortalIdentity(dbUser, workspace.id);
      if (identity.kind === "none" || !identity.canAccessRetainers || sub.customerId !== identity.effectiveCustomerId) {
        return res.status(403).json({ error: "Forbidden" });
      }
    } else if (workspace.ownerId !== dbUser.id && dbUser.role !== "owner") {
      return res.status(403).json({ error: "Forbidden" });
    }

    return res.json(await formatSubscription(sub));
  } catch (err) {
    req.log.error({ err }, "Error getting subscription");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /subscriptions/:id (admin/owner only, workspace-scoped)
router.patch("/subscriptions/:id", requireWorkspaceAdmin, async (req, res) => {
  try {
    const params = UpdateSubscriptionParams.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid params" });

    const body = UpdateSubscriptionBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const workspace = (req as any).workspace;

    // Verify the subscription belongs to the active workspace.
    const [existing] = await db.select().from(subscriptionsTable).where(
      and(eq(subscriptionsTable.id, params.data.id), eq(subscriptionsTable.workspaceId, workspace.id))
    );
    if (!existing) return res.status(404).json({ error: "Subscription not found" });

    const [existingPkg] = await db.select().from(retainerPackagesTable).where(eq(retainerPackagesTable.id, existing.packageId));

    // Rollover is only allowed on ongoing packages.
    if (body.data.rolloverHours === true) {
      if (!existingPkg || existingPkg.type !== "ongoing") {
        return res.status(422).json({ error: "Rollover hours can only be enabled on ongoing retainers." });
      }
    }

    const updateData: any = {};
    if (body.data.status !== undefined) updateData.status = body.data.status;
    if (body.data.endDate !== undefined) updateData.endDate = body.data.endDate;
    if (body.data.rolloverHours !== undefined) updateData.rolloverHours = body.data.rolloverHours;
    if (body.data.billingCycleDay !== undefined) updateData.billingCycleDay = body.data.billingCycleDay;
    if (body.data.minimumMinutesPerRequest !== undefined) updateData.minimumMinutesPerRequest = body.data.minimumMinutesPerRequest;
    const isFixedPricePkg = existingPkg?.type === "bundle" || existingPkg?.type === "credits";
    if (body.data.hourlyRate !== undefined) {
      updateData.hourlyRate = isFixedPricePkg
        ? null
        : (body.data.hourlyRate != null ? String(body.data.hourlyRate) : null);
    } else if (isFixedPricePkg && existing.hourlyRate != null) {
      updateData.hourlyRate = null;
    }
    if (body.data.currency !== undefined) updateData.currency = body.data.currency;
    if (body.data.lowBalanceThresholdMinutes !== undefined) updateData.lowBalanceThresholdMinutes = body.data.lowBalanceThresholdMinutes;
    if (body.data.totalMinutes !== undefined) updateData.totalMinutes = body.data.totalMinutes;
    if (body.data.usedMinutes !== undefined) {
      const cap = body.data.totalMinutes !== undefined ? body.data.totalMinutes : existing.totalMinutes;
      updateData.usedMinutes = Math.max(0, Math.min(cap, body.data.usedMinutes));
    }

    const [updated] = await db.update(subscriptionsTable)
      .set(updateData)
      .where(and(eq(subscriptionsTable.id, params.data.id), eq(subscriptionsTable.workspaceId, workspace.id)))
      .returning();

    if (!updated) return res.status(404).json({ error: "Subscription not found" });
    return res.json(await formatSubscription(updated));
  } catch (err) {
    req.log.error({ err }, "Error updating subscription");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /subscriptions/:id/reset-hours (admin only, workspace-scoped)
router.post("/subscriptions/:id/reset-hours", requireWorkspaceAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const workspace = (req as any).workspace;
    const [sub] = await db.select().from(subscriptionsTable).where(
      and(eq(subscriptionsTable.id, id), eq(subscriptionsTable.workspaceId, workspace.id))
    );
    if (!sub) return res.status(404).json({ error: "Subscription not found" });

    // Get the package to determine totalMinutes for reset
    const [pkg] = await db.select().from(retainerPackagesTable).where(eq(retainerPackagesTable.id, sub.packageId));
    const packageMinutes = pkg ? (pkg.type === "unlimited" ? 999999 : (pkg.totalHours * 60) + pkg.totalMinutes) : sub.totalMinutes;

    let newUsedMinutes = 0;
    let newTotalMinutes = packageMinutes;

    if (sub.rolloverHours) {
      // Rollover: carry over unused minutes by adding to new cycle's total
      const remaining = Math.max(0, sub.totalMinutes - sub.usedMinutes);
      newTotalMinutes = packageMinutes + remaining;
      newUsedMinutes = 0;
    }

    const [updated] = await db.update(subscriptionsTable)
      .set({ usedMinutes: newUsedMinutes, totalMinutes: newTotalMinutes })
      .where(and(eq(subscriptionsTable.id, id), eq(subscriptionsTable.workspaceId, workspace.id)))
      .returning();

    return res.json(await formatSubscription(updated));
  } catch (err) {
    req.log.error({ err }, "Error resetting subscription hours");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /subscriptions/:id/top-up - customer purchases additional hours on a prepaid subscription
router.post("/subscriptions/:id/top-up", loadPortalWorkspace, loadDbUser, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const body = TopUpSubscriptionBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const dbUser = (req as any).dbUser;
    const workspace = (req as any).workspace;

    const [sub] = await db.select().from(subscriptionsTable).where(
      and(eq(subscriptionsTable.id, id), eq(subscriptionsTable.workspaceId, workspace.id))
    );
    if (!sub) return res.status(404).json({ error: "Subscription not found" });

    // Authorization: portal user (primary or secondary with retainer perm) can top up the customer they represent;
    // admins/owners of the workspace can top up any sub in the workspace
    const isWorkspaceOwner = workspace.ownerId === dbUser.id;
    const isAdmin = dbUser.role === "admin" || dbUser.role === "owner";
    let isOwnCustomer = false;
    if (!isAdmin) {
      const identity = await resolvePortalIdentity(dbUser, workspace.id);
      isOwnCustomer = identity.kind !== "none"
        && identity.canAccessRetainers
        && identity.effectiveCustomerId !== null
        && sub.customerId === identity.effectiveCustomerId;
    }
    if (!isOwnCustomer && !isWorkspaceOwner && !isAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const [pkg] = await db.select().from(retainerPackagesTable).where(eq(retainerPackagesTable.id, sub.packageId));
    if (!pkg) return res.status(400).json({ error: "Retainer package not found" });
    if (pkg.type === "unlimited") {
      return res.status(400).json({ error: "Top-ups don't apply to unlimited retainers" });
    }
    if (pkg.type === "bundle") {
      return res.status(400).json({ error: "Bundles are fixed-price retainers and can't be topped up" });
    }
    if (pkg.type === "credits") {
      return res.status(400).json({ error: "Credit retainers can't be topped up — issue a new credits retainer instead" });
    }
    // Customers can only top up prepaid plans themselves; admins/owners may top up prepaid or ongoing
    if (isOwnCustomer && pkg.type !== "prepaid") {
      return res.status(400).json({ error: "Top-ups are only available on prepaid retainers" });
    }

    if (sub.status !== "active") {
      return res.status(400).json({ error: "Only active subscriptions can be topped up" });
    }

    // Atomic increment to avoid lost updates under concurrent top-ups
    const [updated] = await db.update(subscriptionsTable)
      .set({ totalMinutes: sql`${subscriptionsTable.totalMinutes} + ${body.data.minutes}` })
      .where(and(eq(subscriptionsTable.id, id), eq(subscriptionsTable.workspaceId, workspace.id)))
      .returning();

    return res.json(await formatSubscription(updated));
  } catch (err) {
    req.log.error({ err }, "Error topping up subscription");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export { formatSubscription, formatSubscriptionRecord };
export default router;
