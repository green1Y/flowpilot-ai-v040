/**
 * Import batches (v0.4.0, Wave 2B).
 *
 * Preview -> confirm flow on top of the ImportBatch / ImportRow models.
 * The legacy direct-import route (src/app/api/contacts/import/route.ts)
 * is UNCHANGED; this module is the new batch flow, not a replacement.
 *
 * Pipeline: parse CSV -> column mapping -> per-row validation ->
 * dedupe detection -> preview rows -> explicit confirm resolutions.
 *
 * Rules that must never be relaxed:
 * - A DUPLICATE row is never auto-merged: confirm needs an explicit
 *   resolution (create | merge | skip); the default for an unresolved
 *   DUPLICATE row is skip.
 * - Merge fills empty fields only, unless the resolution lists a field
 *   in `overwriteFields` (allowlist in MERGEABLE_FIELDS). Non-empty
 *   existing values are never overwritten by default.
 * - Merging into an existing contact keeps its Suppression rows: the
 *   merge updates the same contactId, and this module never deletes
 *   Suppression rows. A suppressed contact re-imported and merged stays
 *   suppressed (and therefore still excluded from outbound sends).
 * - Consent columns, when present, write a ConsentRecord (source
 *   "import"); OPTED_OUT also creates the Suppression row.
 */

import { db } from "./db";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Minimal CSV parser supporting quoted fields ("" escapes a quote).
 * Copied from the legacy route src/app/api/contacts/import/route.ts
 * (which keeps its own copy unchanged) so the batch flow parses CSVs
 * exactly the same way the legacy import does.
 */
export function parseCsv(text: string): string[][] {
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

/** Contact fields a CSV column may map to. */
export const MAPPABLE_FIELDS = [
  "name",
  "email",
  "phone",
  "channel",
  "tags",
  "company",
  "consent",
  "consentChannel",
] as const;
export type MappableField = (typeof MAPPABLE_FIELDS)[number];

/** Fields merge() is allowed to overwrite when explicitly listed. */
export const MERGEABLE_FIELDS = ["name", "email", "phone", "channel", "tags", "company"] as const;

/** Default header -> field mapping (headers are lowercased + trimmed first). */
export const DEFAULT_HEADER_MAP: Record<string, MappableField> = {
  name: "name",
  email: "email",
  phone: "phone",
  channel: "channel",
  tags: "tags",
  company: "company",
  consent: "consent",
  consent_channel: "consentChannel",
  consentchannel: "consentChannel",
  consent_status: "consent",
};

export interface MappedRow {
  name?: string;
  email?: string;
  phone?: string;
  channel?: string;
  tags?: string[];
  company?: string;
  consent?: string;
  consentChannel?: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * E.164-ish normalization: strip spaces, dashes, parentheses and dots,
 * keep a single leading "+". No country code is ever invented: a number
 * without "+" stays without one.
 */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  return hasPlus ? `+${digits}` : digits;
}

export function parseConsentValue(raw: string): "OPTED_IN" | "OPTED_OUT" | null {
  const v = raw.trim().toLowerCase();
  if (["opted_in", "opt-in", "optin", "yes", "true", "1", "subscribe", "subscribed"].includes(v))
    return "OPTED_IN";
  if (["opted_out", "opt-out", "optout", "no", "false", "0", "unsubscribe", "unsubscribed"].includes(v))
    return "OPTED_OUT";
  return null;
}

/** Resolve the effective header -> field map: explicit mapping wins over defaults. */
export function resolveMapping(
  headers: string[],
  explicit?: Record<string, string>
): Record<string, MappableField> {
  const map: Record<string, MappableField> = {};
  const explicitNorm: Record<string, string> = {};
  if (explicit) {
    for (const [k, v] of Object.entries(explicit)) explicitNorm[k.trim().toLowerCase()] = v;
  }
  for (const header of headers) {
    const key = header.trim().toLowerCase();
    const wanted = explicitNorm[key];
    if (wanted && (MAPPABLE_FIELDS as readonly string[]).includes(wanted)) {
      map[key] = wanted as MappableField;
    } else if (DEFAULT_HEADER_MAP[key]) {
      map[key] = DEFAULT_HEADER_MAP[key];
    }
  }
  return map;
}

function applyMappingToRow(
  headers: string[],
  values: string[],
  map: Record<string, MappableField>
): { raw: Record<string, string>; mapped: MappedRow } {
  const raw: Record<string, string> = {};
  const mapped: MappedRow = {};
  headers.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    const value = (values[i] ?? "").trim();
    raw[h.trim()] = value;
    const field = map[key];
    if (!field || !value) return;
    if (field === "tags") {
      mapped.tags = value.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
    } else if (field === "email") {
      mapped.email = normalizeEmail(value);
    } else if (field === "phone") {
      mapped.phone = normalizePhone(value);
    } else {
      (mapped as Record<string, string>)[field] = value;
    }
  });
  return { raw, mapped };
}

