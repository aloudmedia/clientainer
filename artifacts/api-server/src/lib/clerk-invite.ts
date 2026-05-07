import { clerkClient } from "@clerk/express";
import type { Request } from "express";
import type { Logger } from "pino";
import { getWorkspaceMailer, renderInviteEmail } from "./email-sender";

/**
 * Returns the trusted public origin to use when building Clerk invite
 * redirect URLs. Clerk only allows the recipient to be redirected to the
 * URL we hand it, so this MUST come from a server-controlled allowlist —
 * never from a caller-supplied header — to avoid open-redirect abuse in
 * invitation emails.
 *
 * Resolution order:
 *   1. `APP_PUBLIC_URL` env (explicit override),
 *   2. The first entry of `REPLIT_DOMAINS` (the canonical published host),
 *   3. The request `Origin` ONLY if its host matches one of `REPLIT_DOMAINS`,
 *   4. `http://localhost` as a last-resort dev fallback.
 */
function resolvePublicOrigin(req: Request): string {
  const explicit = process.env.APP_PUBLIC_URL?.trim();
  if (explicit && /^https?:\/\//.test(explicit)) {
    return explicit.replace(/\/$/, "");
  }
  const allowedHosts = (process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  if (allowedHosts.length > 0) {
    const reqOrigin = req.headers.origin;
    if (typeof reqOrigin === "string" && /^https?:\/\//.test(reqOrigin)) {
      try {
        const host = new URL(reqOrigin).host;
        if (allowedHosts.includes(host)) {
          return reqOrigin.replace(/\/$/, "");
        }
      } catch {
        // fall through to canonical default
      }
    }
    return `https://${allowedHosts[0]}`;
  }
  return "http://localhost";
}

/**
 * Sends a Clerk invitation email to a newly-created (or pending) customer.
 * The email contains a sign-up link where the recipient can either set a
 * password or sign up with Google (whichever providers are enabled in the
 * Clerk dashboard).
 *
 * Best-effort: callers should treat failures as non-fatal and log them.
 * Returns the Clerk invitation id on success, or throws on failure.
 */
export async function sendCustomerInvite(args: {
  req: Request;
  email: string;
  workspaceSlug: string;
  workspaceId?: number;
  workspaceName?: string;
  log: Logger;
}): Promise<{ invitationId: string; redirectUrl: string; sentVia: "workspace" | "clerk" }> {
  const { req, email, workspaceSlug, workspaceId, workspaceName, log } = args;
  const origin = resolvePublicOrigin(req);
  const redirectUrl = `${origin}/${workspaceSlug}`;

  // Try to send via the workspace's own email transport (Gmail / SMTP) so the
  // invite arrives from the agency's address. Falls back to having Clerk send
  // its default email if the workspace hasn't configured an email provider.
  const mailer = workspaceId != null
    ? await getWorkspaceMailer(workspaceId, log).catch((err) => {
        log.warn({ err, workspaceId }, "Could not load workspace mailer");
        return null;
      })
    : null;

  try {
    const invitation = await clerkClient.invitations.createInvitation({
      emailAddress: email,
      redirectUrl,
      ignoreExisting: true,
      publicMetadata: { workspaceSlug, role: "customer" },
      // When a workspace mailer is available, suppress Clerk's email and we
      // deliver the activation link ourselves via the workspace transport.
      notify: mailer ? false : true,
    });

    if (mailer) {
      // Silent path: Clerk did NOT send (notify:false). We must deliver the
      // link ourselves OR fall back to a Clerk-delivered invite — never both
      // skipped, otherwise the customer gets nothing.
      let mailFailureReason: unknown = null;
      if (!invitation.url) {
        mailFailureReason = new Error("Clerk did not return an invitation url");
      } else {
        try {
          const body = renderInviteEmail({
            workspaceName: workspaceName ?? workspaceSlug,
            inviteUrl: invitation.url,
          });
          await mailer.send({ to: email, ...body });
          log.info(
            { email, workspaceSlug, invitationId: invitation.id, provider: mailer.provider },
            "Sent customer invite via workspace email",
          );
          return { invitationId: invitation.id, redirectUrl, sentVia: "workspace" };
        } catch (mailErr) {
          mailFailureReason = mailErr;
        }
      }

      // Workspace delivery failed (no url, or send threw). Revoke the silent
      // invitation and re-create one that Clerk delivers itself, so the
      // recipient always receives an email.
      log.warn(
        { err: mailFailureReason, email, workspaceSlug, invitationId: invitation.id },
        "Workspace email delivery failed; falling back to Clerk-delivered invite",
      );
      try {
        await clerkClient.invitations.revokeInvitation(invitation.id);
      } catch (revokeErr) {
        log.warn({ err: revokeErr, invitationId: invitation.id }, "Failed to revoke silent invitation");
      }
      const fallback = await clerkClient.invitations.createInvitation({
        emailAddress: email,
        redirectUrl,
        ignoreExisting: true,
        publicMetadata: { workspaceSlug, role: "customer" },
        notify: true,
      });
      log.info({ email, workspaceSlug, invitationId: fallback.id }, "Sent Clerk invitation (fallback)");
      return { invitationId: fallback.id, redirectUrl, sentVia: "clerk" };
    }

    log.info({ email, workspaceSlug, invitationId: invitation.id }, "Sent Clerk invitation");
    return { invitationId: invitation.id, redirectUrl, sentVia: "clerk" };
  } catch (err) {
    log.warn({ err, email, workspaceSlug }, "Failed to send Clerk invitation");
    throw err;
  }
}
