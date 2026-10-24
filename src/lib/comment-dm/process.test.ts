/**
 * Rule processor tests — real test-DB rows, stubbed send paths (no Meta
 * traffic). Covers: live send + personalization + privateRepliedAt stamp,
 * redelivery dedupe (no second event, no second send), dry-run, no-match,
 * expired window, already-replied, and private-reply failure → FAILED.
 *
 * NOTE: these tests are written, not run, in this wave (parallel waves
 * share test.db; the coordinator runs the suite serially).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { processCommentForRules } from "./process";

const suffix = `cdm-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let orgId = "";
let wsId = "";
let contactId = "";

const NOW = new Date("2026-10-19T12:00:00Z");
const DAY = 86_400_000;

async function makeRule(overrides: Record<string, unknown> = {}) {
  return db.commentDmRule.create({
    data: {
      workspaceId: wsId,
      integrationId: "ig-int-1",
      name: `Rule ${suffix}`,
      mediaId: "media-1",
      keywords: JSON.stringify(["link"]),
      matchMode: "contains",
      caseSensitive: false,
      commentReply: "Thanks! Check your DMs.",
      dmTemplate: "Hi {{name}}, here is your {{keyword}}!",
      timezone: "UTC",
      enabled: true,
      dryRun: false,
      ...overrides,
    },
  });
}

async function makeComment(externalId: string, overrides: Record<string, unknown> = {}) {
  return db.comment.create({
    data: {
      workspaceId: wsId,
      contactId,
      integrationId: "ig-int-1",
      externalId,
      authorExternalId: "author-1",
      authorName: "Sam",
      mediaId: "media-1",
      text: "please send link",
      commentedAt: NOW,
      privateReplyEligibleUntil: new Date(NOW.getTime() + 7 * DAY),
      ...overrides,
    },
  });
}

beforeAll(async () => {
  const org = await db.organization.create({ data: { name: `CDM Org ${suffix}` } });
  orgId = org.id;
  const ws = await db.workspace.create({
    data: { orgId: org.id, name: `CDM WS ${suffix}`, slug: `cdm-${suffix}` },
  });
  wsId = ws.id;
  const contact = await db.contact.create({
    data: { workspaceId: ws.id, name: "Sam", externalIds: JSON.stringify({ IGSID: "author-1" }), channel: "instagram" },
  });
  contactId = contact.id;
});

afterAll(async () => {
  await db.commentDmEvent.deleteMany({ where: { workspaceId: wsId } }).catch(() => undefined);
  await db.commentDmRule.deleteMany({ where: { workspaceId: wsId } }).catch(() => undefined);
  await db.comment.deleteMany({ where: { workspaceId: wsId } }).catch(() => undefined);
  await db.contact.deleteMany({ where: { workspaceId: wsId } }).catch(() => undefined);
  await db.workspace.delete({ where: { id: wsId } }).catch(() => undefined);
  await db.organization.delete({ where: { id: orgId } }).catch(() => undefined);
});

describe("processCommentForRules", () => {
  it("sends public + private replies, personalizes from the Contact, stamps privateRepliedAt", async () => {
    const rule = await makeRule();
    const comment = await makeComment(`c-live-${suffix}`);
    const sent: { kind: string; body: string }[] = [];
    const res = await processCommentForRules(
      { workspaceId: wsId, integrationId: "ig-int-1", commentId: comment.externalId, mediaId: "media-1", commentText: "please send LINK", commentedAt: NOW },
      {
        now: NOW,
        sendPublicReply: async (a) => { sent.push({ kind: "public", body: a.body }); return { externalId: "pub-1" }; },
        sendPrivateReply: async (a) => { sent.push({ kind: "private", body: a.body }); return { externalId: "priv-1" }; },
      }
    );
    const r = res.results.find((x) => x.ruleId === rule.id);
    expect(r?.status).toBe("SENT");
    expect(r?.keyword).toBe("link");
    expect(sent).toHaveLength(2);
    // {{name}} came from the verified Contact record ("Sam"), not invented.
    expect(sent.find((s) => s.kind === "private")?.body).toBe("Hi Sam, here is your link!");
    const events = await db.commentDmEvent.findMany({ where: { workspaceId: wsId, ruleId: rule.id } });
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("SENT");
    const updated = await db.comment.findUnique({ where: { id: comment.id } });
    expect(updated?.privateRepliedAt).not.toBeNull();
  });

  it("redelivery creates NO second event and NO second send", async () => {
    const rule = await makeRule({ mediaId: "media-dup" });
    const comment = await makeComment(`c-dup-${suffix}`, { mediaId: "media-dup" });
    let sends = 0;
    const sender = async () => { sends += 1; return { externalId: "x" }; };
    const input = { workspaceId: wsId, integrationId: "ig-int-1", commentId: comment.externalId, mediaId: "media-dup", commentText: "link please", commentedAt: NOW };
    const first = await processCommentForRules(input, { now: NOW, sendPublicReply: sender, sendPrivateReply: sender });
    expect(first.results.find((x) => x.ruleId === rule.id)?.status).toBe("SENT");
    const second = await processCommentForRules(input, { now: NOW, sendPublicReply: sender, sendPrivateReply: sender });
    const dup = second.results.find((x) => x.ruleId === rule.id);
    expect(dup?.duplicate).toBe(true);
    expect(dup?.status).toBe("DUPLICATE");
    expect(sends).toBe(2); // one public + one private from the FIRST call only
    const events = await db.commentDmEvent.findMany({ where: { workspaceId: wsId, ruleId: rule.id } });
    expect(events).toHaveLength(1);
    expect(String(events[0].actions)).toContain("duplicate_suppressed");
  });

  it("dry-run records DRY_RUN and sends nothing", async () => {
    const rule = await makeRule({ mediaId: "media-dry", dryRun: true });
    const comment = await makeComment(`c-dry-${suffix}`, { mediaId: "media-dry" });
    let sends = 0;
    const sender = async () => { sends += 1; return { externalId: "x" }; };
    const res = await processCommentForRules(
      { workspaceId: wsId, integrationId: "ig-int-1", commentId: comment.externalId, mediaId: "media-dry", commentText: "link", commentedAt: NOW },
      { now: NOW, sendPublicReply: sender, sendPrivateReply: sender }
    );
    expect(res.results.find((x) => x.ruleId === rule.id)?.status).toBe("DRY_RUN");
    expect(sends).toBe(0);
    const events = await db.commentDmEvent.findMany({ where: { workspaceId: wsId, ruleId: rule.id } });
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("DRY_RUN");
  });

  it("non-matching comments produce no event and no send", async () => {
    const rule = await makeRule({ mediaId: "media-nomatch" });
    const comment = await makeComment(`c-nomatch-${suffix}`, { mediaId: "media-nomatch" });
    let sends = 0;
    const sender = async () => { sends += 1; return { externalId: "x" }; };
    const res = await processCommentForRules(
      { workspaceId: wsId, integrationId: "ig-int-1", commentId: comment.externalId, mediaId: "media-nomatch", commentText: "nice photo!", commentedAt: NOW },
      { now: NOW, sendPublicReply: sender, sendPrivateReply: sender }
    );
    expect(res.results.find((x) => x.ruleId === rule.id)?.status).toBe("NO_MATCH");
    expect(sends).toBe(0);
    expect(await db.commentDmEvent.count({ where: { workspaceId: wsId, ruleId: rule.id } })).toBe(0);
  });

  it("expired window and already-replied comments are SKIPPED without sending", async () => {
    const ruleExpired = await makeRule({ mediaId: "media-exp" });
    const old = await makeComment(`c-exp-${suffix}`, {
      mediaId: "media-exp",
      commentedAt: new Date(NOW.getTime() - 10 * DAY),
      privateReplyEligibleUntil: new Date(NOW.getTime() - 3 * DAY),
    });
    const ruleReplied = await makeRule({ mediaId: "media-rep" });
    const replied = await makeComment(`c-rep-${suffix}`, {
      mediaId: "media-rep",
      privateRepliedAt: NOW,
    });
    let sends = 0;
    const sender = async () => { sends += 1; return { externalId: "x" }; };
    const r1 = await processCommentForRules(
      { workspaceId: wsId, integrationId: "ig-int-1", commentId: old.externalId, mediaId: "media-exp", commentText: "link", commentedAt: new Date(NOW.getTime() - 10 * DAY) },
      { now: NOW, sendPublicReply: sender, sendPrivateReply: sender }
    );
    const r2 = await processCommentForRules(
      { workspaceId: wsId, integrationId: "ig-int-1", commentId: replied.externalId, mediaId: "media-rep", commentText: "link", commentedAt: NOW },
      { now: NOW, sendPublicReply: sender, sendPrivateReply: sender }
    );
    expect(r1.results.find((x) => x.ruleId === ruleExpired.id)?.status).toBe("SKIPPED");
    expect(r2.results.find((x) => x.ruleId === ruleReplied.id)?.status).toBe("SKIPPED");
    expect(sends).toBe(0);
    expect(await db.commentDmEvent.count({ where: { workspaceId: wsId, ruleId: ruleExpired.id, status: "SKIPPED" } })).toBe(1);
  });

  it("private-reply failure records FAILED with a sanitized error and no stamp", async () => {
    const rule = await makeRule({ mediaId: "media-fail" });
    const comment = await makeComment(`c-fail-${suffix}`, { mediaId: "media-fail" });
    const res = await processCommentForRules(
      { workspaceId: wsId, integrationId: "ig-int-1", commentId: comment.externalId, mediaId: "media-fail", commentText: "link", commentedAt: NOW },
      {
        now: NOW,
        sendPublicReply: async () => ({ externalId: "pub-1" }),
        sendPrivateReply: async () => { throw new Error("Meta error 551: private reply window expired"); },
      }
    );
    expect(res.results.find((x) => x.ruleId === rule.id)?.status).toBe("FAILED");
    const events = await db.commentDmEvent.findMany({ where: { workspaceId: wsId, ruleId: rule.id } });
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("FAILED");
    expect(events[0].error).toContain("551");
    const updated = await db.comment.findUnique({ where: { id: comment.id } });
    expect(updated?.privateRepliedAt).toBeNull();
  });

  it("disabled rules are never evaluated", async () => {
    await makeRule({ mediaId: "media-off", enabled: false });
    const comment = await makeComment(`c-off-${suffix}`, { mediaId: "media-off" });
    const res = await processCommentForRules(
      { workspaceId: wsId, integrationId: "ig-int-1", commentId: comment.externalId, mediaId: "media-off", commentText: "link", commentedAt: NOW },
      { now: NOW }
    );
    expect(res.results).toHaveLength(0);
  });
});
