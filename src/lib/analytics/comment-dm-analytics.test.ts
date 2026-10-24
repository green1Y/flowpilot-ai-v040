/**
 * commentDmRuleAnalytics tests — real test-DB rows, written not run in
 * this wave (parallel waves share test.db; the coordinator runs the
 * suite serially). Covers per-rule aggregation, tenant isolation, the
 * duplicatesPrevented count from actions JSON, and empty-range zeros.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { commentDmRuleAnalytics } from "./queries";

const suffix = `cdma-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let orgA = "";
let wsA = "";
let wsB = "";
let ruleA = "";
let ruleB = "";

const NOW = new Date("2026-10-19T12:00:00Z");
const DAY = 86_400_000;
const from = new Date(NOW.getTime() - 7 * DAY);
const to = NOW;

async function event(ws: string, rule: string, comment: string, status: string, actions: unknown[] = []) {
  return db.commentDmEvent.create({
    data: {
      workspaceId: ws,
      ruleId: rule,
      commentId: comment,
      matched: true,
      keyword: "link",
      actions: JSON.stringify(actions),
      status,
      createdAt: new Date(NOW.getTime() - DAY),
    },
  });
}

beforeAll(async () => {
  const org = await db.organization.create({ data: { name: `CDMA Org ${suffix}` } });
  orgA = org.id;
  const wA = await db.workspace.create({ data: { orgId: org.id, name: `CDMA A ${suffix}`, slug: `cdma-a-${suffix}` } });
  const wB = await db.workspace.create({ data: { orgId: org.id, name: `CDMA B ${suffix}`, slug: `cdma-b-${suffix}` } });
  wsA = wA.id;
  wsB = wB.id;
  const rA = await db.commentDmRule.create({
    data: { workspaceId: wsA, integrationId: "ig-1", name: "Rule A", mediaId: "m-a", keywords: '["link"]' },
  });
  const rB = await db.commentDmRule.create({
    data: { workspaceId: wsA, integrationId: "ig-1", name: "Rule B", mediaId: "m-b", keywords: '["price"]' },
  });
  ruleA = rA.id;
  ruleB = rB.id;
  // Rule A: 3 comments — 2 sent, 1 failed; first event also carries two
  // suppressed redeliveries.
  await event(wsA, ruleA, "c1", "SENT", [
    { type: "private_reply", status: "sent" },
    { type: "duplicate_suppressed", status: "suppressed" },
    { type: "duplicate_suppressed", status: "suppressed" },
  ]);
  await event(wsA, ruleA, "c2", "SENT");
  await event(wsA, ruleA, "c3", "FAILED");
  // Rule B: 1 dry run.
  await event(wsA, ruleB, "c4", "DRY_RUN");
  // Other workspace: must never leak into wsA results.
  const rOther = await db.commentDmRule.create({
    data: { workspaceId: wsB, integrationId: "ig-1", name: "Other", mediaId: "m-x", keywords: '["link"]' },
  });
  await event(wsB, rOther.id, "c9", "SENT");
});

afterAll(async () => {
  await db.commentDmEvent.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } }).catch(() => undefined);
  await db.commentDmRule.deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } }).catch(() => undefined);
  await db.workspace.deleteMany({ where: { id: { in: [wsA, wsB] } } }).catch(() => undefined);
  await db.organization.delete({ where: { id: orgA } }).catch(() => undefined);
});

describe("commentDmRuleAnalytics", () => {
  it("aggregates per-rule counts, reply rate, and duplicates prevented", async () => {
    const rows = await commentDmRuleAnalytics(wsA, from, to);
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.ruleId === ruleA)!;
    expect(a.ruleName).toBe("Rule A");
    expect(a.mediaId).toBe("m-a");
    expect(a.comments).toBe(3);
    expect(a.matches).toBe(3);
    expect(a.sent).toBe(2);
    expect(a.failed).toBe(1);
    expect(a.dryRuns).toBe(0);
    expect(a.duplicatesPrevented).toBe(2);
    expect(a.replyRate).toBeCloseTo((2 / 3) * 100);
    const b = rows.find((r) => r.ruleId === ruleB)!;
    expect(b.comments).toBe(1);
    expect(b.dryRuns).toBe(1);
    expect(b.replyRate).toBe(0);
  });

  it("is tenant-isolated and returns [] for an empty range", async () => {
    const rowsB = await commentDmRuleAnalytics(wsB, from, to);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].comments).toBe(1);
    const empty = await commentDmRuleAnalytics(wsA, new Date("2020-01-01"), new Date("2020-01-02"));
    expect(empty).toEqual([]);
  });
});
