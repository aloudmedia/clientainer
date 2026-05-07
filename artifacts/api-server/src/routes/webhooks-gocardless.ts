import { Router, raw as rawBodyParser } from "express";
import { db, workspacesTable, topupsTable, subscriptionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { verifyWebhookSignature, type WebhookPayload, type WebhookEvent } from "../lib/gocardless";

const router = Router();

async function applyConfirmedTopup(topup: any) {
  if (topup.status === "confirmed") return; // idempotent

  await db.update(topupsTable).set({
    status: "confirmed",
    completedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(topupsTable.id, topup.id));

  // Credit the subscription's totalMinutes by hoursToCredit * 60
  const minutesToAdd = topup.hoursToCredit * 60;
  await db.update(subscriptionsTable)
    .set({ totalMinutes: sql`${subscriptionsTable.totalMinutes} + ${minutesToAdd}` })
    .where(eq(subscriptionsTable.id, topup.subscriptionId));
}

async function applyFailedTopup(topup: any, status: "failed" | "cancelled") {
  if (topup.status === "confirmed") return; // already credited; ignore
  await db.update(topupsTable).set({
    status,
    updatedAt: new Date(),
  }).where(eq(topupsTable.id, topup.id));
}

async function handleEvent(event: WebhookEvent, workspaceId: number) {
  // Find the topup by GC IDs in the event links
  const links = event.links ?? {};
  const gcBillingRequestId = links.billing_request;
  const gcPaymentId = links.payment;

  let topup: any | undefined;
  if (gcBillingRequestId) {
    [topup] = await db.select().from(topupsTable).where(eq(topupsTable.gcBillingRequestId, gcBillingRequestId));
  }
  if (!topup && gcPaymentId) {
    [topup] = await db.select().from(topupsTable).where(eq(topupsTable.gcPaymentId, gcPaymentId));
  }
  if (!topup || topup.workspaceId !== workspaceId) return;

  // Save GC payment id if newly seen
  if (gcPaymentId && !topup.gcPaymentId) {
    await db.update(topupsTable).set({ gcPaymentId }).where(eq(topupsTable.id, topup.id));
    topup.gcPaymentId = gcPaymentId;
  }

  if (event.resource_type === "billing_requests" && event.action === "fulfilled") {
    // Payment is on its way; confirmation usually arrives via payments.confirmed
    return;
  }
  if (event.resource_type === "payments") {
    if (event.action === "confirmed" || event.action === "paid_out") {
      await applyConfirmedTopup(topup);
    } else if (event.action === "failed" || event.action === "chargeback_settled" || event.action === "cancelled") {
      await applyFailedTopup(topup, event.action === "cancelled" ? "cancelled" : "failed");
    }
  }
}

// POST /webhooks/gocardless/:workspaceId
// We use raw body parser scoped to this route only so signature verification works.
router.post(
  "/webhooks/gocardless/:workspaceId",
  rawBodyParser({ type: "*/*", limit: "1mb" }),
  async (req, res) => {
    try {
      const workspaceId = parseInt(req.params.workspaceId as string, 10);
      if (!Number.isFinite(workspaceId)) return res.status(400).end();

      const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId));
      if (!workspace || !workspace.gocardlessWebhookSecret) {
        return res.status(404).end();
      }

      const sig = req.headers["webhook-signature"] as string | undefined;
      const rawBody = req.body as Buffer;
      const ok = verifyWebhookSignature(rawBody, sig, workspace.gocardlessWebhookSecret);
      if (!ok) {
        req.log.warn({ workspaceId }, "Invalid GoCardless webhook signature");
        return res.status(498).end();
      }

      let payload: WebhookPayload;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return res.status(400).end();
      }

      for (const event of payload.events ?? []) {
        try {
          await handleEvent(event, workspaceId);
        } catch (err) {
          req.log.error({ err, eventId: event.id }, "Error handling webhook event");
        }
      }

      return res.status(204).end();
    } catch (err) {
      req.log.error({ err }, "Webhook handler error");
      return res.status(500).end();
    }
  },
);

export default router;
