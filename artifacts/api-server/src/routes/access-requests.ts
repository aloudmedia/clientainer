import { Router } from "express";
import { z } from "zod";
import {
  db,
  accessRequestsTable,
  secondaryContactsTable,
  usersTable,
  workspacesTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { requireWorkspaceAdmin } from "../lib/auth";

const router = Router();

// Lightweight in-memory rate limiter for the unauthenticated submit endpoint.
// Allows N submissions per (ip + slug) per window. Resets on process restart.
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 min
const RATE_LIMIT = 5;
const rateBuckets = new Map<string, number[]>();
function checkRate(key: string): boolean {
  const now = Date.now();
  const arr = (rateBuckets.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_LIMIT) {
    rateBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  return true;
}

const SubmitInput = z.object({
  slug: z.string().trim().toLowerCase().min(1).max(120),
  requesterEmail: z.string().trim().toLowerCase().email().max(320),
  requesterName: z.string().trim().min(1).max(200).optional().nullable(),
  primaryContactEmail: z.string().trim().toLowerCase().email().max(320),
  message: z.string().trim().max(2000).optional().nullable(),
});

function serialize(
  r: typeof accessRequestsTable.$inferSelect,
  primary?: { email: string; name: string | null } | null,
) {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    primaryUserId: r.primaryUserId,
    primaryUserEmail: primary?.email ?? null,
    primaryUserName: primary?.name ?? null,
    requesterEmail: r.requesterEmail,
    requesterName: r.requesterName,
    message: r.message,
    status: r.status,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
  };
}

// POST /portal/access-requests — public (no auth required).
// The requester is asking for portal access to an existing client's portal.
// Workspace + primary contact are looked up from the body; on success a
// pending row is created for the admin to approve/decline.
router.post("/portal/access-requests", async (req, res) => {
  try {
    const parsed = SubmitInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    }
    const { slug, requesterEmail, requesterName, primaryContactEmail, message } = parsed.data;

    if (requesterEmail === primaryContactEmail) {
      return res.status(400).json({ error: "Use the primary contact's email, not your own." });
    }

    // Use the socket-level remote address (not X-Forwarded-For) so an attacker
    // can't trivially spoof a different IP per request to bypass the limiter.
    const ip = req.socket?.remoteAddress ?? "unknown";
    if (!checkRate(`${ip}:${slug}`)) {
      return res.status(429).json({ error: "Too many requests. Please try again later." });
    }

    const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.slug, slug));
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    // Find the primary contact (a customer in this workspace whose email matches).
    const [primary] = await db.select().from(usersTable).where(and(
      eq(usersTable.email, primaryContactEmail),
      eq(usersTable.workspaceId, workspace.id),
      eq(usersTable.role, "customer"),
    ));

    // We don't reveal whether the email matched — to avoid disclosing client
    // membership to outsiders. The admin will see whether primaryUserId is
    // resolved (and can pick one at approval time if not).
    const primaryUserId = primary?.id ?? null;

    // Already requested?
    const [existing] = await db.select().from(accessRequestsTable).where(and(
      eq(accessRequestsTable.workspaceId, workspace.id),
      eq(accessRequestsTable.requesterEmail, requesterEmail),
      eq(accessRequestsTable.status, "pending"),
    ));
    if (existing) {
      return res.status(201).json({ ok: true, id: existing.id });
    }

    const [created] = await db.insert(accessRequestsTable).values({
      workspaceId: workspace.id,
      primaryUserId,
      requesterEmail,
      requesterName: requesterName ?? null,
      message: message ?? null,
    }).returning();

    req.log.info(
      { accessRequestId: created.id, workspaceId: workspace.id, primaryUserId },
      "Portal access request submitted",
    );
    return res.status(201).json({ ok: true, id: created.id });
  } catch (err) {
    req.log.error({ err }, "Error submitting access request");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /access-requests (workspace admin)
router.get("/access-requests", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const status = typeof req.query.status === "string"
      ? (req.query.status as "pending" | "approved" | "declined")
      : undefined;

    const conds = [eq(accessRequestsTable.workspaceId, workspace.id)];
    if (status === "pending" || status === "approved" || status === "declined") {
      conds.push(eq(accessRequestsTable.status, status));
    }

    const rows = await db.select().from(accessRequestsTable)
      .where(conds.length === 1 ? conds[0] : and(...conds))
      .orderBy(desc(accessRequestsTable.createdAt));

    const ids = Array.from(new Set(rows.map(r => r.primaryUserId).filter((x): x is number => !!x)));
    const primaries = ids.length === 0 ? [] : await db.select().from(usersTable).where(
      // eq is fine because there'll only be a few; avoid `inArray` import churn.
      ids.length === 1 ? eq(usersTable.id, ids[0]) : (await import("drizzle-orm")).inArray(usersTable.id, ids),
    );
    const byId = new Map(primaries.map(p => [p.id, { email: p.email, name: p.name }]));

    return res.json(rows.map(r => serialize(r, r.primaryUserId ? byId.get(r.primaryUserId) ?? null : null)));
  } catch (err) {
    req.log.error({ err }, "Error listing access requests");
    return res.status(500).json({ error: "Internal server error" });
  }
});

