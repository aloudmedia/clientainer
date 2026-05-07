import { Router } from "express";
import { db, formsTable, formAssignmentsTable, usersTable } from "@workspace/db";
import { eq, inArray, and } from "drizzle-orm";
import { requireWorkspaceAdmin, loadPortalWorkspace, loadDbUser } from "../lib/auth";

const router = Router();

async function formatForm(form: any) {
  const assignments = await db.select().from(formAssignmentsTable).where(eq(formAssignmentsTable.formId, form.id));
  return {
    id: form.id,
    title: form.title,
    description: form.description,
    fields: form.fields ?? [],
    isActive: form.isActive,
    createdAt: form.createdAt,
    updatedAt: form.updatedAt,
    assignedCustomerIds: assignments.map((a: any) => a.customerId),
  };
}

// GET /forms (workspace-scoped)
router.get("/forms", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const forms = await db.select().from(formsTable)
      .where(eq(formsTable.workspaceId, workspace.id))
      .orderBy(formsTable.createdAt);
    const formatted = await Promise.all(forms.map(formatForm));
    return res.json(formatted);
  } catch (err) {
    req.log.error({ err }, "Error listing forms");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /forms (workspace-scoped)
router.post("/forms", requireWorkspaceAdmin, async (req, res) => {
  try {
    const dbUser = (req as any).dbUser;
    const workspace = (req as any).workspace;
    const { title, description, fields, isActive } = req.body;
    if (!title || !Array.isArray(fields)) {
      return res.status(400).json({ error: "title and fields are required" });
    }

    const [form] = await db.insert(formsTable).values({
      workspaceId: workspace.id,
      title,
      description: description ?? null,
      fields: fields ?? [],
      isActive: isActive !== undefined ? isActive : true,
      createdByAdminId: dbUser.id,
    }).returning();

    return res.status(201).json(await formatForm(form));
  } catch (err) {
    req.log.error({ err }, "Error creating form");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /forms/assigned-to/:customerId (workspace-scoped)
router.get("/forms/assigned-to/:customerId", loadPortalWorkspace, loadDbUser, async (req, res) => {
  try {
    const customerId = parseInt(req.params.customerId as string, 10);
    if (isNaN(customerId)) return res.status(400).json({ error: "Invalid customerId" });

    const dbUser = (req as any).dbUser;
    if (dbUser.role === "customer" && dbUser.id !== customerId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const assignments = await db.select().from(formAssignmentsTable)
      .where(eq(formAssignmentsTable.customerId, customerId));

    if (assignments.length === 0) return res.json([]);

    const formIds = assignments.map((a: any) => a.formId);
    const forms = await db.select().from(formsTable)
      .where(inArray(formsTable.id, formIds));

    const activeForms = forms.filter(f => f.isActive);
    const formatted = await Promise.all(activeForms.map(formatForm));
    return res.json(formatted);
  } catch (err) {
    req.log.error({ err }, "Error getting assigned forms");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /forms/:id
router.get("/forms/:id", loadDbUser, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const [form] = await db.select().from(formsTable).where(eq(formsTable.id, id));
    if (!form) return res.status(404).json({ error: "Form not found" });

    return res.json(await formatForm(form));
  } catch (err) {
    req.log.error({ err }, "Error getting form");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /forms/:id (workspace-scoped)
router.put("/forms/:id", requireWorkspaceAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const { title, description, fields, isActive } = req.body;
    if (!title || !Array.isArray(fields)) {
      return res.status(400).json({ error: "title and fields are required" });
    }

    const [updated] = await db.update(formsTable).set({
      title,
      description: description ?? null,
      fields,
      isActive: isActive !== undefined ? isActive : true,
      updatedAt: new Date(),
    }).where(eq(formsTable.id, id)).returning();

    if (!updated) return res.status(404).json({ error: "Form not found" });
    return res.json(await formatForm(updated));
  } catch (err) {
    req.log.error({ err }, "Error updating form");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /forms/:id (workspace-scoped)
router.delete("/forms/:id", requireWorkspaceAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    await db.delete(formsTable).where(eq(formsTable.id, id));
    return res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error deleting form");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /forms/:id/assign (workspace-scoped)
router.post("/forms/:id/assign", requireWorkspaceAdmin, async (req, res) => {
  try {
    const formId = parseInt(req.params.id as string, 10);
    if (isNaN(formId)) return res.status(400).json({ error: "Invalid id" });

    const { customerIds, replace } = req.body;
    if (!Array.isArray(customerIds)) return res.status(400).json({ error: "customerIds must be an array" });

    if (replace) {
      await db.delete(formAssignmentsTable).where(eq(formAssignmentsTable.formId, formId));
    }

    if (customerIds.length === 0) return res.json({ assigned: 0 });

    // Upsert: only insert assignments that don't exist yet
    const existing = await db.select().from(formAssignmentsTable)
      .where(eq(formAssignmentsTable.formId, formId));
    const existingCustomerIds = new Set(existing.map((a: any) => a.customerId));
    const toInsert = (customerIds as number[]).filter(cid => !existingCustomerIds.has(cid));

    if (toInsert.length > 0) {
      await db.insert(formAssignmentsTable).values(
        toInsert.map(customerId => ({ formId, customerId }))
      );
    }

    return res.json({ assigned: toInsert.length });
  } catch (err) {
    req.log.error({ err }, "Error assigning form");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /forms/:id/assignments (workspace-scoped)
router.get("/forms/:id/assignments", requireWorkspaceAdmin, async (req, res) => {
  try {
    const formId = parseInt(req.params.id as string, 10);
    if (isNaN(formId)) return res.status(400).json({ error: "Invalid id" });

    const assignments = await db.select().from(formAssignmentsTable)
      .where(eq(formAssignmentsTable.formId, formId));

    const formatted = await Promise.all(assignments.map(async (a: any) => {
      const [customer] = await db.select().from(usersTable).where(eq(usersTable.id, a.customerId));
      return {
        id: a.id,
        formId: a.formId,
        customerId: a.customerId,
        createdAt: a.createdAt,
        customer: customer
          ? { id: customer.id, clerkUserId: customer.clerkUserId, email: customer.email, name: customer.name, role: customer.role, createdAt: customer.createdAt }
          : undefined,
      };
    }));

    return res.json(formatted);
  } catch (err) {
    req.log.error({ err }, "Error getting form assignments");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
