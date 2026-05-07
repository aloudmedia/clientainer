import { Router } from "express";
import OpenAI from "openai";
import { db, aiSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireWorkspaceAdmin } from "../lib/auth";
import { GenerateRequestAiSummaryBody } from "@workspace/api-zod";

const router = Router();

let fallbackClient: OpenAI | null = null;
function getFallbackClient(): OpenAI | null {
  if (fallbackClient) return fallbackClient;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!baseURL || !apiKey) return null;
  fallbackClient = new OpenAI({ baseURL, apiKey });
  return fallbackClient;
}

// Prefer the workspace's own OpenAI key (BYO) when configured; otherwise fall
// back to the platform-wide AI_INTEGRATIONS_OPENAI_* env vars.
async function getClient(workspaceId: number | undefined): Promise<{ client: OpenAI; model: string } | null> {
  if (workspaceId) {
    const [row] = await db.select().from(aiSettingsTable).where(eq(aiSettingsTable.workspaceId, workspaceId));
    if (row?.openaiApiKey) {
      return {
        client: new OpenAI({ apiKey: row.openaiApiKey }),
        model: row.openaiModel || "gpt-4o-mini",
      };
    }
  }
  const fb = getFallbackClient();
  if (!fb) return null;
  return { client: fb, model: "gpt-5.4" };
}

// POST /requests/ai-summary — generate a description draft from the title.
// Available to any signed-in admin/owner (used by the New Request dialog).
router.post("/requests/ai-summary", requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;

    const body = GenerateRequestAiSummaryBody.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Invalid body" });

    const ai = await getClient(workspace?.id);
    if (!ai) {
      return res.status(503).json({ error: "AI provider not configured" });
    }

    const completion = await ai.client.chat.completions.create({
      model: ai.model,
      max_completion_tokens: 400,
      messages: [
        {
          role: "system",
          content:
            "You draft concise support-request descriptions for a client-services agency. " +
            "Given a short title, write a 2-4 sentence description that an account manager " +
            "could refine. Be specific about likely scope, deliverables, and clarifying " +
            "questions to ask the client. No greetings, no sign-off, plain prose only.",
        },
        {
          role: "user",
          content: `Request title: ${body.data.title}`,
        },
      ],
    });

    const description = completion.choices[0]?.message?.content?.trim() ?? "";
    if (!description) {
      return res.status(503).json({ error: "AI provider returned no content" });
    }

    return res.json({ description });
  } catch (err) {
    req.log.error({ err }, "Error generating AI summary");
    return res.status(503).json({ error: "AI provider unavailable" });
  }
});

export default router;
