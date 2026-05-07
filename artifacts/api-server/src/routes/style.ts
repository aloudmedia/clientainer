import { Router } from "express";
import { db, styleSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireWorkspaceAdmin } from "../lib/auth";
import { UpdateStyleSettingsBody } from "@workspace/api-zod";

const router = Router();

function formatStyle(settings: any) {
  return {
    id: settings.id,
    companyName: settings.companyName,
    logoUrl: settings.logoUrl,
    primaryColor: settings.primaryColor,
    accentColor: settings.accentColor,
    fontFamily: settings.fontFamily,
    welcomeMessage: settings.welcomeMessage,
    supportEmail: settings.supportEmail,
    remindersEnabled: settings.remindersEnabled ?? false,
    reminderEmail: settings.reminderEmail ?? null,
    defaultLowBalanceThresholdMinutes: settings.defaultLowBalanceThresholdMinutes ?? 60,
    defaultHourlyRate: settings.defaultHourlyRate != null ? Number(settings.defaultHourlyRate) : null,
    defaultCurrency: settings.defaultCurrency ?? "USD",
    updatedAt: settings.updatedAt,
  };
}

async function getOrCreateStyleSettings(workspaceId: number) {
  const [existing] = await db.select().from(styleSettingsTable).where(eq(styleSettingsTable.workspaceId, workspaceId));
  if (existing) return existing;
  const [created] = await db.insert(styleSettingsTable).values({ workspaceId }).returning();
  return created;
}

// GET /style (workspace-scoped, admin)
router.get("/style", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const settings = await getOrCreateStyleSettings(workspace.id);
    return res.json(formatStyle(settings));
  } catch (err) {
    req.log.error({ err }, "Error getting style settings");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /style (workspace-scoped, admin only)
router.put("/style", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const body = UpdateStyleSettingsBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const existing = await getOrCreateStyleSettings(workspace.id);

    const updateData: any = { updatedAt: new Date() };
    if (body.data.companyName !== undefined) updateData.companyName = body.data.companyName;
    if (body.data.logoUrl !== undefined) updateData.logoUrl = body.data.logoUrl;
    if (body.data.primaryColor !== undefined) updateData.primaryColor = body.data.primaryColor;
    if (body.data.accentColor !== undefined) updateData.accentColor = body.data.accentColor;
    if (body.data.fontFamily !== undefined) updateData.fontFamily = body.data.fontFamily;
    if (body.data.welcomeMessage !== undefined) updateData.welcomeMessage = body.data.welcomeMessage;
    if (body.data.supportEmail !== undefined) updateData.supportEmail = body.data.supportEmail;
    if (body.data.remindersEnabled !== undefined) updateData.remindersEnabled = body.data.remindersEnabled;
    if (body.data.reminderEmail !== undefined) updateData.reminderEmail = body.data.reminderEmail;
    if (body.data.defaultLowBalanceThresholdMinutes !== undefined) updateData.defaultLowBalanceThresholdMinutes = body.data.defaultLowBalanceThresholdMinutes;
    if (body.data.defaultHourlyRate !== undefined) updateData.defaultHourlyRate = body.data.defaultHourlyRate == null ? null : String(body.data.defaultHourlyRate);
    if (body.data.defaultCurrency !== undefined) updateData.defaultCurrency = body.data.defaultCurrency;

    const [updated] = await db.update(styleSettingsTable)
      .set(updateData)
      .where(eq(styleSettingsTable.id, existing.id))
      .returning();

    return res.json(formatStyle(updated));
  } catch (err) {
    req.log.error({ err }, "Error updating style settings");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