/** Per-row validation; returns human-readable errors (empty = valid). */
export function validateMappedRow(mapped: MappedRow): string[] {
  const errors: string[] = [];
  if (!mapped.name) errors.push("name is required");
  if (mapped.email && !EMAIL_RE.test(mapped.email)) errors.push(`invalid email "${mapped.email}"`);
  if (mapped.phone) {
    const digitCount = mapped.phone.replace(/[^\d]/g, "").length;
    if (digitCount < 7 || digitCount > 15) errors.push(`invalid phone "${mapped.phone}"`);
  }
  if (mapped.consent && parseConsentValue(mapped.consent) === null) {
    errors.push(`unrecognized consent value "${mapped.consent}"`);
  }
  return errors;
}

export interface FieldDiff {
  field: string;
  existing: string;
  incoming: string;
}

/** Fields where both sides are non-empty and differ — never auto-overwritten. */
export function diffAgainstContact(
  mapped: MappedRow,
  existing: { name: string; email: string | null; phone: string | null; channel: string; tags: string; customFields: string }
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const push = (field: string, existingVal: string | null | undefined, incoming: string | undefined) => {
    if (existingVal && incoming && existingVal !== incoming) {
      diffs.push({ field, existing: existingVal, incoming });
    }
  };
  push("name", existing.name, mapped.name);
  push("email", existing.email, mapped.email);
  push("phone", existing.phone ? normalizePhone(existing.phone) : null, mapped.phone);
  push("channel", existing.channel, mapped.channel);
  const existingTags = (() => {
    try {
      const parsed = JSON.parse(existing.tags) as unknown;
      return Array.isArray(parsed) ? [...parsed].sort().join(",") : "";
    } catch {
      return "";
    }
  })();
  push("tags", existingTags || null, mapped.tags ? [...mapped.tags].sort().join(",") : undefined);
  let existingCompany: string | undefined;
  try {
    const cf = JSON.parse(existing.customFields) as Record<string, unknown>;
    if (typeof cf.company === "string") existingCompany = cf.company;
  } catch {
    /* ignore */
  }
  push("company", existingCompany, mapped.company);
  return diffs;
}

export interface PreviewRow {
  /** Set once the preview rows are persisted (id of the ImportRow). */
  id?: string;
  rowIndex: number;
  raw: Record<string, string>;
  mapped: MappedRow;
  status: "VALID" | "INVALID" | "DUPLICATE";
  errors: string[];
  /** Existing contact id when this row duplicates one (null for in-file dupes). */
  matchedContactId: string | null;
  diff: FieldDiff[];
  duplicateInBatch: boolean;
}

export interface BuiltBatch {
  batchId: string;
  filename: string;
  rows: PreviewRow[];
  counts: { total: number; valid: number; invalid: number; duplicate: number };
}

/**
 * Parse + validate + dedupe a CSV into a PREVIEW ImportBatch with rows.
 * Dedupe matches existing contacts by normalized email OR normalized
 * phone within the workspace, and also flags repeats within the file.
 */
