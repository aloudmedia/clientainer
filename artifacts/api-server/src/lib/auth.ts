import { getAuth } from "@clerk/express";
import type { Request, Response, NextFunction } from "express";
import { db, usersTable, workspacesTable, secondaryContactsTable, subscriptionsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const auth = getAuth(req);
  const clerkUserId = auth?.userId;
  if (!clerkUserId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  (req as any).clerkUserId = clerkUserId;
  return next();
};

export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  const auth = getAuth(req);
  const clerkUserId = auth?.userId;
  if (!clerkUserId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, clerkUserId));
  if (!user || (user.role !== "admin" && user.role !== "owner")) {
    return res.status(403).json({ error: "Forbidden" });
  }
  (req as any).clerkUserId = clerkUserId;
  (req as any).dbUser = user;
  return next();
};

export const requireOwner = async (req: Request, res: Response, next: NextFunction) => {
  const auth = getAuth(req);
  const clerkUserId = auth?.userId;
  if (!clerkUserId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, clerkUserId));
  if (!user || user.role !== "owner") {
    return res.status(403).json({ error: "Forbidden" });
  }
  (req as any).clerkUserId = clerkUserId;
  (req as any).dbUser = user;
  return next();
};

export const loadDbUser = async (req: Request, res: Response, next: NextFunction) => {
  const auth = getAuth(req);
  const clerkUserId = auth?.userId;
  if (!clerkUserId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, clerkUserId));
  if (!user) {
    return res.status(401).json({ error: "User not found. Please sync your account." });
  }
  if (user.isSuspended && user.role === "customer") {
    return res.status(403).json({
      error: "Your portal access has been suspended.",
      code: "ACCOUNT_SUSPENDED",
      reason: user.suspendedReason ?? null,
      suspendedAt: user.suspendedAt,
    });
  }
  (req as any).clerkUserId = clerkUserId;
  (req as any).dbUser = user;
  return next();
};

/**
 * Requires the user to be an admin who owns the workspace identified by
 * the X-Workspace-Slug request header. Attaches req.dbUser and req.workspace.
 */
export const requireWorkspaceAdmin = async (req: Request, res: Response, next: NextFunction) => {
  const auth = getAuth(req);
  const clerkUserId = auth?.userId;
  if (!clerkUserId) return res.status(401).json({ error: "Unauthorized" });

  const [user] = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, clerkUserId));
  if (!user || (user.role !== "admin" && user.role !== "owner")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const slug = (req.headers["x-workspace-slug"] as string | undefined)?.toLowerCase();
  if (!slug) return res.status(400).json({ error: "Missing X-Workspace-Slug header" });

  const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.slug, slug));
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  if (workspace.ownerId !== user.id) {
    return res.status(403).json({ error: "You do not own this workspace" });
  }

  (req as any).clerkUserId = clerkUserId;
  (req as any).dbUser = user;
  (req as any).workspace = workspace;
  return next();
};

/**
 * Loads the workspace from the X-Workspace-Slug request header (public — no auth check).
 * Attaches req.workspace.
 */
/**
 * Resolves the effective portal identity for a logged-in user in a given workspace.
 *
 * Returns:
 *   - `kind: "primary"` — the user themself is a customer in this workspace; full access.
 *   - `kind: "secondary"` — the user's email matches a secondary_contact row in the
 *     workspace; effective customerId is the row's primaryUserId, gated by per-row flags.
 *   - `kind: "none"` — the user has no portal access in this workspace.
 *
 * `effectiveCustomerId` is the user.id whose data the caller may read/write for portal
 * operations (subscriptions, requests, dashboards). Use this anywhere the legacy code
 * uses `dbUser.id` for customer-row lookups.
 */
export async function resolvePortalIdentity(
  user: typeof usersTable.$inferSelect,
  workspaceId: number,
): Promise<
  | { kind: "primary"; effectiveCustomerId: number; canAccessRequests: true; canAccessRetainers: true }
  | { kind: "secondary"; effectiveCustomerId: number; canAccessRequests: boolean; canAccessRetainers: boolean }
  | { kind: "none"; effectiveCustomerId: null; canAccessRequests: false; canAccessRetainers: false }
> {
  // Direct customer? (has a subscription in this workspace)
  if (user.role === "customer") {
    const [sub] = await db.select({ id: subscriptionsTable.id })
      .from(subscriptionsTable)
      .where(and(
        eq(subscriptionsTable.customerId, user.id),
        eq(subscriptionsTable.workspaceId, workspaceId),
      ))
      .limit(1);
    if (sub) {
      return { kind: "primary", effectiveCustomerId: user.id, canAccessRequests: true, canAccessRetainers: true };
    }
    // Customer with no subscription yet in this workspace: treat as primary so they can
    // see the empty-state portal but no data leaks (no rows match their id).
    return { kind: "primary", effectiveCustomerId: user.id, canAccessRequests: true, canAccessRetainers: true };
  }

  // Secondary contact match by email in this workspace?
  const emailLower = (user.email ?? "").toLowerCase();
  if (emailLower) {
    const [contact] = await db.select().from(secondaryContactsTable).where(and(
      eq(secondaryContactsTable.workspaceId, workspaceId),
      eq(secondaryContactsTable.email, emailLower),
    )).limit(1);
    if (contact) {
      return {
        kind: "secondary",
        effectiveCustomerId: contact.primaryUserId,
        canAccessRequests: contact.canAccessRequests,
        canAccessRetainers: contact.canAccessRetainers,
      };
    }
  }

  return { kind: "none", effectiveCustomerId: null, canAccessRequests: false, canAccessRetainers: false };
}

export const loadPortalWorkspace = async (req: Request, res: Response, next: NextFunction) => {
  const slug = (req.headers["x-workspace-slug"] as string | undefined)?.toLowerCase();
  if (!slug) return res.status(400).json({ error: "Missing X-Workspace-Slug header" });

  const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.slug, slug));
  if (!workspace) return res.status(404).json({ error: "Workspace not found" });

  (req as any).workspace = workspace;
  return next();
};
