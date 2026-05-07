import { Router } from "express";
import { db, retainerPackagesTable, retainerGroupsTable, workspacesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireWorkspaceAdmin, loadPortalWorkspace } from "../lib/auth";
import { requirePlanCapacity } from "../lib/plan-guards";
import {
  CreatePackageBody,
  UpdatePackageParams,
  DeletePackageParams,
} from "@workspace/api-zod";

const router = Router();

function formatPackage(p: any) {
  return {
    id: p.id,
    groupId: p.groupId ?? null,
    name: p.name,
    description: p.description,
    type: p.type,
    price: Number(p.price),
    currency: p.currency,
    totalHours: p.totalHours,
    totalMinutes: p.totalMinutes,
    isActive: p.isActive,
    createdAt: p.createdAt,
  };
}

// GET /packages (workspace-scoped via X-Workspace-Slug header)
router.get("/packages", loadPortalWorkspace, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const packages = await db.select().from(retainerPackagesTable)
      .where(eq(retainerPackagesTable.workspaceId, workspace.id));
    return res.json(packages.map(formatPackage));
  } catch (err) {
    req.log.error({ err }, "Error listing packages");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /packages (admin/owner only, workspace-scoped)
router.post("/packages", requireWorkspaceAdmin, requirePlanCapacity("retainers"), async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const body = CreatePackageBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body", details: body.error });

    if (body.data.groupId != null) {
      const [group] = await db.select().from(retainerGroupsTable).where(
        and(eq(retainerGroupsTable.id, body.data.groupId), eq(retainerGroupsTable.workspaceId, workspace.id)),
      );
      if (!group) return res.status(400).json({ error: "Invalid groupId for this workspace" });
    }

    const [pkg] = await db.insert(retainerPackagesTable).values({
      workspaceId: workspace.id,
      groupId: body.data.groupId ?? null,
      name: body.data.name,
      description: body.data.description,
      type: body.data.type as any,
      price: String(body.data.price ?? 0),
      currency: body.data.currency ?? "USD",
      totalHours: body.data.totalHours,
      totalMinutes: body.data.totalMinutes ?? 0,
      isActive: body.data.isActive ?? true,
    }).returning();

    return res.status(201).json(formatPackage(pkg));
  } catch (err) {
    req.log.error({ err }, "Error creating package");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /packages/:id (workspace-scoped)
router.get("/packages/:id", loadPortalWorkspace, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const [pkg] = await db.select().from(retainerPackagesTable).where(
      and(eq(retainerPackagesTable.id, id), eq(retainerPackagesTable.workspaceId, workspace.id)),
    );
    if (!pkg) return res.status(404).json({ error: "Package not found" });

    return res.json(formatPackage(pkg));
  } catch (err) {
    req.log.error({ err }, "Error getting package");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /packages/:id (admin/owner only, workspace-scoped)
router.put("/packages/:id", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const params = UpdatePackageParams.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid params" });

    const body = CreatePackageBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const [existing] = await db.select().from(retainerPackagesTable).where(eq(retainerPackagesTable.id, params.data.id));
    if (!existing || existing.workspaceId !== workspace.id) return res.status(404).json({ error: "Package not found" });

    if (body.data.groupId != null) {
      const [group] = await db.select().from(retainerGroupsTable).where(
        and(eq(retainerGroupsTable.id, body.data.groupId), eq(retainerGroupsTable.workspaceId, workspace.id)),
      );
      if (!group) return res.status(400).json({ error: "Invalid groupId for this workspace" });
    }

    const [updated] = await db.update(retainerPackagesTable).set({
      groupId: body.data.groupId ?? null,
      name: body.data.name,
      description: body.data.description,
      type: body.data.type as any,
      price: body.data.price != null ? String(body.data.price) : existing.price,
      currency: body.data.currency ?? existing.currency,
      totalHours: body.data.totalHours,
      totalMinutes: body.data.totalMinutes ?? 0,
      isActive: body.data.isActive ?? true,
    }).where(eq(retainerPackagesTable.id, params.data.id)).returning();

    if (!updated) return res.status(404).json({ error: "Package not found" });
    return res.json(formatPackage(updated));
  } catch (err) {
    req.log.error({ err }, "Error updating package");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /packages/:id (admin/owner only, workspace-scoped)
router.delete("/packages/:id", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const params = DeletePackageParams.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid params" });

    const [existing] = await db.select().from(retainerPackagesTable).where(eq(retainerPackagesTable.id, params.data.id));
    if (!existing || existing.workspaceId !== workspace.id) return res.status(404).json({ error: "Package not found" });

    await db.delete(retainerPackagesTable).where(eq(retainerPackagesTable.id, params.data.id));
    return res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error deleting package");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