const ApproveInput = z.object({
  primaryUserId: z.number().int().positive().optional(),
  canAccessRequests: z.boolean().optional(),
  canAccessRetainers: z.boolean().optional(),
});

// POST /access-requests/:id/approve
router.post("/access-requests/:id/approve", requireWorkspaceAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    const workspace = (req as any).workspace;
    const dbUser = (req as any).dbUser as typeof usersTable.$inferSelect;

    const parsed = ApproveInput.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    const [row] = await db.select().from(accessRequestsTable).where(and(
      eq(accessRequestsTable.id, id),
      eq(accessRequestsTable.workspaceId, workspace.id),
    ));
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.status !== "pending") return res.status(409).json({ error: "Already decided" });

    const primaryUserId = parsed.data.primaryUserId ?? row.primaryUserId;
    if (!primaryUserId) {
      return res.status(400).json({
        error: "Pick which client this requester should be linked to (primaryUserId).",
      });
    }

    // Verify primary belongs to this workspace.
    const [primary] = await db.select().from(usersTable).where(eq(usersTable.id, primaryUserId));
    if (!primary || primary.role !== "customer" || primary.workspaceId !== workspace.id) {
      return res.status(400).json({ error: "Primary contact does not belong to this workspace" });
    }

    if (row.requesterEmail.toLowerCase() === primary.email.toLowerCase()) {
      return res.status(400).json({ error: "Requester email matches the primary contact" });
    }

    // Atomically flip pending → approved. If two admins click Approve at the
    // same time (or one races with Decline), exactly one update will hit a
    // pending row; the loser sees 409 and we never write a duplicate
    // secondary_contacts row downstream.
    const [updated] = await db.update(accessRequestsTable)
      .set({
        status: "approved",
        primaryUserId,
        decidedAt: new Date(),
        decidedByAdminId: dbUser.id,
      })
      .where(and(
        eq(accessRequestsTable.id, id),
        eq(accessRequestsTable.workspaceId, workspace.id),
        eq(accessRequestsTable.status, "pending"),
      ))
      .returning();
    if (!updated) {
      return res.status(409).json({ error: "Already decided" });
    }

    // Now create the secondary contact. Done after the conditional update so a
    // losing concurrent approve never inserts. Still guarded against an
    // already-existing identical row (e.g. admin previously added them by hand).
    const [existingContact] = await db.select().from(secondaryContactsTable).where(and(
      eq(secondaryContactsTable.workspaceId, workspace.id),
      eq(secondaryContactsTable.primaryUserId, primaryUserId),
      eq(secondaryContactsTable.email, row.requesterEmail),
    ));
    if (!existingContact) {
      await db.insert(secondaryContactsTable).values({
        workspaceId: workspace.id,
        primaryUserId,
        email: row.requesterEmail,
        name: row.requesterName ?? null,
        canAccessRequests: parsed.data.canAccessRequests ?? true,
        canAccessRetainers: parsed.data.canAccessRetainers ?? true,
      });
    }

    req.log.info(
      { accessRequestId: id, primaryUserId, by: dbUser.id },
      "Access request approved",
    );
    return res.json(serialize(updated, { email: primary.email, name: primary.name }));
  } catch (err) {
    req.log.error({ err }, "Error approving access request");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /access-requests/:id/decline
router.post("/access-requests/:id/decline", requireWorkspaceAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    const workspace = (req as any).workspace;
    const dbUser = (req as any).dbUser as typeof usersTable.$inferSelect;

    // Atomic conditional update so a concurrent approve/decline can't both win.
    const [updated] = await db.update(accessRequestsTable)
      .set({ status: "declined", decidedAt: new Date(), decidedByAdminId: dbUser.id })
      .where(and(
        eq(accessRequestsTable.id, id),
        eq(accessRequestsTable.workspaceId, workspace.id),
        eq(accessRequestsTable.status, "pending"),
      ))
      .returning();
    if (!updated) {
      // Either the row doesn't exist, isn't in this workspace, or already decided.
      const [row] = await db.select().from(accessRequestsTable).where(and(
        eq(accessRequestsTable.id, id),
        eq(accessRequestsTable.workspaceId, workspace.id),
      ));
      if (!row) return res.status(404).json({ error: "Not found" });
      return res.status(409).json({ error: "Already decided" });
    }

    req.log.info({ accessRequestId: id, by: dbUser.id }, "Access request declined");
    return res.json(serialize(updated));
  } catch (err) {
    req.log.error({ err }, "Error declining access request");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