export async function buildImportBatch(
  workspaceId: string,
  filename: string,
  csv: string,
  explicitMapping?: Record<string, string>
): Promise<BuiltBatch> {
  if (!filename.trim()) throw new Error("filename is required");
  const rows = parseCsv(csv);
  if (rows.length < 2) {
    throw new Error("CSV must include a header row and at least one data row");
  }
  const headers = rows[0].map((h) => h.trim());
  const map = resolveMapping(headers, explicitMapping);
  // The map is keyed by CSV header; a "name" mapping may come from an
  // explicit mapping (e.g. "Full Name" → name), so check VALUES, not keys.
  if (!Object.values(map).includes("name")) throw new Error('CSV header must include a "name" column (or a mapping to name)');

  const existing = await db.contact.findMany({
    where: { workspaceId },
    select: { id: true, name: true, email: true, phone: true, channel: true, tags: true, customFields: true },
  });
  const byEmail = new Map<string, (typeof existing)[number]>();
  const byPhone = new Map<string, (typeof existing)[number]>();
  for (const c of existing) {
    if (c.email) byEmail.set(normalizeEmail(c.email), c);
    if (c.phone) byPhone.set(normalizePhone(c.phone), c);
  }

  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();
  const preview: PreviewRow[] = [];

  for (let r = 1; r < rows.length; r++) {
    const { raw, mapped } = applyMappingToRow(headers, rows[r], map);
    const errors = validateMappedRow(mapped);
    let matched: (typeof existing)[number] | null = null;
    let duplicateInBatch = false;
    if (mapped.email) {
      if (seenEmails.has(mapped.email)) duplicateInBatch = true;
      else if (byEmail.has(mapped.email)) matched = byEmail.get(mapped.email)!;
    }
    if (!matched && !duplicateInBatch && mapped.phone) {
      if (seenPhones.has(mapped.phone)) duplicateInBatch = true;
      else if (byPhone.has(mapped.phone)) matched = byPhone.get(mapped.phone)!;
    }
    if (mapped.email) seenEmails.add(mapped.email);
    if (mapped.phone) seenPhones.add(mapped.phone);

    let status: PreviewRow["status"];
    if (errors.length > 0) status = "INVALID";
    else if (matched || duplicateInBatch) status = "DUPLICATE";
    else status = "VALID";
    preview.push({
      rowIndex: r,
      raw,
      mapped,
      status,
      errors,
      matchedContactId: matched ? matched.id : null,
      diff: matched ? diffAgainstContact(mapped, matched) : [],
      duplicateInBatch,
    });
  }

  const batch = await db.importBatch.create({
    data: {
      workspaceId,
      filename: filename.trim(),
      status: "PREVIEW",
      totalRows: preview.length,
    },
  });
  // Rows are created in row order; createMany keeps the preview atomic enough
  // for a batch (confirm re-reads rows inside its own transaction).
  await db.importRow.createMany({
    data: preview.map((p) => ({
      batchId: batch.id,
      rowIndex: p.rowIndex,
      raw: JSON.stringify(p.raw),
      mapped: JSON.stringify(p.mapped),
      status: p.status,
      errors: JSON.stringify(p.errors),
      contactId: p.matchedContactId,
    })),
  });
  // Attach persisted row ids so callers can confirm by row id directly.
  const persisted = await db.importRow.findMany({
    where: { batchId: batch.id },
    select: { id: true, rowIndex: true },
  });
  const idByIndex = new Map(persisted.map((r) => [r.rowIndex, r.id]));
  for (const p of preview) p.id = idByIndex.get(p.rowIndex);

  return {
    batchId: batch.id,
    filename: batch.filename,
    rows: preview,
    counts: {
      total: preview.length,
      valid: preview.filter((p) => p.status === "VALID").length,
      invalid: preview.filter((p) => p.status === "INVALID").length,
      duplicate: preview.filter((p) => p.status === "DUPLICATE").length,
    },
  };
}

