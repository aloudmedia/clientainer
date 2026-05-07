import { Router } from "express";
import archiver from "archiver";
import { requireWorkspaceAdmin, loadPortalWorkspace } from "../lib/auth";

const router = Router();

function getEmbedHost(req: import("express").Request): string {
  // Prefer the canonical published domain(s) provided by Replit. This is the
  // trusted public origin and cannot be spoofed by a malicious downloader
  // sending forged X-Forwarded-* headers. Fall back to forwarded headers only
  // for local development.
  const replitDomains = (process.env.REPLIT_DOMAINS ?? "").split(",").map(d => d.trim()).filter(Boolean);
  if (replitDomains.length > 0) {
    return `https://${replitDomains[0]}`;
  }
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || req.protocol || "http";
  const host = (req.headers["x-forwarded-host"] as string | undefined) || (req.headers.host as string | undefined) || "localhost";
  return `${proto}://${host}`;
}

router.get("/plugins/wordpress.zip", loadPortalWorkspace, requireWorkspaceAdmin, async (req, res) => {
  try {
    const workspace = (req as any).workspace;
    const slug = workspace.slug as string;
    const embedBase = getEmbedHost(req);
    const embedUrl = `${embedBase}/embed/${encodeURIComponent(slug)}`;

    const pluginPhp = `<?php
/**
 * Plugin Name: Clientainer Embed
 * Description: Embed your Clientainer retainer offers and lead form on any WordPress page or post using the [clientainer] shortcode.
 * Version: 1.0.0
 * Author: Clientainer
 */

if (!defined('ABSPATH')) { exit; }

function clientainer_embed_shortcode($atts) {
    $atts = shortcode_atts(array(
        'slug'   => ${JSON.stringify(slug)},
        'height' => '720',
    ), $atts, 'clientainer');

    $src = 'https://' . $_SERVER['HTTP_HOST']; // overridden below
    $src = ${JSON.stringify(embedBase)} . '/embed/' . rawurlencode($atts['slug']);
    $height = intval($atts['height']);
    if ($height < 200) { $height = 720; }

    return sprintf(
        '<iframe src="%s" style="width:100%%;border:0;min-height:%dpx;" loading="lazy" allow="clipboard-write" title="Clientainer"></iframe>',
        esc_url($src),
        $height
    );
}
add_shortcode('clientainer', 'clientainer_embed_shortcode');
`;

    const readme = `=== Clientainer Embed ===
Stable tag: 1.0.0

Adds a [clientainer] shortcode that embeds your Clientainer retainer offers and lead form on any WordPress page or post.

== Installation ==
1. Upload the plugin folder to /wp-content/plugins/ (or upload the .zip via Plugins → Add New → Upload Plugin).
2. Activate "Clientainer Embed" in the WordPress Plugins screen.
3. Add the shortcode to any page or post:

   [clientainer]

   The plugin is pre-configured for workspace "${slug}".
   You can override the slug or iframe height like so:

   [clientainer slug="${slug}" height="900"]

== Embed URL ==
${embedUrl}
`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="clientainer-${slug}.zip"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      req.log.error({ err }, "Archiver error");
      try { res.status(500).end(); } catch {}
    });
    archive.pipe(res);
    archive.append(pluginPhp, { name: "clientainer/clientainer.php" });
    archive.append(readme, { name: "clientainer/readme.txt" });
    await archive.finalize();
  } catch (err) {
    req.log.error({ err }, "Error building wordpress plugin zip");
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
