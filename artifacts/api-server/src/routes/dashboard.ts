import { Router } from "express";
import { db, requestsTable, subscriptionsTable, usersTable, retainerPackagesTable, formsTable, formAssignmentsTable } from "@workspace/db";
import { eq, desc, inArray, and } from "drizzle-orm";
import { loadDbUser, requireOwner, requireWorkspaceAdmin, loadPortalWorkspace, resolvePortalIdentity } from "../lib/auth";

const router = Router();

function formatRequestRecord(r: any, customer?: any) {
  const lastAt = r.lastMessageAt ? new Date(r.lastMessageAt).getTime() : null;
  const adminRead = r.adminLastReadAt ? new Date(r.adminLastReadAt).getTime() : null;
  const custRead = r.customerLastReadAt ? new Date(r.customerLastReadAt).getTime() : null;
  const unreadByAdmin = !!(lastAt && r.lastMessageByRole === "customer" && (!adminRead || adminRead < lastAt));
  const unreadByCustomer = !!(
    lastAt &&
    (r.lastMessageByRole === "admin" || r.lastMessageByRole === "owner") &&
    (!custRead || custRead < lastAt)
  );
  return {
    id: r.id,
    customerId: r.customerId,
    subscriptionId: r.subscriptionId,
    title: r.title,
    description: r.description,
    status: r.status,
    estimatedMinutes: r.estimatedMinutes,
    usedMinutes: r.usedMinutes,
    formSubmissionData: r.formSubmissionData ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastMessageAt: r.lastMessageAt ?? null,
    unreadByAdmin,
    unreadByCustomer,
    customer: customer
      ? { id: customer.id, clerkUserId: customer.clerkUserId, email: customer.email, name: customer.name, role: customer.role, createdAt: customer.createdAt }
      : undefined,
  };
}

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
    lowBalanceThresholdMinutes: threshold,
    isLowBalance,
    customer: customer
      ? { id: customer.id, clerkUserId: customer.clerkUserId, email: customer.email, name: customer.name, role: customer.role, createdAt: customer.createdAt }
      : undefined,
    package: pkg
      ? { id: pkg.id, name: pkg.name, description: pkg.description, type: pkg.type, price: Number(pkg.price), currency: pkg.currency, totalHours: pkg.totalHours, totalMinutes: pkg.totalMinutes, isActive: pkg.isActive, createdAt: pkg.createdAt }
      : undefined,
  };
}

