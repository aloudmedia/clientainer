import { Router } from "express";
import { db, requestsTable, subscriptionsTable, usersTable, requestMessagesTable, requestMessageReactionsTable, workspacesTable } from "@workspace/db";
import { eq, and, asc, inArray, sql } from "drizzle-orm";
import { requireWorkspaceAdmin, loadPortalWorkspace, loadDbUser, resolvePortalIdentity } from "../lib/auth";
import { requirePlanCapacity } from "../lib/plan-guards";
import { getWorkspaceMailer, renderRequestReplyEmail } from "../lib/email-sender";
import {
  CreateRequestBody,
  ListRequestsQueryParams,
  GetRequestParams,
  UpdateRequestParams,
  UpdateRequestBody,
  CreateRequestMessageBody,
  ToggleRequestMessageReactionBody,
} from "@workspace/api-zod";

const REACTION_EMOJIS = ["completed", "smile", "sad", "wow", "love"] as const;
type ReactionEmoji = typeof REACTION_EMOJIS[number];

/** Aggregate reactions for a set of message ids into an emoji→{count, mine} map. */
async function loadReactionsForMessages(
  messageIds: number[],
  callerUserId: number,
): Promise<Map<number, { emoji: ReactionEmoji; count: number; mine: boolean }[]>> {
  const out = new Map<number, { emoji: ReactionEmoji; count: number; mine: boolean }[]>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select({
      messageId: requestMessageReactionsTable.messageId,
      emoji: requestMessageReactionsTable.emoji,
      userId: requestMessageReactionsTable.userId,
    })
    .from(requestMessageReactionsTable)
    .where(inArray(requestMessageReactionsTable.messageId, messageIds));
  // Group by message+emoji; track whether the caller appears in the bucket.
  const buckets = new Map<string, { messageId: number; emoji: ReactionEmoji; count: number; mine: boolean }>();
  for (const r of rows) {
    if (!REACTION_EMOJIS.includes(r.emoji as ReactionEmoji)) continue;
    const key = `${r.messageId}::${r.emoji}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      if (r.userId === callerUserId) existing.mine = true;
    } else {
      buckets.set(key, { messageId: r.messageId, emoji: r.emoji as ReactionEmoji, count: 1, mine: r.userId === callerUserId });
    }
  }
  for (const b of buckets.values()) {
    const list = out.get(b.messageId) ?? [];
    list.push({ emoji: b.emoji, count: b.count, mine: b.mine });
    out.set(b.messageId, list);
  }
  return out;
}

const router = Router();

function formatRequestRecord(r: any, customer?: any) {
  const lastAt = r.lastMessageAt ? new Date(r.lastMessageAt).getTime() : null;
  const adminRead = r.adminLastReadAt ? new Date(r.adminLastReadAt).getTime() : null;
  const custRead = r.customerLastReadAt ? new Date(r.customerLastReadAt).getTime() : null;
  const unreadByAdmin = !!(lastAt && r.lastMessageByRole === "customer" && (!adminRead || adminRead < lastAt));
  const unreadByCustomer = !!(
    lastAt &&
    (r.lastMessageByRole === "admin" || r.lastMessageByRole === "owner") &&
    (!custRead || custRead < lastAt)
  );
  return {
    id: r.id,
    customerId: r.customerId,
    subscriptionId: r.subscriptionId,
    title: r.title,
    description: r.description,
    status: r.status,
    estimatedMinutes: r.estimatedMinutes,
    usedMinutes: r.usedMinutes,
    formSubmissionData: r.formSubmissionData ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastMessageAt: r.lastMessageAt ?? null,
    unreadByAdmin,
    unreadByCustomer,
    customer: customer
      ? { id: customer.id, clerkUserId: customer.clerkUserId, email: customer.email, name: customer.name, role: customer.role, createdAt: customer.createdAt }
      : undefined,
  };
}

/**
 * Resolve the request and verify the caller can access it. Returns the request
 * row and the caller's "side" (admin = workspace admin/owner, customer = the
 * request's primary customer or a permitted secondary contact). Sends the
 * proper HTTP error and returns null if not authorized.
 */
async function loadAccessibleRequest(req: any, res: any, requestId: number): Promise<
  | { request: any; side: "admin" | "customer" }
  | null
> {
  const dbUser = req.dbUser;
  const workspace = req.workspace;
  const [request] = await db.select().from(requestsTable).where(eq(requestsTable.id, requestId));
  if (!request || request.workspaceId !== workspace.id) {
    res.status(404).json({ error: "Request not found" });
    return null;
  }
  if (dbUser.role === "admin" || dbUser.role === "owner") {
    if (workspace.ownerId !== dbUser.id && dbUser.role !== "owner") {
      res.status(403).json({ error: "Forbidden" });
      return null;
    }
    return { request, side: "admin" };
  }
  const identity = await resolvePortalIdentity(dbUser, workspace.id);
  if (
    identity.kind === "none" ||
    !identity.canAccessRequests ||
    identity.effectiveCustomerId === null ||
    request.customerId !== identity.effectiveCustomerId
  ) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return { request, side: "customer" };
}

function buildPublicOrigin(): string {
  const explicit = process.env.APP_PUBLIC_URL?.trim();
  if (explicit && /^https?:\/\//.test(explicit)) return explicit.replace(/\/$/, "");
  const first = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (first) return `https://${first}`;
  return "http://localhost";
}

async function formatRequest(r: any) {
  const [customer] = await db.select().from(usersTable).where(eq(usersTable.id, r.customerId));
  return formatRequestRecord(r, customer);
}

// GET /requests (workspace-scoped)
router.get("/requests", loadPortalWorkspace, loadDbUser, async (req, res) => {
  try {
    const dbUser = (req as any).dbUser;
    const workspace = (req as any).workspace;
    const query = ListRequestsQueryParams.safeParse(req.query);
    const params = query.success ? query.data : {};

    let reqs;
    if (dbUser.role === "admin" || dbUser.role === "owner") {
      if (workspace.ownerId !== dbUser.id && dbUser.role !== "owner") return res.status(403).json({ error: "Forbidden" });
      if (params.customerId) {
        reqs = await db.select().from(requestsTable).where(
          and(eq(requestsTable.customerId, params.customerId), eq(requestsTable.workspaceId, workspace.id))
        );
      } else if (params.subscriptionId) {
        reqs = await db.select().from(requestsTable).where(
          and(eq(requestsTable.subscriptionId, params.subscriptionId), eq(requestsTable.workspaceId, workspace.id))
        );
      } else {
        reqs = await db.select().from(requestsTable).where(eq(requestsTable.workspaceId, workspace.id));
      }
    } else {
      const identity = await resolvePortalIdentity(dbUser, workspace.id);
      if (identity.kind === "none" || !identity.canAccessRequests || identity.effectiveCustomerId === null) {
        return res.status(403).json({ error: "No request access" });
      }
      reqs = await db.select().from(requestsTable).where(
        and(eq(requestsTable.customerId, identity.effectiveCustomerId), eq(requestsTable.workspaceId, workspace.id))
      );
    }

    if (params.status) {
      reqs = reqs.filter(r => r.status === params.status);
    }

    const formatted = await Promise.all(reqs.map(formatRequest));
    return res.json(formatted);
  } catch (err) {
    req.log.error({ err }, "Error listing requests");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /requests (workspace-scoped)
router.post("/requests", loadPortalWorkspace, loadDbUser, requirePlanCapacity("requests"), async (req, res) => {
  try {
    const dbUser = (req as any).dbUser;
    const workspace = (req as any).workspace;
    const body = CreateRequestBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const [sub] = await db.select().from(subscriptionsTable).where(
      and(eq(subscriptionsTable.id, body.data.subscriptionId), eq(subscriptionsTable.workspaceId, workspace.id))
    );
    if (!sub) return res.status(404).json({ error: "Subscription not found" });

    let effectiveCustomerId = dbUser.id;
    if (dbUser.role !== "admin" && dbUser.role !== "owner") {
      const identity = await resolvePortalIdentity(dbUser, workspace.id);
      if (identity.kind === "none" || !identity.canAccessRequests || identity.effectiveCustomerId === null) {
        return res.status(403).json({ error: "No request access" });
      }
      if (sub.customerId !== identity.effectiveCustomerId) {
        return res.status(403).json({ error: "Forbidden" });
      }
      effectiveCustomerId = identity.effectiveCustomerId;
    } else {
      if (workspace.ownerId !== dbUser.id && dbUser.role !== "owner") return res.status(403).json({ error: "Forbidden" });
      effectiveCustomerId = sub.customerId;
    }

    // Enforce minimum minutes per request
    const minMinutes = sub.minimumMinutesPerRequest ?? 0;
    const remainingMinutes = sub.totalMinutes - sub.usedMinutes;

    if (sub.totalMinutes < 999999 && remainingMinutes <= 0) {
      return res.status(422).json({ error: "Insufficient time balance in your retainer" });
    }

    if (minMinutes > 0 && sub.totalMinutes < 999999 && remainingMinutes < minMinutes) {
      return res.status(422).json({
        error: `Insufficient balance. This subscription requires a minimum of ${minMinutes} minutes per request.`,
      });
    }

    const [request] = await db.insert(requestsTable).values({
      workspaceId: workspace.id,
      customerId: effectiveCustomerId,
      subscriptionId: body.data.subscriptionId,
      title: body.data.title,
      description: body.data.description,
      estimatedMinutes: body.data.estimatedMinutes ?? null,
      usedMinutes: 0,
      status: "pending",
      formSubmissionData: body.data.formSubmissionData ?? null,
    }).returning();

    return res.status(201).json(await formatRequest(request));
  } catch (err) {
    req.log.error({ err }, "Error creating request");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /requests/:id
router.get("/requests/:id", loadPortalWorkspace, loadDbUser, async (req, res) => {
  try {
    const params = GetRequestParams.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid params" });

    const dbUser = (req as any).dbUser;
    const workspace = (req as any).workspace;
    const [request] = await db.select().from(requestsTable).where(eq(requestsTable.id, params.data.id));
    if (!request) return res.status(404).json({ error: "Request not found" });

    if (request.workspaceId !== workspace.id) return res.status(404).json({ error: "Request not found" });

    if (dbUser.role !== "admin" && dbUser.role !== "owner") {
      const identity = await resolvePortalIdentity(dbUser, workspace.id);
      if (identity.kind === "none" || !identity.canAccessRequests || request.customerId !== identity.effectiveCustomerId) {
        return res.status(403).json({ error: "Forbidden" });
      }
    } else if (workspace.ownerId !== dbUser.id && dbUser.role !== "owner") {
      return res.status(403).json({ error: "Forbidden" });
    }

    return res.json(await formatRequest(request));
  } catch (err) {
    req.log.error({ err }, "Error getting request");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /requests/:id (admin/owner only, workspace-scoped)
router.patch("/requests/:id", requireWorkspaceAdmin, async (req, res) => {
  try {
    const params = UpdateRequestParams.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid params" });

    const body = UpdateRequestBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const workspace = (req as any).workspace;
    const [existing] = await db.select().from(requestsTable).where(
      and(eq(requestsTable.id, params.data.id), eq(requestsTable.workspaceId, workspace.id))
    );
    if (!existing) return res.status(404).json({ error: "Request not found" });

    const updateData: any = { updatedAt: new Date() };
    if (body.data.status !== undefined) updateData.status = body.data.status;
    if (body.data.estimatedMinutes !== undefined) updateData.estimatedMinutes = body.data.estimatedMinutes;

    if (body.data.usedMinutes !== undefined) {
      updateData.usedMinutes = body.data.usedMinutes;
      const minutesDiff = body.data.usedMinutes - existing.usedMinutes;
      if (minutesDiff !== 0) {
        const [sub] = await db.select().from(subscriptionsTable).where(
          and(eq(subscriptionsTable.id, existing.subscriptionId), eq(subscriptionsTable.workspaceId, workspace.id))
        );
        if (sub) {
          await db.update(subscriptionsTable)
            .set({ usedMinutes: Math.max(0, sub.usedMinutes + minutesDiff) })
            .where(and(eq(subscriptionsTable.id, sub.id), eq(subscriptionsTable.workspaceId, workspace.id)));
        }
      }
    }

    const [updated] = await db.update(requestsTable)
      .set(updateData)
      .where(and(eq(requestsTable.id, params.data.id), eq(requestsTable.workspaceId, workspace.id)))
      .returning();

    return res.json(await formatRequest(updated));
  } catch (err) {
    req.log.error({ err }, "Error updating request");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─── REPLIES / MESSAGES ─────────────────────────────────────────────────────

// GET /requests/:id/messages — both admin and the request's customer can read
router.get("/requests/:id/messages", loadPortalWorkspace, loadDbUser, async (req, res) => {
  try {
    const params = GetRequestParams.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid params" });
    const access = await loadAccessibleRequest(req as any, res, params.data.id);
    if (!access) return;

    const rows = await db.select({
      id: requestMessagesTable.id,
      requestId: requestMessagesTable.requestId,
      authorUserId: requestMessagesTable.authorUserId,
      authorRole: requestMessagesTable.authorRole,
      body: requestMessagesTable.body,
      createdAt: requestMessagesTable.createdAt,
      authorName: usersTable.name,
      authorEmail: usersTable.email,
    })
      .from(requestMessagesTable)
      .leftJoin(usersTable, eq(usersTable.id, requestMessagesTable.authorUserId))
      .where(eq(requestMessagesTable.requestId, params.data.id))
      .orderBy(asc(requestMessagesTable.createdAt))
      // Hard cap to keep payloads bounded. Threads in this product are short-form
      // (admin↔client back-and-forth on a single request), so 500 is well above
      // any realistic ceiling. If a thread ever exceeds this, we'll add cursor
      // pagination — until then keep the contract simple.
      .limit(500);

    const reactionsByMessage = await loadReactionsForMessages(
      rows.map(r => r.id),
      (req as any).dbUser.id,
    );

    return res.json(rows.map(r => ({ ...r, reactions: reactionsByMessage.get(r.id) ?? [] })));
  } catch (err) {
    req.log.error({ err }, "Error listing request messages");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /requests/:id/messages — either side can post
router.post("/requests/:id/messages", loadPortalWorkspace, loadDbUser, async (req, res) => {
  try {
    const params = GetRequestParams.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid params" });
    const body = CreateRequestMessageBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const access = await loadAccessibleRequest(req as any, res, params.data.id);
    if (!access) return;

    const dbUser = (req as any).dbUser;
    const workspace = (req as any).workspace;
    const authorRole: "admin" | "owner" | "customer" =
      access.side === "admin" ? (dbUser.role === "owner" ? "owner" : "admin") : "customer";

    const now = new Date();
    const [message] = await db.insert(requestMessagesTable).values({
      workspaceId: workspace.id,
      requestId: access.request.id,
      authorUserId: dbUser.id,
      authorRole,
      body: body.data.body,
    }).returning();

    // Denormalize last-message metadata + auto-mark the author's side as read.
    const updateData: any = {
      lastMessageAt: now,
      lastMessageByRole: authorRole,
      updatedAt: now,
    };
    if (access.side === "admin") updateData.adminLastReadAt = now;
    else updateData.customerLastReadAt = now;
    await db.update(requestsTable).set(updateData).where(eq(requestsTable.id, access.request.id));

    // When the admin replies, email the customer (best-effort, never fails the request).
    if (access.side === "admin") {
      void (async () => {
        try {
          const [customer] = await db.select().from(usersTable).where(eq(usersTable.id, access.request.customerId));
          if (!customer?.email) return;
          const mailer = await getWorkspaceMailer(workspace.id, req.log);
          if (!mailer) {
            req.log.info(
              { workspaceId: workspace.id, requestId: access.request.id },
              "Skipping reply email: workspace has no mailer configured",
            );
            return;
          }
          const threadUrl = `${buildPublicOrigin()}/${workspace.slug}/requests`;
          const email = renderRequestReplyEmail({
            workspaceName: workspace.name,
            requestTitle: access.request.title,
            authorName: dbUser.name || dbUser.email || "Your account manager",
            body: body.data.body,
            threadUrl,
          });
          await mailer.send({ to: customer.email, ...email });
        } catch (mailErr) {
          req.log.warn({ err: mailErr, requestId: access.request.id }, "Failed to send reply email");
        }
      })();
    }

    return res.status(201).json({
      id: message.id,
      requestId: message.requestId,
      authorUserId: message.authorUserId,
      authorRole: message.authorRole,
      authorName: dbUser.name ?? null,
      authorEmail: dbUser.email ?? null,
      body: message.body,
      createdAt: message.createdAt,
    });
  } catch (err) {
    req.log.error({ err }, "Error creating request message");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /requests/:id/messages/:messageId/reactions — toggle a reaction
router.post("/requests/:id/messages/:messageId/reactions", loadPortalWorkspace, loadDbUser, async (req, res) => {
  try {
    const requestId = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    if (!Number.isFinite(requestId) || !Number.isFinite(messageId)) {
      return res.status(400).json({ error: "Invalid params" });
    }
    const body = ToggleRequestMessageReactionBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const access = await loadAccessibleRequest(req as any, res, requestId);
    if (!access) return;

    // Verify the message actually belongs to this request (defense in depth).
    const [msg] = await db
      .select({ id: requestMessagesTable.id })
      .from(requestMessagesTable)
      .where(and(eq(requestMessagesTable.id, messageId), eq(requestMessagesTable.requestId, requestId)));
    if (!msg) return res.status(404).json({ error: "Message not found" });

    const dbUser = (req as any).dbUser;
    const emoji = body.data.emoji;

    // Toggle atomically. Without serialization, two concurrent toggles for the
    // same (message, user, emoji) can collapse into the wrong final state
    // (e.g. off→off instead of off→on→off). We serialize per-key with a
    // Postgres transaction-scoped advisory lock keyed on a stable hash of
    // (messageId, userId, emoji) so concurrent toggles run sequentially.
    await db.transaction(async (tx) => {
      const lockKey = `rxn:${messageId}:${dbUser.id}:${emoji}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0))`);
      const existing = await tx
        .select({ id: requestMessageReactionsTable.id })
        .from(requestMessageReactionsTable)
        .where(
          and(
            eq(requestMessageReactionsTable.messageId, messageId),
            eq(requestMessageReactionsTable.userId, dbUser.id),
            eq(requestMessageReactionsTable.emoji, emoji),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        await tx
          .delete(requestMessageReactionsTable)
          .where(eq(requestMessageReactionsTable.id, existing[0].id));
      } else {
        await tx
          .insert(requestMessageReactionsTable)
          .values({ messageId, userId: dbUser.id, emoji });
      }
    });

    const map = await loadReactionsForMessages([messageId], dbUser.id);
    return res.json(map.get(messageId) ?? []);
  } catch (err) {
    req.log.error({ err }, "Error toggling reaction");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /requests/:id/mark-read — stamps the caller's side as read
router.post("/requests/:id/mark-read", loadPortalWorkspace, loadDbUser, async (req, res) => {
  try {
    const params = GetRequestParams.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid params" });
    const access = await loadAccessibleRequest(req as any, res, params.data.id);
    if (!access) return;

    const now = new Date();
    const updateData: any = { updatedAt: now };
    if (access.side === "admin") updateData.adminLastReadAt = now;
    else updateData.customerLastReadAt = now;
    await db.update(requestsTable).set(updateData).where(eq(requestsTable.id, access.request.id));

    return res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error marking request read");
    return res.status(500).json({ error: "Internal server error" });
  }
});

void workspacesTable; // imported for future use; silence unused-import lint
export { formatRequest, formatRequestRecord };
export default router;
