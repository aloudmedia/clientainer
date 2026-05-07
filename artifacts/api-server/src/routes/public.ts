import { Router } from "express";
import { db, workspacesTable, retainerPackagesTable, leadsTable, styleSettingsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";

const router = Router();

// Stricter validation for the public lead intake — bounds + non-empty trim
// to limit spam payload size & garbage rows.
const PublicLeadInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320),
  packageId: z.number().int().positive().nullable().optional(),
  message: z.string().trim().max(5000).nullable().optional(),
});

// Lightweight in-memory rate limiter for the unauthenticated lead endpoint.
// Allows N submissions per (ip + slug) per window. Resets on process restart;
// good enough for v1 spam defense without external infra.
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 min
const RATE_LIMIT = 10;
const rateBuckets = new Map<string, number[]>();
function checkRate(key: string): boolean {
  const now = Date.now();
  const arr = (rateBuckets.get(key) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_LIMIT) {
    rateBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  return true;
}

async function loadPublicWorkspace(slug: string) {
  const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.slug, slug));
  return workspace ?? null;
}

router.get("/public/workspaces/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug ?? "").trim();
    if (!slug) return res.status(400).json({ error: "Invalid slug" });
    const workspace = await loadPublicWorkspace(slug);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const [style] = await db.select().from(styleSettingsTable).where(eq(styleSettingsTable.workspaceId, workspace.id));

    return res.json({
      slug: workspace.slug,
      name: workspace.name,
      companyName: style?.companyName ?? workspace.name,
      primaryColor: style?.primaryColor ?? null,
      accentColor: style?.accentColor ?? null,
      logoUrl: style?.logoUrl ?? null,
      welcomeMessage: style?.welcomeMessage ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "Error loading public workspace");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/public/workspaces/:slug/packages", async (req, res) => {
  try {
    const slug = String(req.params.slug ?? "").trim();
    if (!slug) return res.status(400).json({ error: "Invalid slug" });
    const workspace = await loadPublicWorkspace(slug);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const rows = await db.select().from(retainerPackagesTable).where(
      and(
        eq(retainerPackagesTable.workspaceId, workspace.id),
        eq(retainerPackagesTable.isActive, true),
        eq(retainerPackagesTable.type, "prepaid"),
      ),
    );

    return res.json(
      rows.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        type: p.type,
        price: String(p.price),
        currency: p.currency,
        totalHours: p.totalHours,
        totalMinutes: p.totalMinutes,
      })),
    );
  } catch (err) {
    req.log.error({ err }, "Error loading public packages");
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/public/workspaces/:slug/leads", async (req, res) => {
  try {
    const slug = String(req.params.slug ?? "").trim();
    if (!slug) return res.status(400).json({ error: "Invalid slug" });

    const ip = (req.ip || (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || "unknown");
    if (!checkRate(`${ip}:${slug}`)) {
      return res.status(429).json({ error: "Too many submissions. Please try again later." });
    }

    const workspace = await loadPublicWorkspace(slug);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });

    const parsed = PublicLeadInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    let packageId = parsed.data.packageId ?? null;
    if (packageId != null) {
      const [pkg] = await db.select().from(retainerPackagesTable).where(
        and(eq(retainerPackagesTable.id, packageId), eq(retainerPackagesTable.workspaceId, workspace.id)),
      );
      if (!pkg) packageId = null;
    }

    const [lead] = await db.insert(leadsTable).values({
      workspaceId: workspace.id,
      packageId,
      name: parsed.data.name,
      email: parsed.data.email,
      message: parsed.data.message || null,
      source: "wordpress",
      status: "new",
    }).returning();

    req.log.info({ leadId: lead.id, workspaceId: workspace.id }, "Public lead captured");
    return res.status(201).json({ id: lead.id, thanks: "Thanks — we'll be in touch shortly." });
  } catch (err) {
    req.log.error({ err }, "Error creating public lead");
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
