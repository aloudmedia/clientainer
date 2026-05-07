import { Router } from "express";
import { db, blogPostsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { requireOwner } from "../lib/auth";
import { z } from "zod/v4";

const router = Router();

const slugSchema = z.string().min(1).max(160).regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and dashes");

// Create — applies sensible defaults when fields are omitted.
const createSchema = z.object({
  slug: slugSchema,
  title: z.string().min(1).max(200),
  excerpt: z.string().max(600).default(""),
  body: z.string().default(""),
  category: z.string().min(1).max(80).default("Strategy"),
  author: z.string().min(1).max(120).default("The Clientainer Team"),
  readTime: z.string().min(1).max(40).default("5 min read"),
  status: z.enum(["draft", "published"]).default("draft"),
});

// Update — every field optional with NO defaults, so omitting a field never
// rewrites it (e.g. omitting `status` won't accidentally unpublish a post).
const updateSchema = z.object({
  slug: slugSchema.optional(),
  title: z.string().min(1).max(200).optional(),
  excerpt: z.string().max(600).optional(),
  body: z.string().optional(),
  category: z.string().min(1).max(80).optional(),
  author: z.string().min(1).max(120).optional(),
  readTime: z.string().min(1).max(40).optional(),
  status: z.enum(["draft", "published"]).optional(),
});

function shape(p: any) {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    excerpt: p.excerpt,
    body: p.body,
    category: p.category,
    author: p.author,
    readTime: p.readTime,
    status: p.status,
    publishedAt: p.publishedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// ─── PUBLIC ─────────────────────────────────────────────────────────────────

// GET /blog/posts — list published posts (public)
router.get("/blog/posts", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(blogPostsTable)
      .where(eq(blogPostsTable.status, "published"))
      .orderBy(desc(blogPostsTable.publishedAt));
    return res.json(rows.map(shape));
  } catch (err) {
    req.log.error({ err }, "Error listing blog posts");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /blog/posts/:slug — public post detail
router.get("/blog/posts/:slug", async (req, res) => {
  try {
    const [post] = await db
      .select()
      .from(blogPostsTable)
      .where(and(eq(blogPostsTable.slug, req.params.slug), eq(blogPostsTable.status, "published")));
    if (!post) return res.status(404).json({ error: "Post not found" });
    return res.json(shape(post));
  } catch (err) {
    req.log.error({ err }, "Error fetching blog post");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─── OWNER ──────────────────────────────────────────────────────────────────

// GET /owner/blog-posts — list ALL posts (drafts + published)
router.get("/owner/blog-posts", requireOwner, async (_req, res) => {
  const rows = await db.select().from(blogPostsTable).orderBy(desc(blogPostsTable.createdAt));
  return res.json(rows.map(shape));
});

// POST /owner/blog-posts — create
router.post("/owner/blog-posts", requireOwner, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });

  const [existing] = await db.select().from(blogPostsTable).where(eq(blogPostsTable.slug, parsed.data.slug));
  if (existing) return res.status(409).json({ error: "A post with that slug already exists" });

  const now = new Date();
  const [created] = await db.insert(blogPostsTable).values({
    ...parsed.data,
    publishedAt: parsed.data.status === "published" ? now : null,
    updatedAt: now,
  }).returning();
  return res.status(201).json(shape(created));
});

// PATCH /owner/blog-posts/:id — update
router.patch("/owner/blog-posts/:id", requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });

  const [existing] = await db.select().from(blogPostsTable).where(eq(blogPostsTable.id, id));
  if (!existing) return res.status(404).json({ error: "Post not found" });

  if (parsed.data.slug && parsed.data.slug !== existing.slug) {
    const [conflict] = await db.select().from(blogPostsTable).where(eq(blogPostsTable.slug, parsed.data.slug));
    if (conflict) return res.status(409).json({ error: "A post with that slug already exists" });
  }

  const willBePublished = (parsed.data.status ?? existing.status) === "published";
  const wasPublished = existing.status === "published";

  const [updated] = await db.update(blogPostsTable).set({
    ...parsed.data,
    publishedAt: willBePublished
      ? (existing.publishedAt ?? new Date())
      : (wasPublished ? null : existing.publishedAt),
    updatedAt: new Date(),
  }).where(eq(blogPostsTable.id, id)).returning();

  return res.json(shape(updated));
});

// DELETE /owner/blog-posts/:id
router.delete("/owner/blog-posts/:id", requireOwner, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
  await db.delete(blogPostsTable).where(eq(blogPostsTable.id, id));
  return res.status(204).end();
});

export default router;
