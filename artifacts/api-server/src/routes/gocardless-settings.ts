import { Router } from "express";
import { db, workspacesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../lib/auth";
import { requirePlanCapacityForSlug } from "../lib/plan-guards";
import { UpdateGocardlessSettingsBody } from "@workspace/api-zod";

const router = Router();

function publicWebhookUrl(req: any, workspaceId: number): string {
  const host = (process.env.REPLIT_DOMAINS?.split(",")[0]?.trim()) || req.get("host");
  const protocol = host?.includes("localhost") ? "http" : "https";
  return `${protocol}://${host}/api/webhooks/gocardless/${workspaceId}`;
}

function settingsResponse(req: any, ws: any) {
  return {
    connected: Boolean(ws.gocardlessAccessToken),
    environment: ws.gocardlessEnvironment ?? "sandbox",
    tokenLast4: ws.gocardlessAccessToken ? ws.gocardlessAccessToken.slice(-4) : null,
    webhookSecretSet: Boolean(ws.gocardlessWebhookSecret),
    webhookUrl: publicWebhookUrl(req, ws.id),
  };
}

async function loadOwnedWorkspace(req: any, res: any) {
  const slug = (req.params.slug as string).toLowerCase();
  const dbUser = (req as any).dbUser;
  const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.slug, slug));
  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return null;
  }
  if (workspace.ownerId !== dbUser.id) {
    res.status(403).json({ error: "You do not own this workspace" });
    return null;
  }
  return workspace;
}

// GET /workspaces/:slug/gocardless
router.get("/workspaces/:slug/gocardless", requireAdmin, async (req, res) => {
  try {
    const ws = await loadOwnedWorkspace(req, res);
    if (!ws) return;
    return res.json(settingsResponse(req, ws));
  } catch (err) {
    req.log.error({ err }, "Error reading gocardless settings");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /workspaces/:slug/gocardless
router.put("/workspaces/:slug/gocardless", requireAdmin, requirePlanCapacityForSlug("integrations"), async (req, res) => {
  try {
    const ws = await loadOwnedWorkspace(req, res);
    if (!ws) return;

    const body = UpdateGocardlessSettingsBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const updateData: any = {};
    if (body.data.accessToken !== undefined) {
      const tok = body.data.accessToken?.trim();
      updateData.gocardlessAccessToken = tok ? tok : null;
    }
    if (body.data.environment !== undefined) updateData.gocardlessEnvironment = body.data.environment;
    if (body.data.webhookSecret !== undefined) {
      const sec = body.data.webhookSecret?.trim();
      updateData.gocardlessWebhookSecret = sec ? sec : null;
    }

    if (Object.keys(updateData).length === 0) {
      return res.json(settingsResponse(req, ws));
    }

    const [updated] = await db.update(workspacesTable)
      .set(updateData)
      .where(eq(workspacesTable.id, ws.id))
      .returning();

    return res.json(settingsResponse(req, updated));
  } catch (err) {
    req.log.error({ err }, "Error updating gocardless settings");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /workspaces/:slug/gocardless
router.delete("/workspaces/:slug/gocardless", requireAdmin, async (req, res) => {
  try {
    const ws = await loadOwnedWorkspace(req, res);
    if (!ws) return;

    await db.update(workspacesTable)
      .set({
        gocardlessAccessToken: null,
        gocardlessWebhookSecret: null,
      })
      .where(eq(workspacesTable.id, ws.id));

    return res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "Error disconnecting gocardless");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