// GET /dashboard/customer (workspace-scoped)
router.get("/dashboard/customer", loadPortalWorkspace, loadDbUser, async (req, res) => {
  try {
    const dbUser = (req as any).dbUser;
    const workspace = (req as any).workspace;
    const identity = await resolvePortalIdentity(dbUser, workspace.id);
    if (identity.kind === "none" || identity.effectiveCustomerId === null) {
      return res.status(403).json({ error: "No portal access for this workspace" });
    }
    if (!identity.canAccessRequests && !identity.canAccessRetainers) {
      return res.status(403).json({ error: "No portal access for this workspace" });
    }
    const effectiveCustomerId = identity.effectiveCustomerId;

    // Subscriptions are needed by both retainer widgets AND the new-request
    // picker, so we always load them when the user has any portal access.
    const mySubs = await db.select().from(subscriptionsTable)
      .where(and(eq(subscriptionsTable.customerId, effectiveCustomerId), eq(subscriptionsTable.workspaceId, workspace.id)));

    const activeSub = mySubs.find(s => s.status === "active") ?? null;

    const myRequests = identity.canAccessRequests
      ? await db.select().from(requestsTable)
          .where(and(eq(requestsTable.customerId, effectiveCustomerId), eq(requestsTable.workspaceId, workspace.id)))
          .orderBy(desc(requestsTable.createdAt))
      : [];

    const recentRequests = myRequests.slice(0, 5);

    const allUsers = await db.select().from(usersTable).where(eq(usersTable.id, effectiveCustomerId));
    const customer = allUsers[0];

    const formattedRequests = recentRequests.map(r => formatRequestRecord(r, customer));

    const counts = {
      not_started: myRequests.filter(r => r.status === "not_started").length,
      pending: myRequests.filter(r => r.status === "pending").length,
      in_progress: myRequests.filter(r => r.status === "in_progress").length,
      completed: myRequests.filter(r => r.status === "completed").length,
      cancelled: myRequests.filter(r => r.status === "cancelled").length,
    };

    const remainingMinutes = activeSub ? Math.max(0, activeSub.totalMinutes - activeSub.usedMinutes) : 0;
    const threshold = activeSub?.lowBalanceThresholdMinutes ?? 60;
    const isLowBalance = activeSub
      ? (activeSub.totalMinutes < 999999 && remainingMinutes < threshold)
      : false;

    // Get assigned forms for this customer
    const assignments = await db.select().from(formAssignmentsTable)
      .where(eq(formAssignmentsTable.customerId, effectiveCustomerId));
    let assignedForm = null;
    if (assignments.length > 0) {
      const formIds = assignments.map((a: any) => a.formId);
      const forms = await db.select().from(formsTable)
        .where(inArray(formsTable.id, formIds));
      const activeForm = forms.find(f => f.isActive);
      if (activeForm) {
        const formAssignments = await db.select().from(formAssignmentsTable)
          .where(eq(formAssignmentsTable.formId, activeForm.id));
        assignedForm = {
          id: activeForm.id,
          title: activeForm.title,
          description: activeForm.description,
          fields: activeForm.fields ?? [],
          isActive: activeForm.isActive,
          createdAt: activeForm.createdAt,
          updatedAt: activeForm.updatedAt,
          assignedCustomerIds: formAssignments.map((a: any) => a.customerId),
        };
      }
    }

    let formattedSub = null;
    if (activeSub) {
      const [pkg] = await db.select().from(retainerPackagesTable).where(eq(retainerPackagesTable.id, activeSub.packageId));
      formattedSub = formatSubscriptionRecord(activeSub, customer, pkg);
    }

    const unreadReplies = myRequests.filter(r => {
      if (!r.lastMessageAt) return false;
      if (r.lastMessageByRole !== "admin" && r.lastMessageByRole !== "owner") return false;
      if (!r.customerLastReadAt) return true;
      return new Date(r.customerLastReadAt).getTime() < new Date(r.lastMessageAt).getTime();
    }).length;

    return res.json({
      activeSubscription: formattedSub,
      remainingMinutes,
      totalMinutes: activeSub?.totalMinutes ?? 0,
      usedMinutes: activeSub?.usedMinutes ?? 0,
      isLowBalance,
      recentRequests: formattedRequests,
      requestCounts: counts,
      assignedForm,
      unreadReplies,
    });
  } catch (err) {
    req.log.error({ err }, "Error getting customer dashboard");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /dashboard/admin (workspace-scoped)
router.get("/dashboard/admin", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const allSubs = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.workspaceId, workspace.id));
    const activeSubs = allSubs.filter(s => s.status === "active");
    const allRequests = await db.select().from(requestsTable)
      .where(eq(requestsTable.workspaceId, workspace.id))
      .orderBy(desc(requestsTable.createdAt));

    const customerIds = [...new Set([...allSubs.map(s => s.customerId), ...allRequests.map(r => r.customerId)])];
    const allCustomers = customerIds.length > 0
      ? (await db.select().from(usersTable)).filter(u => u.role === "customer" && customerIds.includes(u.id))
      : [];

    const recentRequests = allRequests.slice(0, 10);

    const customerMap = new Map<number, any>();
    const allUsersForMap = customerIds.length > 0 ? await db.select().from(usersTable) : [];
    allUsersForMap.forEach(c => customerMap.set(c.id, c));

    const formattedRequests = recentRequests.map(r => formatRequestRecord(r, customerMap.get(r.customerId)));

    const counts = {
      not_started: allRequests.filter(r => r.status === "not_started").length,
      pending: allRequests.filter(r => r.status === "pending").length,
      in_progress: allRequests.filter(r => r.status === "in_progress").length,
      completed: allRequests.filter(r => r.status === "completed").length,
      cancelled: allRequests.filter(r => r.status === "cancelled").length,
    };

    // Customers with low balance — use per-subscription threshold
    const lowBalanceSubs = activeSubs.filter(s => {
      if (s.totalMinutes >= 999999) return false;
      const remaining = s.totalMinutes - s.usedMinutes;
      const threshold = s.lowBalanceThresholdMinutes ?? 60;
      return remaining < threshold;
    }).slice(0, 10);

    const pkgIds = [...new Set(lowBalanceSubs.map(s => s.packageId))];
    const pkgs = pkgIds.length > 0
      ? await db.select().from(retainerPackagesTable).where(inArray(retainerPackagesTable.id, pkgIds))
      : [];
    const pkgMap = new Map(pkgs.map(p => [p.id, p]));

    const formattedLowBalance = lowBalanceSubs.map(s =>
      formatSubscriptionRecord(s, customerMap.get(s.customerId), pkgMap.get(s.packageId))
    );

    const unreadReplies = allRequests.filter(r => {
      if (!r.lastMessageAt) return false;
      if (r.lastMessageByRole !== "customer") return false;
      if (!r.adminLastReadAt) return true;
      return new Date(r.adminLastReadAt).getTime() < new Date(r.lastMessageAt).getTime();
    }).length;

    return res.json({
      totalCustomers: allCustomers.length,
      activeSubscriptions: activeSubs.length,
      totalRequests: allRequests.length,
      requestCounts: counts,
      recentRequests: formattedRequests,
      customersWithLowBalance: formattedLowBalance,
      unreadReplies,
    });
  } catch (err) {
    req.log.error({ err }, "Error getting admin dashboard");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /dashboard/owner
router.get("/dashboard/owner", requireOwner, async (req, res) => {
  try {
    const allUsers = await db.select().from(usersTable);
    const allSubs = await db.select().from(subscriptionsTable);

    const customers = allUsers.filter(u => u.role === "customer");
    const admins = allUsers.filter(u => u.role === "admin");
    const activeSubs = allSubs.filter(s => s.status === "active");

    const allPkgs = await db.select().from(retainerPackagesTable);
    const pkgMap = new Map(allPkgs.map(p => [p.id, p]));
    let totalRevenue = 0;
    for (const sub of allSubs) {
      const pkg = pkgMap.get(sub.packageId);
      if (pkg) totalRevenue += Number(pkg.price);
    }

    const typeCount = new Map<string, number>();
    for (const sub of allSubs) {
      const pkg = pkgMap.get(sub.packageId);
      if (pkg) {
        typeCount.set(pkg.type, (typeCount.get(pkg.type) ?? 0) + 1);
      }
    }
    const subscriptionsByType = Array.from(typeCount.entries()).map(([type, count]) => ({ type, count }));

    const userMap = new Map(allUsers.map(u => [u.id, u]));
    const recentSubs = [...allSubs]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5);
    const formattedRecent = recentSubs.map(s =>
      formatSubscriptionRecord(s, userMap.get(s.customerId), pkgMap.get(s.packageId))
    );

    return res.json({
      totalUsers: allUsers.length,
      totalCustomers: customers.length,
      totalAdmins: admins.length,
      totalSubscriptions: allSubs.length,
      activeSubscriptions: activeSubs.length,
      subscriptionsByType,
      recentSubscriptions: formattedRecent,
      totalRevenue,
    });
  } catch (err) {
    req.log.error({ err }, "Error getting owner dashboard");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