/**
 * Pure merge rule. Returns the Prisma-shaped patch for `existing` given
 * `incoming`, under the empty-only default: a field is set only when the
 * existing value is empty, UNLESS the field is listed in `overwriteFields`
 * (which must be a subset of MERGEABLE_FIELDS — anything else is ignored).
 * Tags/customFields are stored as JSON strings, like the Contact model.
 */
export function mergeFields(
  existing: { name: string; email: string | null; phone: string | null; channel: string; tags: string; customFields: string },
  incoming: MappedRow,
  overwriteFields: string[] = []
): Record<string, unknown> {
  const overwrite = new Set(
    overwriteFields.filter((f) => (MERGEABLE_FIELDS as readonly string[]).includes(f))
  );
  const patch: Record<string, unknown> = {};
  const take = (field: string, existingVal: string | null | undefined, incomingVal: string | undefined) => {
    if (!incomingVal) return;
    if (overwrite.has(field) || !existingVal) patch[field] = incomingVal;
  };
  take("name", existing.name, incoming.name);
  take("email", existing.email, incoming.email);
  take("phone", existing.phone, incoming.phone);
  take("channel", existing.channel, incoming.channel);

  let existingTags: string[] = [];
  try {
    const parsed = JSON.parse(existing.tags) as unknown;
    if (Array.isArray(parsed)) existingTags = parsed as string[];
  } catch {
    /* ignore */
  }
  if (incoming.tags && incoming.tags.length > 0) {
    if (overwrite.has("tags") || existingTags.length === 0) {
      patch.tags = JSON.stringify(incoming.tags);
    }
  }

  let customFields: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(existing.customFields) as unknown;
    if (typeof parsed === "object" && parsed !== null) customFields = parsed as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  if (incoming.company) {
    const existingCompany = typeof customFields.company === "string" ? customFields.company : "";
    if (overwrite.has("company") || !existingCompany) {
      patch.customFields = JSON.stringify({ ...customFields, company: incoming.company });
    }
  }
  return patch;
}

export type ResolutionInput =
  | "create"
  | "merge"
  | "skip"
  | { action: "create" | "merge" | "skip"; overwriteFields?: string[] };

export interface ImportReport {
  batchId: string;
  imported: number;
  skipped: number;
  failed: number;
  errors: { rowId: string; rowIndex: number; error: string }[];
}

function normalizeResolution(input: ResolutionInput | undefined): { action: "create" | "merge" | "skip"; overwriteFields: string[] } | null {
  if (typeof input === "string") {
    if (input === "create" || input === "merge" || input === "skip") {
      return { action: input, overwriteFields: [] };
    }
    return null;
  }
  if (input && typeof input === "object") {
    if (input.action === "create" || input.action === "merge" || input.action === "skip") {
      return { action: input.action, overwriteFields: input.overwriteFields ?? [] };
    }
  }
  return null;
}

/**
 * Apply confirm resolutions for one batch in ONE transaction.
 * Throws "Import batch already confirmed" when the batch is not PREVIEW —
 * the import_confirm job handler treats that as success (work already done).
 * Suppression rows are never touched here, so a merged contact keeps them.
 */
