import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, err, parseBody } from "@/lib/api";
import { requireWorkspace, requireRole } from "@/lib/tenancy";
import { auditLog } from "@/lib/audit";

const importSchema = z.object({
  csv: z.string().min(1).max(2_000_000),
});

/**
 * Minimal CSV parser supporting quoted fields ("" escapes a quote).
 * Columns: name, email, phone, channel, tags (tags are ";"-separated).
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const POST = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);
  // Data mutation: AGENT+ only (ANALYST is read-only).
  requireRole(ctx, "AGENT");
  const body = await parseBody(req, importSchema);

  const rows = parseCsv(body.csv);
  if (rows.length < 2) {
    throw err("CSV must include a header row and at least one data row", 422);
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const nameIdx = col("name");
  if (nameIdx === -1) throw err('CSV header must include a "name" column', 422);
  const emailIdx = col("email");
  const phoneIdx = col("phone");
  const channelIdx = col("channel");
  const tagsIdx = col("tags");

  let imported = 0;
  let skipped = 0;
  const errors: { row: number; error: string }[] = [];
  const seenEmails = new Set<string>();

  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const rowNum = r + 1; // 1-based, including the header row
    try {
      const name = (cols[nameIdx] ?? "").trim();
      if (!name) throw new Error("name is required");
      const email = emailIdx >= 0 ? (cols[emailIdx] ?? "").trim().toLowerCase() : "";
      if (email && !EMAIL_RE.test(email)) throw new Error(`invalid email "${email}"`);
      if (email) {
        if (seenEmails.has(email)) throw new Error(`duplicate email "${email}" in file`);
        const dup = await db.contact.findFirst({
          where: { workspaceId: ctx.workspaceId, email },
        });
        if (dup) throw new Error(`email "${email}" already exists in this workspace`);
      }
      const phone = phoneIdx >= 0 ? (cols[phoneIdx] ?? "").trim() : "";
      const channel =
        channelIdx >= 0 && (cols[channelIdx] ?? "").trim() ? cols[channelIdx].trim() : "web";
      const tags =
        tagsIdx >= 0
          ? (cols[tagsIdx] ?? "").split(";").map((t) => t.trim()).filter(Boolean)
          : [];

      await db.contact.create({
        data: {
          workspaceId: ctx.workspaceId,
          name,
          channel,
          email: email || null,
          phone: phone || null,
          tags: JSON.stringify(tags),
        },
      });
      if (email) seenEmails.add(email);
      imported++;
    } catch (e) {
      skipped++;
      errors.push({ row: rowNum, error: e instanceof Error ? e.message : "Unknown error" });
    }
  }

  await auditLog(ctx.workspaceId, ctx.userId, "contacts.imported", {
    type: "contact",
    imported,
    skipped,
  });

  return ok({ imported, skipped, errors });
});
