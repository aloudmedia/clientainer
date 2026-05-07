import { Router } from "express";
import { db, aiSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireWorkspaceAdmin } from "../lib/auth";
import { requirePlanCapacity } from "../lib/plan-guards";
import { UpdateAiSettingsBody } from "@workspace/api-zod";

const router = Router();

function format(row: any) {
  const hasFallback = Boolean(process.env.AI_INTEGRATIONS_OPENAI_API_KEY);
  const keySet = Boolean(row?.openaiApiKey);
  return {
    openaiApiKeySet: keySet,
    openaiModel: row?.openaiModel ?? null,
    usingFallback: !keySet && hasFallback,
    updatedAt: row?.updatedAt ?? null,
  };
}

async function getOrCreate(workspaceId: number) {
  const [existing] = await db.select().from(aiSettingsTable).where(eq(aiSettingsTable.workspaceId, workspaceId));
  if (existing) return existing;
  const [created] = await db.insert(aiSettingsTable).values({ workspaceId }).returning();
  return created;
}

router.get("/ai-settings", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const row = await getOrCreate(workspace.id);
    return res.json(format(row));
  } catch (err) {
    req.log.error({ err }, "Error getting AI settings");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/ai-settings", requireWorkspaceAdmin, requirePlanCapacity("integrations"), async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const body = UpdateAiSettingsBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    await getOrCreate(workspace.id);

    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (body.data.openaiApiKey !== undefined) {
      // Empty string clears the key.
      updateData.openaiApiKey = body.data.openaiApiKey ? body.data.openaiApiKey : null;
    }
    if (body.data.openaiModel !== undefined) {
      updateData.openaiModel = body.data.openaiModel || null;
    }

    const [updated] = await db.update(aiSettingsTable)
      .set(updateData)
      .where(eq(aiSettingsTable.workspaceId, workspace.id))
      .returning();

    return res.json(format(updated));
  } catch (err) {
    req.log.error({ err }, "Error updating AI settings");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
