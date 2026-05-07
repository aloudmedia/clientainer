import { Router } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { db, usersTable, workspacesTable } from "@workspace/db";
import { and, eq, ilike, or } from "drizzle-orm";
import { requireAuth, requireAdmin, requireOwner, loadDbUser, resolvePortalIdentity } from "../lib/auth";
import { sendCustomerInvite } from "../lib/clerk-invite";

/**
 * For a workspace-admin caller, resolve the workspace identified by the
 * X-Workspace-Slug header and assert that the caller owns it. Returns the
 * workspace row, or null if access should be denied (in which case the
 * response has already been sent).
 *
 * Owners (platform superadmins) bypass: they can act across workspaces, so
 * this returns the workspace if it exists, regardless of ownership.
 */
async function resolveCallerWorkspace(req: any, res: any) {
  const slug = (req.headers["x-workspace-slug"] as string | undefined)?.toLowerCase();
  if (!slug) {
    res.status(400).json({ error: "Missing X-Workspace-Slug header" });
    return null;
  }
  const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.slug, slug));
  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return null;
  }
  const dbUser = req.dbUser as typeof usersTable.$inferSelect | undefined;
  if (dbUser && dbUser.role !== "owner" && workspace.ownerId !== dbUser.id) {
    res.status(403).json({ error: "You do not own this workspace" });
    return null;
  }
  return workspace;
}
import {
  UpdateUserRoleBody,
  UpdateUserRoleParams,
  ListUsersQueryParams,
  CreateUserBody,
  SuspendUserBody,
  UpdateUserPaymentMethodBody,
  UpdateUserPaymentMethodParams,
} from "@workspace/api-zod";

const router = Router();

function serializeUser(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    clerkUserId: u.clerkUserId,
    email: u.email,
    name: u.name,
    role: u.role,
    isSuspended: u.isSuspended,
    suspendedAt: u.suspendedAt,
    suspendedReason: u.suspendedReason,
    paymentMethod: u.paymentMethod,
    createdAt: u.createdAt,
  };
}

