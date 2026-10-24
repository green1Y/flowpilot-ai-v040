/**
 * Import batch tests (Wave 2B). DB-backed, unique workspace per run.
 * Covers: quoted CSV parsing, mapping, validation, dedupe + diff,
 * mergeFields (empty-only default vs explicit overwrite allowlist),
 * confirm resolutions in one transaction, suppression survival, and
 * consent columns writing ConsentRecords.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  parseCsv,
  normalizePhone,
  normalizeEmail,
  mergeFields,
  buildImportBatch,
  applyImportResolutions,
  type MappedRow,
} from "./imports";
import { getConsentState, isSuppressed } from "./consent";

const suffix = `im${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsId = "";

beforeAll(async () => {
  const org = await db.organization.create({ data: { name: `IM Org ${suffix}` } });
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `IM WS ${suffix}`, slug: `im-${suffix}` },
  });
  wsId = ws.id;
});

describe("parseCsv (shared with the legacy route)", () => {
  it("handles quoted fields, embedded commas and escaped quotes", () => {
    const rows = parseCsv('name,email\n"Doe, Jane","jane@example.com"\n"Say ""hi""",x@y.co\n');
    expect(rows[1]).toEqual(["Doe, Jane", "jane@example.com"]);
    expect(rows[2]).toEqual(['Say "hi"', "x@y.co"]);
  });
});

describe("normalization", () => {
  it("lowercases emails and strips phone formatting without inventing a country code", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
    expect(normalizePhone("+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizePhone("555 123 4567")).toBe("5551234567");
  });
});

describe("mergeFields", () => {
  const existing = {
    name: "Old Name",
    email: "old@example.com",
    phone: null,
    channel: "web",
    tags: JSON.stringify(["vip"]),
    customFields: JSON.stringify({}),
  };
  it("fills empty fields only by default and never overwrites non-empty values", () => {
    const patch = mergeFields(existing, {
      name: "New Name",
      email: "new@example.com",
      phone: "+15550001111",
      tags: ["newtag"],
      company: "Acme",
    });
    expect(patch).not.toHaveProperty("name");
    expect(patch).not.toHaveProperty("email");
    expect(patch).not.toHaveProperty("tags");
    expect(patch.phone).toBe("+15550001111");
    expect(JSON.parse(patch.customFields as string).company).toBe("Acme");
  });

  it("overwrites only fields explicitly listed in overwriteFields", () => {
    const patch = mergeFields(
      existing,
      { name: "New Name", email: "new@example.com", phone: "+15550001111" },
      ["name", "bogus_field"]
    );
    expect(patch.name).toBe("New Name");
    expect(patch).not.toHaveProperty("email");
    expect(patch).not.toHaveProperty("bogus_field");
    expect(patch.phone).toBe("+15550001111"); // phone was empty, filled anyway
  });
});

describe("buildImportBatch", () => {
  it("default-maps common headers and validates rows", async () => {
    const built = await buildImportBatch(
      wsId,
      "basic.csv",
      "name,email,phone,tags,company\nValid Vera,vera@example.com,+15551234567,vip;gold,Acme\n,noname@example.com,,\nBad Email,not-an-email,123,\n"
    );
    expect(built.counts).toEqual({ total: 3, valid: 1, invalid: 2, duplicate: 0 });
    expect(built.rows[0].status).toBe("VALID");
    expect(built.rows[0].mapped.tags).toEqual(["vip", "gold"]);
    expect(built.rows[0].mapped.company).toBe("Acme");
    expect(built.rows[1].errors).toContain("name is required");
    expect(built.rows[2].errors.some((e) => e.includes("invalid email"))).toBe(true);
    expect(built.rows[2].errors.some((e) => e.includes("invalid phone"))).toBe(true);
  });

  it("accepts an explicit mapping object", async () => {
    const built = await buildImportBatch(
      wsId,
      "mapped.csv",
      "Full Name,E-mail Address\nMapped Mia,mia@example.com\n",
      { "Full Name": "name", "E-mail Address": "email" }
    );
    expect(built.rows[0].status).toBe("VALID");
    expect(built.rows[0].mapped).toMatchObject({ name: "Mapped Mia", email: "mia@example.com" });
  });

  it("detects duplicates by normalized email or phone, with a conflicting-field diff", async () => {
    await db.contact.create({
      data: {
        workspaceId: wsId,
        name: "Existing Eve",
        channel: "web",
        email: "eve@example.com",
        phone: "+15559998888",
        tags: JSON.stringify(["old"]),
      },
    });
    const built = await buildImportBatch(
      wsId,
      "dupes.csv",
      "name,email,phone\nNew Eve,eve@example.com,\nPhone Pete,,+1 (555) 999-8888\n"
    );
    expect(built.rows[0].status).toBe("DUPLICATE");
    expect(built.rows[0].matchedContactId).toBeTruthy();
    expect(built.rows[0].diff).toContainEqual({
      field: "name",
      existing: "Existing Eve",
      incoming: "New Eve",
    });
    expect(built.rows[1].status).toBe("DUPLICATE"); // phone match, formatting-insensitive
    expect(built.rows[1].matchedContactId).toBe(built.rows[0].matchedContactId);
  });
});

describe("applyImportResolutions", () => {
  it("creates, merges (empty-only) and skips in one transaction and returns a report", async () => {
    const existing = await db.contact.create({
      data: {
        workspaceId: wsId,
        name: "Merge Max",
        channel: "web",
        email: "max@example.com",
        phone: null,
        tags: JSON.stringify([]),
      },
    });
    const built = await buildImportBatch(
      wsId,
      "confirm.csv",
      "name,email,phone\nMerge Max,max@example.com,+15550002222\nFresh Fiona,fiona@example.com,\nSkippy Sam,sam@example.com,\n"
    );
    const [dupRow, freshRow, skipRow] = built.rows;
    expect(dupRow.status).toBe("DUPLICATE");
    const report = await applyImportResolutions(wsId, built.batchId, {
      [dupRow.id!]: "merge",
      [freshRow.id!]: "create",
      [skipRow.id!]: "skip",
    });
    expect(report).toMatchObject({ imported: 2, skipped: 1, failed: 0 });
    const merged = await db.contact.findUnique({ where: { id: existing.id } });
    expect(merged?.phone).toBe("+15550002222"); // empty field filled
    expect(merged?.name).toBe("Merge Max"); // non-empty value untouched
    const fresh = await db.contact.findFirst({ where: { workspaceId: wsId, email: "fiona@example.com" } });
    expect(fresh).toBeTruthy();
    const skippedContact = await db.contact.findFirst({ where: { workspaceId: wsId, email: "sam@example.com" } });
    expect(skippedContact).toBeNull();
    const batch = await db.importBatch.findUnique({ where: { id: built.batchId } });
    expect(batch?.status).toBe("CONFIRMED");
    // A second confirm is rejected, never double-applied.
    await expect(
      applyImportResolutions(wsId, built.batchId, {})
    ).rejects.toThrow("Import batch already confirmed");
  });

  it("an unresolved DUPLICATE defaults to skip — never silently merged", async () => {
    const existing = await db.contact.create({
      data: { workspaceId: wsId, name: "Quiet Quinn", channel: "web", email: "quinn@example.com" },
    });
    const built = await buildImportBatch(
      wsId,
      "default-skip.csv",
      "name,email\nChanged Quinn,quinn@example.com\n"
    );
    const report = await applyImportResolutions(wsId, built.batchId, {});
    expect(report).toMatchObject({ imported: 0, skipped: 1, failed: 0 });
    const untouched = await db.contact.findUnique({ where: { id: existing.id } });
    expect(untouched?.name).toBe("Quiet Quinn");
  });

  it("merge with an explicit overwriteFields list overwrites only those fields", async () => {
    const existing = await db.contact.create({
      data: { workspaceId: wsId, name: "Overwrite Ollie", channel: "web", email: "ollie@example.com" },
    });
    const built = await buildImportBatch(
      wsId,
      "overwrite.csv",
      "name,email\nRenamed Ollie,ollie@example.com\n"
    );
    const report = await applyImportResolutions(wsId, built.batchId, {
      [built.rows[0].id!]: { action: "merge", overwriteFields: ["name"] },
    });
    expect(report.imported).toBe(1);
    const after = await db.contact.findUnique({ where: { id: existing.id } });
    expect(after?.name).toBe("Renamed Ollie");
  });

  it("a suppressed contact re-imported and merged KEEPS its suppression and stays excluded", async () => {
    const contact = await db.contact.create({
      data: { workspaceId: wsId, name: "Suppressed Sid", channel: "email", email: "sid@example.com" },
    });
    await db.suppression.create({
      data: { workspaceId: wsId, contactId: contact.id, channel: null, reason: "opted out" },
    });
    const built = await buildImportBatch(
      wsId,
      "reimport-suppressed.csv",
      "name,email,phone\nSuppressed Sid,sid@example.com,+15550003333\n"
    );
    expect(built.rows[0].status).toBe("DUPLICATE");
    const report = await applyImportResolutions(wsId, built.batchId, {
      [built.rows[0].id!]: "merge",
    });
    expect(report.imported).toBe(1);
    // Same contactId, suppression row intact, still suppressed on every channel.
    const suppressions = await db.suppression.findMany({ where: { contactId: contact.id } });
    expect(suppressions.length).toBeGreaterThanOrEqual(1);
    expect(await isSuppressed(wsId, contact.id, "email")).toBe(true);
    expect((await getConsentState(wsId, contact.id, "email")).state).toBe("SUPPRESSED");
    const merged = await db.contact.findUnique({ where: { id: contact.id } });
    expect(merged?.phone).toBe("+15550003333");
  });

  it("consent columns write a ConsentRecord (source import); OPTED_OUT also suppresses", async () => {
    const built = await buildImportBatch(
      wsId,
      "consent.csv",
      "name,email,consent,consent_channel\nIn Ivy,ivy@example.com,opted_in,email\nOut Otto,otto@example.com,opted_out,email\n"
    );
    const report = await applyImportResolutions(wsId, built.batchId, {});
    expect(report.imported).toBe(2);
    const ivy = await db.contact.findFirst({ where: { workspaceId: wsId, email: "ivy@example.com" } });
    const otto = await db.contact.findFirst({ where: { workspaceId: wsId, email: "otto@example.com" } });
    const ivyRecord = await db.consentRecord.findFirst({
      where: { workspaceId: wsId, contactId: ivy!.id, channel: "email" },
    });
    expect(ivyRecord?.status).toBe("OPTED_IN");
    expect(ivyRecord?.source).toBe("import");
    const ottoRecord = await db.consentRecord.findFirst({
      where: { workspaceId: wsId, contactId: otto!.id, channel: "email" },
    });
    expect(ottoRecord?.status).toBe("OPTED_OUT");
    expect(await isSuppressed(wsId, otto!.id, "email")).toBe(true);
  });

  it("an INVALID row can never import, even with an explicit create resolution", async () => {
    const built = await buildImportBatch(wsId, "bad.csv", "name,email\n,missing-name@example.com\n");
    const report = await applyImportResolutions(wsId, built.batchId, {
      [built.rows[0].id!]: "create",
    });
    expect(report.failed).toBe(1);
    expect(report.errors[0].error).toContain("name is required");
    const ghost = await db.contact.findFirst({
      where: { workspaceId: wsId, email: "missing-name@example.com" },
    });
    expect(ghost).toBeNull();
  });
});
