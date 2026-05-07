import type { Request, Response, NextFunction } from "express";
import { db, workspacesTable, usersTable, retainerPackagesTable, requestsTable, subscriptionsTable, getPlan, isWithinLimit, type PlanId } from "@workspace/db";
import { and, eq, gte, sql } from "drizzle-orm";

type Resource = "clients" | "retainers" | "requests" | "admins" | "integrations";

/**
 * Counts the current usage of `resource` within a workspace.
 * Used both by the guard middleware and by the owner overview to render
 * usage bars in the UI.
 */
export async function getCurrentUsage(workspaceId: number, resource: Resource): Promise<number> {
  if (resource === "clients") {
    // Customer users that have at least one subscription in this workspace.
    const rows = await db.selectDistinct({ id: subscriptionsTable.customerId })
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.workspaceId, workspaceId));
    return rows.length;
  }
  if (resource === "retainers") {
    const rows = await db.select({ id: retainerPackagesTable.id })
      .from(retainerPackagesTable)
      .where(and(
        eq(retainerPackagesTable.workspaceId, workspaceId),
        eq(retainerPackagesTable.isActive, true),
      ));
    return rows.length;
  }
  if (resource === "requests") {
    // Requests created in the current calendar month.
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const rows = await db.select({ c: sql<number>`count(*)::int` })
      .from(requestsTable)
      .where(and(
        eq(requestsTable.workspaceId, workspaceId),
        gte(requestsTable.createdAt, monthStart),
      ));
    return Number(rows[0]?.c ?? 0);
  }
  if (resource === "admins") {
    // Workspace owner counts as 1; secondary admins would be future invited users.
    // For now we only have the workspace owner as the admin, so this is always 1.
    return 1;
  }
  return 0;
}

/**
 * Express middleware factory: checks that the active workspace has capacity
 * to add one more `resource` under its current plan. Responds with 402 if
 * over the limit so the client can prompt an upgrade.
 *
 * Requires that an earlier middleware (e.g. requireWorkspaceAdmin or
 * loadPortalWorkspace) has set req.workspace.
 */
export function requirePlanCapacity(resource: Resource) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const workspace = (req as any).workspace as typeof workspacesTable.$inferSelect | undefined;
    if (!workspace) return res.status(500).json({ error: "Plan guard requires req.workspace" });

    const plan = getPlan(workspace.plan);

    if (resource === "integrations") {
      if (!plan.limits.integrations) {
        return res.status(402).json({
          error: "Integrations are not available on the Free plan",
          currentPlan: plan.id,
          requiredPlan: "professional",
        });
      }
      return next();
    }

    let limit: number | null;
    if (resource === "clients") limit = plan.limits.clients;
    else if (resource === "retainers") limit = plan.limits.retainers;
    else if (resource === "requests") limit = plan.limits.requestsPerMonth;
    else if (resource === "admins") limit = plan.limits.admins;
    else limit = null;

    if (limit === null) return next();

    const current = await getCurrentUsage(workspace.id, resource);
    if (!isWithinLimit(limit, current)) {
      return res.status(402).json({
        error: `Your ${plan.name} plan is limited to ${limit} ${resource}.`,
        currentPlan: plan.id,
        requiredPlan: plan.id === "free" || plan.id === "basic" ? "professional" : "agency",
        resource,
        limit,
        current,
      });
    }
    return next();
  };
}

/**
 * For routes where workspace isn't already loaded by another middleware:
 * resolves it from the URL path param `:slug` (NOT the X-Workspace-Slug
 * header) — capacity must be enforced against the workspace actually being
 * mutated, otherwise a caller who owns multiple workspaces could send
 * header=paid, path=free and bypass the Free-plan gate on the free workspace.
 */
export function requirePlanCapacityForSlug(resource: Resource) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const pathSlug = (req.params?.slug as string | undefined)?.toLowerCase();
    if (!pathSlug) return res.status(400).json({ error: "Missing :slug path param" });
    const [ws] = await db.select().from(workspacesTable).where(eq(workspacesTable.slug, pathSlug));
    if (!ws) return res.status(404).json({ error: "Workspace not found" });
    (req as any).workspace = ws;
    return requirePlanCapacity(resource)(req, res, next);
  };
}

export type { PlanId };
