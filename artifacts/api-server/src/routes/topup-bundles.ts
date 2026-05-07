import { Router } from "express";
import { db, topupBundlesTable, retainerPackagesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireWorkspaceAdmin, loadPortalWorkspace } from "../lib/auth";
import { CreateTopupBundleBody, UpdateTopupBundleBody } from "@workspace/api-zod";

const router = Router();

function formatBundle(b: any) {
  return {
    id: b.id,
    workspaceId: b.workspaceId,
    packageId: b.packageId,
    name: b.name,
    hours: b.hours,
    price: Number(b.price),
    currency: b.currency,
    isActive: b.isActive,
    createdAt: b.createdAt,
  };
}

// GET /packages/:id/topup-bundles
router.get("/packages/:id/topup-bundles", loadPortalWorkspace, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const packageId = parseInt(req.params.id as string, 10);
    if (!Number.isFinite(packageId)) return res.status(400).json({ error: "Invalid package id" });

    const [pkg] = await db.select().from(retainerPackagesTable).where(eq(retainerPackagesTable.id, packageId));
    if (!pkg || pkg.workspaceId !== workspace.id) {
      return res.status(404).json({ error: "Package not found" });
    }

    let bundles = await db.select().from(topupBundlesTable)
      .where(and(eq(topupBundlesTable.packageId, packageId), eq(topupBundlesTable.workspaceId, workspace.id)));

    // Auto-provision a default top-up bundle for prepaid retainers that don't have one yet.
    // The default mirrors the package: same hours, same price. Admins can edit/disable later.
    // Concurrency-safe: lock the package row, then re-check inside the tx before inserting.
    if (
      bundles.length === 0 &&
      pkg.type === "prepaid" &&
      pkg.totalMinutes > 0 &&
      Number(pkg.price) > 0
    ) {
      const defaultHours = Math.max(1, Math.round(pkg.totalMinutes / 60));
      try {
        bundles = await db.transaction(async (tx) => {
          // Serialize concurrent auto-provisioning for this package.
          await tx.select({ id: retainerPackagesTable.id })
            .from(retainerPackagesTable)
            .where(eq(retainerPackagesTable.id, packageId))
            .for("update");

          const existing = await tx.select().from(topupBundlesTable)
            .where(and(eq(topupBundlesTable.packageId, packageId), eq(topupBundlesTable.workspaceId, workspace.id)));
          if (existing.length > 0) return existing;

          const [created] = await tx.insert(topupBundlesTable).values({
            workspaceId: workspace.id,
            packageId,
            name: `Top-up: ${pkg.name}`,
            hours: defaultHours,
            price: String(pkg.price),
            currency: pkg.currency,
            isActive: true,
          }).returning();
          return created ? [created] : [];
        });
      } catch (insertErr) {
        req.log.warn({ insertErr, packageId }, "Could not auto-create default top-up bundle");
        bundles = await db.select().from(topupBundlesTable)
          .where(and(eq(topupBundlesTable.packageId, packageId), eq(topupBundlesTable.workspaceId, workspace.id)));
      }
    }

    return res.json(bundles.map(formatBundle));
  } catch (err) {
    req.log.error({ err }, "Error listing topup bundles");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /packages/:id/topup-bundles
router.post("/packages/:id/topup-bundles", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const packageId = parseInt(req.params.id as string, 10);
    if (!Number.isFinite(packageId)) return res.status(400).json({ error: "Invalid package id" });

    const [pkg] = await db.select().from(retainerPackagesTable).where(eq(retainerPackagesTable.id, packageId));
    if (!pkg || pkg.workspaceId !== workspace.id) {
      return res.status(404).json({ error: "Package not found" });
    }
    if (pkg.type === "bundle" || pkg.type === "credits") {
      return res.status(400).json({ error: "Top-up bundles cannot be added to fixed-price retainers (Bundle or Credits)." });
    }

    const body = CreateTopupBundleBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body", details: body.error });

    const [bundle] = await db.insert(topupBundlesTable).values({
      workspaceId: workspace.id,
      packageId,
      name: body.data.name,
      hours: body.data.hours,
      price: String(body.data.price),
      currency: body.data.currency,
      isActive: body.data.isActive ?? true,
    }).returning();

    return res.status(201).json(formatBundle(bundle));
  } catch (err) {
    req.log.error({ err }, "Error creating topup bundle");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /topup-bundles/:id
router.put("/topup-bundles/:id", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const id = parseInt(req.params.id as string, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const [existing] = await db.select().from(topupBundlesTable).where(eq(topupBundlesTable.id, id));
    if (!existing || existing.workspaceId !== workspace.id) {
      return res.status(404).json({ error: "Bundle not found" });
    }

    const body = UpdateTopupBundleBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const updateData: any = { updatedAt: new Date() };
    if (body.data.name !== undefined) updateData.name = body.data.name;
    if (body.data.hours !== undefined) updateData.hours = body.data.hours;
    if (body.data.price !== undefined) updateData.price = String(body.data.price);
    if (body.data.currency !== undefined) updateData.currency = body.data.currency;
    if (body.data.isActive !== undefined) updateData.isActive = body.data.isActive;

    const [updated] = await db.update(topupBundlesTable).set(updateData).where(eq(topupBundlesTable.id, id)).returning();
    return res.json(formatBundle(updated));
  } catch (err) {
    req.log.error({ err }, "Error updating topup bundle");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /topup-bundles/:id
router.delete("/topup-bundles/:id", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const id = parseInt(req.params.id as string, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const [existing] = await db.select().from(topupBundlesTable).where(eq(topupBundlesTable.id, id));
    if (!existing || existing.workspaceId !== workspace.id) {
      return res.status(404).json({ error: "Bundle not found" });
    }

    await db.delete(topupBundlesTable).where(eq(topupBundlesTable.id, id));
    return res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "Error deleting topup bundle");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
