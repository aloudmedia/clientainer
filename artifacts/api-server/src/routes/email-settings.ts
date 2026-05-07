import { Router } from "express";
import { db, emailSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireWorkspaceAdmin } from "../lib/auth";
import { UpdateEmailSettingsBody } from "@workspace/api-zod";

const router = Router();

function format(row: any) {
  return {
    provider: row.provider,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
    gmailEmail: row.gmailEmail,
    gmailAppPasswordSet: Boolean(row.gmailAppPassword),
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpUser: row.smtpUser,
    smtpPasswordSet: Boolean(row.smtpPassword),
    smtpSecure: row.smtpSecure,
    pop3Host: row.pop3Host,
    pop3Port: row.pop3Port,
    pop3User: row.pop3User,
    pop3PasswordSet: Boolean(row.pop3Password),
    pop3Secure: row.pop3Secure,
    updatedAt: row.updatedAt,
  };
}

async function getOrCreate(workspaceId: number) {
  const [existing] = await db.select().from(emailSettingsTable).where(eq(emailSettingsTable.workspaceId, workspaceId));
  if (existing) return existing;
  const [created] = await db.insert(emailSettingsTable).values({ workspaceId }).returning();
  return created;
}

router.get("/email-settings", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const row = await getOrCreate(workspace.id);
    return res.json(format(row));
  } catch (err) {
    req.log.error({ err }, "Error getting email settings");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/email-settings", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const body = UpdateEmailSettingsBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    await getOrCreate(workspace.id);

    const updateData: Record<string, any> = { updatedAt: new Date() };
    const d = body.data;
    if (d.provider !== undefined) updateData.provider = d.provider;
    if (d.fromEmail !== undefined) updateData.fromEmail = d.fromEmail;
    if (d.fromName !== undefined) updateData.fromName = d.fromName;
    if (d.gmailEmail !== undefined) updateData.gmailEmail = d.gmailEmail;
    // Empty string clears the password; undefined leaves it unchanged.
    if (d.gmailAppPassword !== undefined) updateData.gmailAppPassword = d.gmailAppPassword || null;
    if (d.smtpHost !== undefined) updateData.smtpHost = d.smtpHost;
    if (d.smtpPort !== undefined) updateData.smtpPort = d.smtpPort;
    if (d.smtpUser !== undefined) updateData.smtpUser = d.smtpUser;
    if (d.smtpPassword !== undefined) updateData.smtpPassword = d.smtpPassword || null;
    if (d.smtpSecure !== undefined) updateData.smtpSecure = d.smtpSecure;
    if (d.pop3Host !== undefined) updateData.pop3Host = d.pop3Host;
    if (d.pop3Port !== undefined) updateData.pop3Port = d.pop3Port;
    if (d.pop3User !== undefined) updateData.pop3User = d.pop3User;
    if (d.pop3Password !== undefined) updateData.pop3Password = d.pop3Password || null;
    if (d.pop3Secure !== undefined) updateData.pop3Secure = d.pop3Secure;

    const [updated] = await db.update(emailSettingsTable)
      .set(updateData)
      .where(eq(emailSettingsTable.workspaceId, workspace.id))
      .returning();

    return res.json(format(updated));
  } catch (err) {
    req.log.error({ err }, "Error updating email settings");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
