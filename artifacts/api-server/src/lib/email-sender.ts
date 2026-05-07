import nodemailer, { type Transporter } from "nodemailer";
import { db, emailSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";

export type WorkspaceMailer = {
  send: (args: {
    to: string;
    subject: string;
    text: string;
    html?: string;
  }) => Promise<void>;
  fromAddress: string;
  provider: "gmail" | "smtp";
};

/**
 * Build a nodemailer transport for a workspace's configured email provider.
 * Returns `null` if the workspace has no usable settings (no provider chosen,
 * missing credentials, or missing from-address). Callers should fall back to
 * the platform default in that case.
 */
export async function getWorkspaceMailer(
  workspaceId: number,
  log: Logger,
): Promise<WorkspaceMailer | null> {
  const [row] = await db
    .select()
    .from(emailSettingsTable)
    .where(eq(emailSettingsTable.workspaceId, workspaceId));
  if (!row) return null;

  const fromEmail = row.fromEmail?.trim() || row.gmailEmail?.trim() || row.smtpUser?.trim();
  if (!fromEmail) return null;
  const fromName = row.fromName?.trim();
  const fromAddress = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;

  let transporter: Transporter | null = null;

  if (row.provider === "gmail") {
    if (!row.gmailEmail || !row.gmailAppPassword) return null;
    transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: row.gmailEmail, pass: row.gmailAppPassword },
    });
  } else if (row.provider === "smtp") {
    if (!row.smtpHost || !row.smtpPort) return null;
    transporter = nodemailer.createTransport({
      host: row.smtpHost,
      port: row.smtpPort,
      secure: Boolean(row.smtpSecure),
      auth: row.smtpUser && row.smtpPassword
        ? { user: row.smtpUser, pass: row.smtpPassword }
        : undefined,
    });
  }

  if (!transporter) return null;

  return {
    provider: row.provider,
    fromAddress,
    async send({ to, subject, text, html }) {
      await transporter!.sendMail({ from: fromAddress, to, subject, text, html });
      log.info({ to, subject, provider: row.provider }, "Sent workspace email");
    },
  };
}

/** Render the HTML body for a customer activation invite. */
export function renderInviteEmail(args: {
  workspaceName: string;
  inviteUrl: string;
}): { subject: string; text: string; html: string } {
  const { workspaceName, inviteUrl } = args;
  const subject = `You've been invited to ${workspaceName}`;
  const text = [
    `Hi,`,
    ``,
    `${workspaceName} has invited you to access their client portal.`,
    `Click the link below to activate your account and sign in:`,
    ``,
    inviteUrl,
    ``,
    `If you weren't expecting this, you can ignore this email.`,
  ].join("\n");
  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2937;background:#f9fafb;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a;">You're invited to ${escapeHtml(workspaceName)}</h1>
    <p style="margin:0 0 20px;line-height:1.55;color:#374151;">
      ${escapeHtml(workspaceName)} has invited you to access their client portal. Click the button below to activate your account and sign in.
    </p>
    <p style="margin:24px 0;">
      <a href="${escapeAttr(inviteUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">Activate your account</a>
    </p>
    <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Or copy and paste this link into your browser:</p>
    <p style="margin:0 0 24px;font-size:13px;word-break:break-all;"><a href="${escapeAttr(inviteUrl)}" style="color:#4f46e5;">${escapeHtml(inviteUrl)}</a></p>
    <p style="margin:0;font-size:12px;color:#9ca3af;">If you weren't expecting this email, you can safely ignore it.</p>
  </div>
</body></html>`;
  return { subject, text, html };
}

/** Render the email a customer receives when an admin replies to their request. */
export function renderRequestReplyEmail(args: {
  workspaceName: string;
  requestTitle: string;
  authorName: string;
  body: string;
  threadUrl: string;
}): { subject: string; text: string; html: string } {
  const { workspaceName, requestTitle, authorName, body, threadUrl } = args;
  const subject = `New reply on "${requestTitle}"`;
  const text = [
    `${authorName} replied to your request "${requestTitle}":`,
    ``,
    body,
    ``,
    `View the full conversation:`,
    threadUrl,
    ``,
    `— ${workspaceName}`,
  ].join("\n");
  const safeBody = escapeHtml(body).replace(/\n/g, "<br>");
  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2937;background:#f9fafb;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;">
    <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">${escapeHtml(workspaceName)}</p>
    <h1 style="margin:0 0 16px;font-size:18px;color:#0f172a;">New reply on "${escapeHtml(requestTitle)}"</h1>
    <p style="margin:0 0 8px;font-size:13px;color:#6b7280;"><strong style="color:#374151;">${escapeHtml(authorName)}</strong> wrote:</p>
    <div style="margin:0 0 24px;padding:14px 16px;background:#f3f4f6;border-radius:8px;line-height:1.55;color:#1f2937;font-size:14px;">${safeBody}</div>
    <p style="margin:24px 0;">
      <a href="${escapeAttr(threadUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">View conversation</a>
    </p>
    <p style="margin:0;font-size:12px;color:#9ca3af;">You're receiving this because you have a request open with ${escapeHtml(workspaceName)}.</p>
  </div>
</body></html>`;
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