export async function applyImportResolutions(
  workspaceId: string,
  batchId: string,
  resolutions: Record<string, ResolutionInput>
): Promise<ImportReport> {
  return db.$transaction(async (tx) => {
    const batch = await tx.importBatch.findFirst({
      where: { id: batchId, workspaceId },
      include: { rows: { orderBy: { rowIndex: "asc" } } },
    });
    if (!batch) throw new Error("Import batch not found");
    if (batch.status !== "PREVIEW") throw new Error("Import batch already confirmed");

    let imported = 0;
    let skipped = 0;
    let failed = 0;
    const errors: ImportReport["errors"] = [];

    const writeConsent = async (contactId: string, mapped: MappedRow) => {
      if (!mapped.consent) return;
      const status = parseConsentValue(mapped.consent);
      if (!status) return;
      const channel = mapped.consentChannel ?? mapped.channel ?? "email";
      await tx.consentRecord.create({
        data: { workspaceId, contactId, channel, status, source: "import" },
      });
      if (status === "OPTED_OUT") {
        const existingSupp = await tx.suppression.findFirst({
          where: { workspaceId, contactId, channel },
        });
        if (!existingSupp) {
          await tx.suppression.create({
            data: { workspaceId, contactId, channel, reason: "opted out via import" },
          });
        }
      }
    };

    for (const row of batch.rows) {
      const mapped = JSON.parse(row.mapped) as MappedRow;
      const rowErrors = JSON.parse(row.errors) as string[];
      const rawResolution = resolutions[row.id];
      let resolution = rawResolution !== undefined ? normalizeResolution(rawResolution) : null;
      if (resolution === null && rawResolution !== undefined) {
        failed += 1;
        errors.push({ rowId: row.id, rowIndex: row.rowIndex, error: "invalid resolution" });
        await tx.importRow.update({ where: { id: row.id }, data: { status: "SKIPPED", resolution: "skip" } });
        continue;
      }
      // Defaults: VALID rows import; DUPLICATE rows are never silently
      // merged — an unresolved duplicate is skipped. INVALID rows are skipped.
      if (!resolution) {
        resolution =
          row.status === "VALID"
            ? { action: "create", overwriteFields: [] }
            : { action: "skip", overwriteFields: [] };
      }

      if (resolution.action === "skip") {
        skipped += 1;
        await tx.importRow.update({ where: { id: row.id }, data: { status: "SKIPPED", resolution: "skip" } });
        continue;
      }

      if (row.status === "INVALID") {
        failed += 1;
        errors.push({
          rowId: row.id,
          rowIndex: row.rowIndex,
          error: rowErrors.join("; ") || "row failed validation",
        });
        await tx.importRow.update({ where: { id: row.id }, data: { status: "SKIPPED", resolution: resolution.action } });
        continue;
      }

      try {
        if (resolution.action === "create") {
          const contact = await tx.contact.create({
            data: {
              workspaceId,
              name: mapped.name ?? "",
              channel: mapped.channel ?? "web",
              email: mapped.email ?? null,
              phone: mapped.phone ?? null,
              tags: JSON.stringify(mapped.tags ?? []),
              customFields: JSON.stringify(mapped.company ? { company: mapped.company } : {}),
            },
          });
          await writeConsent(contact.id, mapped);
          imported += 1;
          await tx.importRow.update({
            where: { id: row.id },
            data: { status: "IMPORTED", resolution: "create", contactId: contact.id },
          });
        } else {
          // merge
          const targetId = row.contactId;
          if (!targetId) throw new Error("no matched contact to merge into");
          const existing = await tx.contact.findFirst({
            where: { id: targetId, workspaceId },
          });
          if (!existing) throw new Error("matched contact no longer exists");
          const patch = mergeFields(existing, mapped, resolution.overwriteFields);
          if (Object.keys(patch).length > 0) {
            await tx.contact.update({ where: { id: existing.id }, data: patch });
          }
          // Suppression rows are deliberately untouched: merging keeps
          // them (same contactId), so a suppressed contact stays suppressed.
          await writeConsent(existing.id, mapped);
          imported += 1;
          await tx.importRow.update({
            where: { id: row.id },
            data: { status: "IMPORTED", resolution: "merge", contactId: existing.id },
          });
        }
      } catch (e) {
        failed += 1;
        errors.push({
          rowId: row.id,
          rowIndex: row.rowIndex,
          error: e instanceof Error ? e.message : "Unknown error",
        });
        await tx.importRow.update({
          where: { id: row.id },
          data: { status: "SKIPPED", resolution: resolution.action },
        });
      }
    }

    await tx.importBatch.update({
      where: { id: batch.id },
      data: {
        status: "CONFIRMED",
        importedCount: imported,
        skippedCount: skipped,
        failedCount: failed,
      },
    });

    return { batchId: batch.id, imported, skipped, failed, errors };
  });
}
