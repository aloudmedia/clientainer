import { Router } from "express";
import { db, reminderBlocksTable, reminderAssignmentsTable, usersTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireWorkspaceAdmin } from "../lib/auth";

const router = Router();

async function formatBlock(block: any) {
  const assignments = await db
    .select()
    .from(reminderAssignmentsTable)
    .where(eq(reminderAssignmentsTable.reminderBlockId, block.id));
  return {
    id: block.id,
    name: block.name,
    triggerType: block.triggerType,
    thresholdMinutes: block.thresholdMinutes,
    daysBeforeExpiry: block.daysBeforeExpiry,
    notifyEmail: block.notifyEmail ?? null,
    message: block.message ?? null,
    assignedCustomerIds: assignments.map((a: any) => a.customerId),
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
  };
}

// GET /reminders
router.get("/reminders", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const blocks = await db
      .select()
      .from(reminderBlocksTable)
      .where(eq(reminderBlocksTable.workspaceId, workspace.id))
      .orderBy(reminderBlocksTable.createdAt);
    const formatted = await Promise.all(blocks.map(formatBlock));
    return res.json(formatted);
  } catch (err) {
    req.log.error({ err }, "Error listing reminder blocks");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /reminders
router.post("/reminders", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const { name, triggerType, thresholdMinutes, daysBeforeExpiry, notifyEmail, message } = req.body;
    if (!name || !triggerType) {
      return res.status(400).json({ error: "name and triggerType are required" });
    }
    const [block] = await db.insert(reminderBlocksTable).values({
      workspaceId: workspace.id,
      name,
      triggerType: triggerType as "low_balance" | "days_before_expiry",
      thresholdMinutes: thresholdMinutes ?? 60,
      daysBeforeExpiry: daysBeforeExpiry ?? 7,
      notifyEmail: notifyEmail ?? null,
      message: message ?? null,
    }).returning();
    return res.status(201).json(await formatBlock(block));
  } catch (err) {
    req.log.error({ err }, "Error creating reminder block");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /reminders/:id
router.patch("/reminders/:id", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const blockId = parseInt(String(req.params.id));
    const [existing] = await db.select().from(reminderBlocksTable)
      .where(and(eq(reminderBlocksTable.id, blockId), eq(reminderBlocksTable.workspaceId, workspace.id)));
    if (!existing) return res.status(404).json({ error: "Not found" });

    const { name, triggerType, thresholdMinutes, daysBeforeExpiry, notifyEmail, message } = req.body;
    const [updated] = await db.update(reminderBlocksTable)
      .set({
        ...(name !== undefined && { name }),
        ...(triggerType !== undefined && { triggerType }),
        ...(thresholdMinutes !== undefined && { thresholdMinutes }),
        ...(daysBeforeExpiry !== undefined && { daysBeforeExpiry }),
        ...(notifyEmail !== undefined && { notifyEmail }),
        ...(message !== undefined && { message }),
        updatedAt: new Date(),
      })
      .where(eq(reminderBlocksTable.id, blockId))
      .returning();
    return res.json(await formatBlock(updated));
  } catch (err) {
    req.log.error({ err }, "Error updating reminder block");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /reminders/:id
router.delete("/reminders/:id", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const blockId = parseInt(String(req.params.id));
    const [existing] = await db.select().from(reminderBlocksTable)
      .where(and(eq(reminderBlocksTable.id, blockId), eq(reminderBlocksTable.workspaceId, workspace.id)));
    if (!existing) return res.status(404).json({ error: "Not found" });
    await db.delete(reminderBlocksTable).where(eq(reminderBlocksTable.id, blockId));
    return res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error deleting reminder block");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /reminders/:id/assign
router.post("/reminders/:id/assign", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const blockId = parseInt(String(req.params.id));
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ error: "customerId is required" });

    const [block] = await db.select().from(reminderBlocksTable)
      .where(and(eq(reminderBlocksTable.id, blockId), eq(reminderBlocksTable.workspaceId, workspace.id)));
    if (!block) return res.status(404).json({ error: "Reminder block not found" });

    // Verify customer exists
    const [customer] = await db.select().from(usersTable).where(eq(usersTable.id, customerId));
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    // Idempotent — skip if already assigned
    const [existing] = await db.select().from(reminderAssignmentsTable)
      .where(and(
        eq(reminderAssignmentsTable.reminderBlockId, blockId),
        eq(reminderAssignmentsTable.customerId, customerId)
      ));
    if (existing) return res.status(201).json(existing);

    const [assignment] = await db.insert(reminderAssignmentsTable).values({
      reminderBlockId: blockId,
      customerId,
    }).returning();

    return res.status(201).json(assignment);
  } catch (err) {
    req.log.error({ err }, "Error assigning reminder block");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /reminders/:id/assign/:customerId
router.delete("/reminders/:id/assign/:customerId", requireWorkspaceAdmin, async (req, res) => {
  try {
    const blockId = parseInt(String(req.params.id));
    const customerId = parseInt(String(req.params.customerId));
    await db.delete(reminderAssignmentsTable)
      .where(and(
        eq(reminderAssignmentsTable.reminderBlockId, blockId),
        eq(reminderAssignmentsTable.customerId, customerId)
      ));
    return res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error unassigning reminder block");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
