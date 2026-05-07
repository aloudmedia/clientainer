import { Router } from "express";
import { db, emailTemplatesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireWorkspaceAdmin } from "../lib/auth";
import { UpdateEmailTemplateBody } from "@workspace/api-zod";

const router = Router();

type TemplateKey =
  | "request_new"
  | "request_open"
  | "request_working"
  | "request_closed"
  | "user_added";

const TEMPLATE_KEYS: TemplateKey[] = [
  "request_new",
  "request_open",
  "request_working",
  "request_closed",
  "user_added",
];

interface TemplateDefault {
  subject: string;
  body: string;
}

const DEFAULTS: Record<TemplateKey, TemplateDefault> = {
  request_new: {
    subject: "We received your request: {{request_title}}",
    body:
      "Hi {{customer_name}},\n\n" +
      "Thanks for sending us \"{{request_title}}\". We'll review it shortly and get started.\n\n" +
      "You can track progress here: {{request_url}}\n\n" +
      "— {{company_name}}",
  },
  request_open: {
    subject: "Your request is open: {{request_title}}",
    body:
      "Hi {{customer_name}},\n\n" +
      "Your request \"{{request_title}}\" is now open and in our queue.\n\n" +
      "View it here: {{request_url}}\n\n" +
      "— {{company_name}}",
  },
  request_working: {
    subject: "We're working on: {{request_title}}",
    body:
      "Hi {{customer_name}},\n\n" +
      "Just letting you know we've started working on \"{{request_title}}\".\n\n" +
      "Track progress: {{request_url}}\n\n" +
      "— {{company_name}}",
  },
  request_closed: {
    subject: "Closed: {{request_title}}",
    body:
      "Hi {{customer_name}},\n\n" +
      "Your request \"{{request_title}}\" is now closed.\n\n" +
      "If you need anything else, just reply to this email or open a new request.\n\n" +
      "— {{company_name}}",
  },
  user_added: {
    subject: "You've been added to {{company_name}}",
    body:
      "Hi {{user_name}},\n\n" +
      "{{added_by_name}} added you to {{company_name}}'s client portal.\n\n" +
      "Sign in here: {{portal_url}}\n\n" +
      "— {{company_name}}",
  },
};

function format(row: any) {
  return {
    id: row.id,
    templateKey: row.templateKey as TemplateKey,
    subject: row.subject,
    body: row.body,
    isEnabled: row.isEnabled,
    updatedAt: row.updatedAt,
  };
}

async function loadAll(workspaceId: number) {
  const rows = await db.select().from(emailTemplatesTable).where(eq(emailTemplatesTable.workspaceId, workspaceId));
  const byKey = new Map<TemplateKey, any>();
  rows.forEach(r => byKey.set(r.templateKey as TemplateKey, r));

  // Backfill any missing keys with their default content so the client always
  // sees a complete, editable list of templates.
  const missing = TEMPLATE_KEYS.filter(k => !byKey.has(k));
  if (missing.length > 0) {
    const inserted = await db.insert(emailTemplatesTable).values(
      missing.map(k => ({
        workspaceId,
        templateKey: k,
        subject: DEFAULTS[k].subject,
        body: DEFAULTS[k].body,
        isEnabled: true,
      })),
    ).returning();
    inserted.forEach(r => byKey.set(r.templateKey as TemplateKey, r));
  }

  return TEMPLATE_KEYS.map(k => format(byKey.get(k)));
}

// GET /email-templates (admin)
router.get("/email-templates", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const templates = await loadAll(workspace.id);
    return res.json(templates);
  } catch (err) {
    req.log.error({ err }, "Error listing email templates");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /email-templates/:key (admin)
router.put("/email-templates/:key", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const key = req.params.key as TemplateKey;
    if (!TEMPLATE_KEYS.includes(key)) {
      return res.status(400).json({ error: "Unknown template key" });
    }
    const body = UpdateEmailTemplateBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    // Ensure a row exists by loading-with-backfill before patching.
    await loadAll(workspace.id);

    const updateData: any = { updatedAt: new Date() };
    if (body.data.subject !== undefined) updateData.subject = body.data.subject;
    if (body.data.body !== undefined) updateData.body = body.data.body;
    if (body.data.isEnabled !== undefined) updateData.isEnabled = body.data.isEnabled;

    const [updated] = await db.update(emailTemplatesTable)
      .set(updateData)
      .where(and(
        eq(emailTemplatesTable.workspaceId, workspace.id),
        eq(emailTemplatesTable.templateKey, key),
      ))
      .returning();

    return res.json(format(updated));
  } catch (err) {
    req.log.error({ err }, "Error updating email template");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
