import { Router } from "express";
import { db, retainerGroupsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireWorkspaceAdmin, loadPortalWorkspace } from "../lib/auth";
import { CreateRetainerGroupBody } from "@workspace/api-zod";

const router = Router();

function formatGroup(g: any) {
  return {
    id: g.id,
    name: g.name,
    description: g.description ?? null,
    color: g.color ?? null,
    createdAt: g.createdAt,
  };
}

// GET /retainer-groups
router.get("/retainer-groups", loadPortalWorkspace, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const rows = await db.select().from(retainerGroupsTable)
      .where(eq(retainerGroupsTable.workspaceId, workspace.id));
    return res.json(rows.map(formatGroup));
  } catch (err) {
    req.log.error({ err }, "Error listing retainer groups");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /retainer-groups
router.post("/retainer-groups", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const body = CreateRetainerGroupBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body", details: body.error });

    const [row] = await db.insert(retainerGroupsTable).values({
      workspaceId: workspace.id,
      name: body.data.name,
      description: body.data.description ?? null,
      color: body.data.color ?? null,
    }).returning();

    return res.status(201).json(formatGroup(row));
  } catch (err) {
    req.log.error({ err }, "Error creating retainer group");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /retainer-groups/:id
router.put("/retainer-groups/:id", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const body = CreateRetainerGroupBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const [existing] = await db.select().from(retainerGroupsTable)
      .where(and(eq(retainerGroupsTable.id, id), eq(retainerGroupsTable.workspaceId, workspace.id)));
    if (!existing) return res.status(404).json({ error: "Group not found" });

    const [updated] = await db.update(retainerGroupsTable).set({
      name: body.data.name,
      description: body.data.description ?? null,
      color: body.data.color ?? null,
    }).where(eq(retainerGroupsTable.id, id)).returning();

    return res.json(formatGroup(updated));
  } catch (err) {
    req.log.error({ err }, "Error updating retainer group");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /retainer-groups/:id
router.delete("/retainer-groups/:id", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const [existing] = await db.select().from(retainerGroupsTable)
      .where(and(eq(retainerGroupsTable.id, id), eq(retainerGroupsTable.workspaceId, workspace.id)));
    if (!existing) return res.status(404).json({ error: "Group not found" });

    await db.delete(retainerGroupsTable).where(eq(retainerGroupsTable.id, id));
    return res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error deleting retainer group");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
