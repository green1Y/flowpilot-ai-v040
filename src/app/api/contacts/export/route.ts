import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler } from "@/lib/api";
import { requireWorkspace } from "@/lib/tenancy";
import { parseJson } from "@/lib/serialize";

/** Quote a CSV cell when it contains a comma, quote, or newline.
 *  v0.4.0: neutralize formula injection — a cell whose first
 *  non-whitespace character is = + - @ | % gets a leading single quote
 *  (Excel's text marker, not displayed) so it can never execute as a
 *  formula when the export is opened. Attacker-controlled inbound text
 *  (names, tags, message bodies) reaches this exporter verbatim. */
function csvCell(v: string | number | null | undefined): string {
  const s = String(v ?? "");
  const neutralized = /^[ \t]*[=+\-@|%]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}

export const GET = handler(async (req: NextRequest) => {
  const ctx = await requireWorkspace(req);

  const contacts = await db.contact.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { firstSeenAt: "desc" },
  });

  const lines = ["name,email,phone,channel,tags,leadStatus,leadScore"];
  for (const c of contacts) {
    lines.push(
      [
        csvCell(c.name),
        csvCell(c.email),
        csvCell(c.phone),
        csvCell(c.channel),
        csvCell(parseJson<string[]>(c.tags, []).join(";")),
        csvCell(c.leadStatus),
        csvCell(c.leadScore),
      ].join(",")
    );
  }

  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="contacts-export.csv"',
    },
  });
});
