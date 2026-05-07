import { Router } from "express";
import { db, secondaryContactsTable, usersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireWorkspaceAdmin } from "../lib/auth";
import {
  CreateSecondaryContactBody,
  UpdateSecondaryContactBody,
} from "@workspace/api-zod";

const router = Router();

function serialize(c: typeof secondaryContactsTable.$inferSelect) {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    primaryUserId: c.primaryUserId,
    email: c.email,
    name: c.name,
    canAccessRequests: c.canAccessRequests,
    canAccessRetainers: c.canAccessRetainers,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// GET /users/:id/secondary-contacts
router.get("/users/:id/secondary-contacts", requireWorkspaceAdmin, async (req, res) => {
  try {
    const primaryUserId = Number(req.params.id);
    if (!Number.isFinite(primaryUserId)) return res.status(400).json({ error: "Invalid id" });
    const workspace = (req as any).workspace;

    // Confirm the primary user exists and is a customer (clients are global users
    // with role=customer; the secondary_contacts row is workspace-scoped on its own).
    const [primary] = await db.select().from(usersTable).where(eq(usersTable.id, primaryUserId));
    if (!primary || primary.role !== "customer") {
      return res.status(404).json({ error: "Primary user not found" });
    }

    const rows = await db.select().from(secondaryContactsTable).where(and(
      eq(secondaryContactsTable.workspaceId, workspace.id),
      eq(secondaryContactsTable.primaryUserId, primaryUserId),
    ));
    return res.json(rows.map(serialize));
  } catch (err) {
    req.log.error({ err }, "Error listing secondary contacts");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /users/:id/secondary-contacts
router.post("/users/:id/secondary-contacts", requireWorkspaceAdmin, async (req, res) => {
  try {
    const primaryUserId = Number(req.params.id);
    if (!Number.isFinite(primaryUserId)) return res.status(400).json({ error: "Invalid id" });
    const workspace = (req as any).workspace;

    const body = CreateSecondaryContactBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body", details: body.error.flatten() });

    const [primary] = await db.select().from(usersTable).where(eq(usersTable.id, primaryUserId));
    if (!primary || primary.role !== "customer") {
      return res.status(404).json({ error: "Primary user not found" });
    }

    const email = body.data.email.toLowerCase().trim();
    if (email === primary.email.toLowerCase()) {
      return res.status(409).json({ error: "Secondary contact email cannot match the primary contact" });
    }

    const [existing] = await db.select().from(secondaryContactsTable).where(and(
      eq(secondaryContactsTable.workspaceId, workspace.id),
      eq(secondaryContactsTable.primaryUserId, primaryUserId),
      eq(secondaryContactsTable.email, email),
    ));
    if (existing) return res.status(409).json({ error: "This email is already a secondary contact" });

    const [created] = await db.insert(secondaryContactsTable).values({
      workspaceId: workspace.id,
      primaryUserId,
      email,
      name: body.data.name ?? null,
      canAccessRequests: body.data.canAccessRequests ?? true,
      canAccessRetainers: body.data.canAccessRetainers ?? true,
    }).returning();

    return res.status(201).json(serialize(created));
  } catch (err) {
    req.log.error({ err }, "Error creating secondary contact");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /secondary-contacts/:id
router.put("/secondary-contacts/:id", requireWorkspaceAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    const workspace = (req as any).workspace;

    const body = UpdateSecondaryContactBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const [existing] = await db.select().from(secondaryContactsTable).where(and(
      eq(secondaryContactsTable.id, id),
      eq(secondaryContactsTable.workspaceId, workspace.id),
    ));
    if (!existing) return res.status(404).json({ error: "Not found" });

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.data.name !== undefined) patch["name"] = body.data.name;
    if (body.data.canAccessRequests !== undefined) patch["canAccessRequests"] = body.data.canAccessRequests;
    if (body.data.canAccessRetainers !== undefined) patch["canAccessRetainers"] = body.data.canAccessRetainers;

    const [updated] = await db.update(secondaryContactsTable)
      .set(patch)
      .where(eq(secondaryContactsTable.id, id))
      .returning();
    return res.json(serialize(updated));
  } catch (err) {
    req.log.error({ err }, "Error updating secondary contact");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /secondary-contacts/:id
router.delete("/secondary-contacts/:id", requireWorkspaceAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    const workspace = (req as any).workspace;

    const [existing] = await db.select().from(secondaryContactsTable).where(and(
      eq(secondaryContactsTable.id, id),
      eq(secondaryContactsTable.workspaceId, workspace.id),
    ));
    if (!existing) return res.status(404).json({ error: "Not found" });

    await db.delete(secondaryContactsTable).where(eq(secondaryContactsTable.id, id));
    return res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "Error deleting secondary contact");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
