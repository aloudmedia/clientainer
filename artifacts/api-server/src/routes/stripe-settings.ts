import { Router } from "express";
import { db, workspacesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../lib/auth";
import { requirePlanCapacityForSlug } from "../lib/plan-guards";
import { UpdateStripeSettingsBody } from "@workspace/api-zod";

const router = Router();

function publicWebhookUrl(req: any, workspaceId: number): string {
  // Always prefer REPLIT_DOMAINS (canonical published host). Only fall back to
  // the request's own host header in dev — using it in prod would let an
  // attacker who controls Host show the workspace owner a malicious URL.
  const replitHost = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  let host: string | undefined = replitHost;
  if (!host && process.env.NODE_ENV !== "production") {
    host = req.get("host");
  }
  if (!host) {
    // Last-resort placeholder so the UI still renders something sensible.
    host = "your-app.replit.app";
  }
  const protocol = host.includes("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";
  return `${protocol}://${host}/api/webhooks/stripe/${workspaceId}`;
}

function settingsResponse(req: any, ws: any) {
  return {
    connected: Boolean(ws.stripeSecretKey),
    secretKeyLast4: ws.stripeSecretKey ? ws.stripeSecretKey.slice(-4) : null,
    publishableKey: ws.stripePublishableKey ?? null,
    webhookSecretSet: Boolean(ws.stripeWebhookSecret),
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

// GET /workspaces/:slug/stripe
router.get("/workspaces/:slug/stripe", requireAdmin, async (req, res) => {
  try {
    const ws = await loadOwnedWorkspace(req, res);
    if (!ws) return;
    return res.json(settingsResponse(req, ws));
  } catch (err) {
    req.log.error({ err }, "Error reading stripe settings");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /workspaces/:slug/stripe
router.put("/workspaces/:slug/stripe", requireAdmin, requirePlanCapacityForSlug("integrations"), async (req, res) => {
  try {
    const ws = await loadOwnedWorkspace(req, res);
    if (!ws) return;

    const body = UpdateStripeSettingsBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const updateData: any = {};
    if (body.data.secretKey !== undefined) {
      const tok = body.data.secretKey?.trim();
      updateData.stripeSecretKey = tok ? tok : null;
    }
    if (body.data.publishableKey !== undefined) {
      const pk = body.data.publishableKey?.trim();
      updateData.stripePublishableKey = pk ? pk : null;
    }
    if (body.data.webhookSecret !== undefined) {
      const sec = body.data.webhookSecret?.trim();
      updateData.stripeWebhookSecret = sec ? sec : null;
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
    req.log.error({ err }, "Error updating stripe settings");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /workspaces/:slug/stripe
router.delete("/workspaces/:slug/stripe", requireAdmin, async (req, res) => {
  try {
    const ws = await loadOwnedWorkspace(req, res);
    if (!ws) return;

    await db.update(workspacesTable)
      .set({
        stripeSecretKey: null,
        stripePublishableKey: null,
        stripeWebhookSecret: null,
      })
      .where(eq(workspacesTable.id, ws.id));

    return res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "Error disconnecting stripe");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
