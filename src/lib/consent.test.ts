/**
 * Consent ledger tests (Wave 2B). DB-backed, unique workspace per run.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { recordConsent, getConsentState, isSuppressed } from "./consent";

const suffix = `ct${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let wsId = "";

async function makeContact(name: string) {
  return db.contact.create({ data: { workspaceId: wsId, name, channel: "email" } });
}

beforeAll(async () => {
  const org = await db.organization.create({ data: { name: `CT Org ${suffix}` } });
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `CT WS ${suffix}`, slug: `ct-${suffix}` },
  });
  wsId = ws.id;
});

describe("getConsentState", () => {
  it("returns UNKNOWN when there is no record and no suppression", async () => {
    const contact = await makeContact("Unknown Uma");
    const state = await getConsentState(wsId, contact.id, "email");
    expect(state.state).toBe("UNKNOWN");
    expect(state.suppressed).toBe(false);
    expect(state.record).toBeNull();
  });

  it("returns the latest record's status when not suppressed", async () => {
    const contact = await makeContact("Opted Olga");
    await recordConsent(wsId, contact.id, "email", "OPTED_IN", "manual", "v1");
    const state = await getConsentState(wsId, contact.id, "email");
    expect(state.state).toBe("OPTED_IN");
    expect(state.record?.wordingVersion).toBe("v1");
  });

  it("a Suppression row ALWAYS beats a stale OPTED_IN record", async () => {
    const contact = await makeContact("Stale Sam");
    await recordConsent(wsId, contact.id, "whatsapp", "OPTED_IN", "manual");
    // Later opt-out via a suppression row (e.g. from the suppressions API).
    await db.suppression.create({
      data: { workspaceId: wsId, contactId: contact.id, channel: "whatsapp", reason: "opt-out" },
    });
    // Even a newer OPTED_IN record must not win over the suppression.
    await recordConsent(wsId, contact.id, "whatsapp", "OPTED_IN", "import");
    const state = await getConsentState(wsId, contact.id, "whatsapp");
    expect(state.state).toBe("SUPPRESSED");
    expect(state.suppressed).toBe(true);
    expect(state.record?.status).toBe("OPTED_IN"); // stale record still visible
  });

  it("an all-channel suppression blocks every channel; a channel suppression only its own", async () => {
    const contact = await makeContact("All Ali");
    await db.suppression.create({
      data: { workspaceId: wsId, contactId: contact.id, channel: null, reason: "all" },
    });
    expect(await isSuppressed(wsId, contact.id, "email")).toBe(true);
    expect(await isSuppressed(wsId, contact.id, "sms")).toBe(true);
    expect(await isSuppressed(wsId, contact.id)).toBe(true);

    const contact2 = await makeContact("Scoped Sara");
    await db.suppression.create({
      data: { workspaceId: wsId, contactId: contact2.id, channel: "email", reason: "email only" },
    });
    expect(await isSuppressed(wsId, contact2.id, "email")).toBe(true);
    expect(await isSuppressed(wsId, contact2.id, "sms")).toBe(false);
  });
});

describe("recordConsent", () => {
  it("OPTED_OUT also creates the Suppression row so ledger and enforcement agree", async () => {
    const contact = await makeContact("Out Omar");
    await recordConsent(wsId, contact.id, "sms", "OPTED_OUT", "manual");
    expect(await isSuppressed(wsId, contact.id, "sms")).toBe(true);
    const state = await getConsentState(wsId, contact.id, "sms");
    expect(state.state).toBe("SUPPRESSED");
  });

  it("OPTED_IN never removes an existing suppression", async () => {
    const contact = await makeContact("Sticky Sue");
    await recordConsent(wsId, contact.id, "email", "OPTED_OUT", "manual");
    expect(await isSuppressed(wsId, contact.id, "email")).toBe(true);
    await recordConsent(wsId, contact.id, "email", "OPTED_IN", "manual");
    expect(await isSuppressed(wsId, contact.id, "email")).toBe(true);
    expect((await getConsentState(wsId, contact.id, "email")).state).toBe("SUPPRESSED");
  });

  it("throws for a contact outside the workspace", async () => {
    await expect(recordConsent(wsId, "no-such-contact", "email", "OPTED_IN", "manual")).rejects.toThrow(
      "Contact not found"
    );
  });
});
