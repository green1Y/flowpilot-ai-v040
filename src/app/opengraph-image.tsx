import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Branded Open Graph image (1200×630 PNG, generated locally — no external
 * assets). Served from code so social crawlers get a stable image/png with
 * long-lived caching. The artwork lives in ./opengraph-base.png next to this
 * file; regenerate it with the PIL script if the brand changes.
 */
export const runtime = "nodejs";
export const dynamic = "force-static";

export default async function OgImage() {
  const buf = await readFile(join(process.cwd(), "src", "app", "opengraph-base.png"));
  return new Response(buf, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
