import { Router } from "express";
import { db, leadsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { requireWorkspaceAdmin, loadPortalWorkspace } from "../lib/auth";

const router = Router();

router.get("/leads", loadPortalWorkspace, requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const rows = await db.select().from(leadsTable)
      .where(eq(leadsTable.workspaceId, workspace.id))
      .orderBy(desc(leadsTable.createdAt));
    return res.json(rows.map(l => ({
      id: l.id,
      workspaceId: l.workspaceId,
      packageId: l.packageId ?? null,
      name: l.name,
      email: l.email,
      message: l.message ?? null,
      source: l.source,
      status: l.status,
      createdAt: l.createdAt.toISOString(),
    })));
  } catch (err) {
    req.log.error({ err }, "Error listing leads");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