// GET /users/me
router.get("/users/me", requireAuth, async (req, res) => {
  try {
    const clerkUserId = (req as any).clerkUserId;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, clerkUserId));
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    // Customers must never see their internal suspension reason; admins/owners may, but
    // /users/me only ever returns the caller's own record so we redact for "customer".
    const out = serializeUser(user);
    if (user.role === "customer") {
      out.suspendedReason = null;
    }
    return res.json(out);
  } catch (err) {
    req.log.error({ err }, "Error getting user");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /users/sync
router.post("/users/sync", requireAuth, async (req, res) => {
  try {
    const auth = getAuth(req);
    const clerkUserId = auth?.userId!;

    // Try session claims first (cheap), then fall back to fetching the user from Clerk's API.
    let emailAddress: string | undefined =
      (auth as any)?.sessionClaims?.email || (auth as any)?.sessionClaims?.primaryEmail;
    let firstName: string = (auth as any)?.sessionClaims?.firstName || "";
    let lastName: string = (auth as any)?.sessionClaims?.lastName || "";

    if (!emailAddress) {
      try {
        const clerkUser = await clerkClient.users.getUser(clerkUserId);
        const primaryId = clerkUser.primaryEmailAddressId;
        const primary = clerkUser.emailAddresses?.find((e: any) => e.id === primaryId)
          ?? clerkUser.emailAddresses?.[0];
        if (primary?.emailAddress) emailAddress = primary.emailAddress;
        if (!firstName && clerkUser.firstName) firstName = clerkUser.firstName;
        if (!lastName && clerkUser.lastName) lastName = clerkUser.lastName;
      } catch (err) {
        req.log.warn({ err }, "Failed to fetch Clerk user during sync");
      }
    }

    const name = [firstName, lastName].filter(Boolean).join(" ") || null;

    const [existingByClerkId] = await db.select().from(usersTable).where(eq(usersTable.clerkUserId, clerkUserId));
    if (existingByClerkId) {
      return res.json(serializeUser(existingByClerkId));
    }

    // Fail closed if we cannot resolve an email — creating a placeholder record would
    // bypass admin pre-created customer matching and could grant unintended admin access.
    if (!emailAddress) {
      req.log.warn({ clerkUserId }, "Cannot sync user: no email available from Clerk");
      return res.status(503).json({
        error: "Could not resolve account email. Please retry.",
        code: "EMAIL_UNAVAILABLE",
      });
    }

    // Check if a manually pre-created customer record exists for this email
    const email = emailAddress;
    const [existingByEmail] = await db.select().from(usersTable).where(eq(usersTable.email, emailAddress));
    if (existingByEmail) {
      // Attach the Clerk ID to the pre-created record
      const [updated] = await db.update(usersTable)
        .set({ clerkUserId, name: existingByEmail.name ?? name })
        .where(eq(usersTable.id, existingByEmail.id))
        .returning();
      return res.json(serializeUser(updated));
    }

    // New sign-ups are always "admin" (agency users).
    // The "owner" (platform superadmin) role is assigned manually via the role endpoint.
    const role = "admin";

    const [newUser] = await db.insert(usersTable).values({
      clerkUserId,
      email,
      name,
      role,
    }).returning();

    return res.json(serializeUser(newUser));
  } catch (err) {
    req.log.error({ err }, "Error syncing user");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /users (admin/owner only)
//
// Workspace scoping:
//   - Customers (role="customer") are scoped to the caller's workspace via
//     usersTable.workspaceId. The caller's workspace is resolved from the
//     X-Workspace-Slug header (always sent by the web client).
//   - Platform owners bypass scoping and see all users globally.
//   - Listing admins/owners is owner-only; for non-owner callers asking for
//     role=admin|owner we return an empty list rather than leak cross-tenant
//     accounts.
router.get("/users", requireAdmin, async (req, res) => {
  try {
    const params = ListUsersQueryParams.safeParse(req.query);
    const query = params.success ? params.data : {};
    const caller = (req as any).dbUser as typeof usersTable.$inferSelect;
    const isOwner = caller.role === "owner";

    const conditions: any[] = [];

    if (query.role) {
      conditions.push(eq(usersTable.role, query.role as any));
    }
    if (query.search) {
      conditions.push(
        or(
          ilike(usersTable.email, `%${query.search}%`),
          ilike(usersTable.name as any, `%${query.search}%`),
        )
      );
    }

    if (!isOwner) {
      // Non-owner admins may only ever see customers in their own workspace.
      if (query.role && query.role !== "customer") {
        return res.json([]);
      }
      const workspace = await resolveCallerWorkspace(req, res);
      if (!workspace) return; // response already sent
      conditions.push(eq(usersTable.role, "customer" as any));
      conditions.push(eq(usersTable.workspaceId, workspace.id));
    }

    const where = conditions.length === 0
      ? undefined
      : conditions.length === 1
        ? conditions[0]
        : and(...conditions);

    const users = where
      ? await db.select().from(usersTable).where(where)
      : await db.select().from(usersTable);

    return res.json(users.map(serializeUser));
  } catch (err) {
    req.log.error({ err }, "Error listing users");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /users (admin only — manually create a customer)
//
// Stamps the new customer with the caller's workspaceId so that subsequent
// GET /users calls only return customers belonging to the creator's workspace.
router.post("/users", requireAdmin, async (req, res) => {
  try {
    const body = CreateUserBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body", details: body.error.flatten() });

    const { email, name } = body.data;

    const workspace = await resolveCallerWorkspace(req, res);
    if (!workspace) return; // response already sent

    const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));
    if (existing) {
      return res.status(409).json({ error: "A user with this email already exists" });
    }

    const [newUser] = await db.insert(usersTable).values({
      clerkUserId: `pending:${email}`,
      email,
      name: name ?? null,
      role: "customer",
      workspaceId: workspace.id,
    }).returning();

    // Best-effort: send a Clerk invitation email so the new client can activate
    // their account (set a password, or sign up with Google). Failures are logged
    // but never fail the user-creation request — the admin can resend later.
    try {
      await sendCustomerInvite({ req, email, workspaceSlug: workspace.slug, workspaceId: workspace.id, workspaceName: workspace.name, log: req.log });
    } catch (err) {
      req.log.warn({ err, email }, "Customer created but invitation email failed");
    }

    return res.status(201).json(serializeUser(newUser));
  } catch (err: any) {
    if (err?.code === "23505") {
      return res.status(409).json({ error: "A client with this email already exists." });
    }
    req.log.error({ err }, "Error creating user");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /users/:id/role (owner only)
router.patch("/users/:id/role", requireOwner, async (req, res) => {
  try {
    const params = UpdateUserRoleParams.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid params" });

    const body = UpdateUserRoleBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const [updated] = await db.update(usersTable)
      .set({ role: body.data.role as any })
      .where(eq(usersTable.id, params.data.id))
      .returning();

    if (!updated) return res.status(404).json({ error: "User not found" });

    return res.json(serializeUser(updated));
  } catch (err) {
    req.log.error({ err }, "Error updating user role");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /users/:id/suspend (admin/owner only — suspend a customer's portal access)
router.post("/users/:id/suspend", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const body = SuspendUserBody.safeParse(req.body ?? {});
    const reason = body.success ? body.data.reason ?? null : null;

    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    if (!target) return res.status(404).json({ error: "User not found" });
    if (target.role !== "customer") {
      return res.status(400).json({ error: "Only customers can be suspended" });
    }
    const caller = (req as any).dbUser as typeof usersTable.$inferSelect;
    if (caller.role !== "owner") {
      const workspace = await resolveCallerWorkspace(req, res);
      if (!workspace) return;
      if (target.workspaceId !== workspace.id) {
        return res.status(404).json({ error: "User not found" });
      }
    }

    const [updated] = await db.update(usersTable)
      .set({ isSuspended: true, suspendedAt: new Date(), suspendedReason: reason })
      .where(eq(usersTable.id, id))
      .returning();

    req.log.info({ userId: id, by: (req as any).dbUser?.id }, "Customer suspended");
    return res.json(serializeUser(updated));
  } catch (err) {
    req.log.error({ err }, "Error suspending user");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /users/:id/invite (admin/owner only — resend the Clerk activation email)
router.post("/users/:id/invite", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    if (!target) return res.status(404).json({ error: "User not found" });
    if (target.role !== "customer") {
      return res.status(400).json({ error: "Only customers can be invited" });
    }
    const caller = (req as any).dbUser as typeof usersTable.$inferSelect;
    if (caller.role !== "owner") {
      const workspace = await resolveCallerWorkspace(req, res);
      if (!workspace) return;
      if (target.workspaceId !== workspace.id) {
        return res.status(404).json({ error: "User not found" });
      }
    }

    // Already-activated rows have a real Clerk userId (not a pending placeholder).
    if (!target.clerkUserId.startsWith("pending:")) {
      return res.json({ ok: true, alreadyActivated: true });
    }

    const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.id, target.workspaceId!));
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    if (!process.env.CLERK_SECRET_KEY) {
      return res.status(503).json({ error: "Clerk is not configured on this server." });
    }

    try {
      await sendCustomerInvite({ req, email: target.email, workspaceSlug: workspace.slug, workspaceId: workspace.id, workspaceName: workspace.name, log: req.log });
    } catch (err: any) {
      req.log.error({ err, userId: id }, "Failed to resend invitation");
      return res.status(502).json({ error: "Could not send invitation email. Please try again." });
    }

    return res.json({ ok: true, alreadyActivated: false });
  } catch (err) {
    req.log.error({ err }, "Error resending invitation");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /users/:id/payment-method (admin/owner only — set preferred payment processor for a customer)
router.patch("/users/:id/payment-method", requireAdmin, async (req, res) => {
  try {
    const params = UpdateUserPaymentMethodParams.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid params" });

    const body = UpdateUserPaymentMethodBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, params.data.id));
    if (!target) return res.status(404).json({ error: "User not found" });
    if (target.role !== "customer") {
      return res.status(400).json({ error: "Payment method only applies to customers" });
    }
    const caller = (req as any).dbUser as typeof usersTable.$inferSelect;
    if (caller.role !== "owner") {
      const workspace = await resolveCallerWorkspace(req, res);
      if (!workspace) return;
      if (target.workspaceId !== workspace.id) {
        return res.status(404).json({ error: "User not found" });
      }
    }

    const [updated] = await db.update(usersTable)
      .set({ paymentMethod: body.data.paymentMethod ?? null })
      .where(eq(usersTable.id, params.data.id))
      .returning();

    req.log.info(
      { userId: params.data.id, paymentMethod: body.data.paymentMethod, by: (req as any).dbUser?.id },
      "Customer payment method updated",
    );
    return res.json(serializeUser(updated));
  } catch (err) {
    req.log.error({ err }, "Error updating payment method");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /users/:id/unsuspend (admin/owner only — restore portal access)
router.post("/users/:id/unsuspend", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    if (!target) return res.status(404).json({ error: "User not found" });
    const caller = (req as any).dbUser as typeof usersTable.$inferSelect;
    if (caller.role !== "owner" && target.role === "customer") {
      const workspace = await resolveCallerWorkspace(req, res);
      if (!workspace) return;
      if (target.workspaceId !== workspace.id) {
        return res.status(404).json({ error: "User not found" });
      }
    }

    const [updated] = await db.update(usersTable)
      .set({ isSuspended: false, suspendedAt: null, suspendedReason: null })
      .where(eq(usersTable.id, id))
      .returning();

    req.log.info({ userId: id, by: (req as any).dbUser?.id }, "Customer unsuspended");
    return res.json(serializeUser(updated));
  } catch (err) {
    req.log.error({ err }, "Error unsuspending user");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /me/permissions — resolve effective permissions for the active workspace.
// Returns the caller's effective access for /requests and /retainers in the
// workspace identified by X-Workspace-Slug.
//   - admin/owner of the workspace -> kind=admin|owner, both true
//   - primary customer (a user with a subscription in the workspace) -> kind=primary, both true
//   - email matches a secondary_contact in the workspace -> kind=secondary + flags
//   - otherwise -> kind=none, both false
router.get("/me/permissions", loadDbUser, async (req, res) => {
  try {
    const dbUser = (req as any).dbUser as typeof usersTable.$inferSelect;
    const slug = (req.headers["x-workspace-slug"] as string | undefined)?.toLowerCase();
    if (!slug) return res.status(400).json({ error: "Missing X-Workspace-Slug header" });

    const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.slug, slug));
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    if (dbUser.role === "owner") {
      return res.json({ kind: "owner", canAccessRequests: true, canAccessRetainers: true, primaryUserId: null });
    }
    if (dbUser.role === "admin" && workspace.ownerId === dbUser.id) {
      return res.json({ kind: "admin", canAccessRequests: true, canAccessRetainers: true, primaryUserId: null });
    }

    // Single source of truth: same resolver the protected routes use.
    const identity = await resolvePortalIdentity(dbUser, workspace.id);
    return res.json({
      kind: identity.kind,
      canAccessRequests: identity.canAccessRequests,
      canAccessRetainers: identity.canAccessRetainers,
      primaryUserId: identity.effectiveCustomerId,
    });
  } catch (err) {
    req.log.error({ err }, "Error resolving permissions");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
