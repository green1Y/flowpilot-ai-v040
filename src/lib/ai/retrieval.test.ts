/**
 * Stage 4c retrieval tests: keyword scoring/ranking on a small fixture,
 * plus tenant isolation through the DB-backed retrieveKnowledge.
 */
import { describe, it, expect, afterAll } from "vitest";
import { db } from "@/lib/db";
import { tokenize, scoreChunks, retrieveKnowledge } from "./retrieval";
import { indexDocument } from "./chunks";

const FIXTURE = [
  {
    docId: "doc-shipping",
    docTitle: "Shipping policy",
    chunkContent: "Standard shipping takes 3 to 5 business days. Express shipping is available at checkout.",
  },
  {
    docId: "doc-returns",
    docTitle: "Returns",
    chunkContent: "We offer a 30-day return window for unused items in original packaging.",
  },
  {
    docId: "doc-pricing",
    docTitle: "Pricing",
    chunkContent: "Our plans are Starter, Growth and Agency. Shipping costs are calculated at checkout.",
  },
];

describe("tokenize", () => {
  it("lowercases and drops tokens shorter than 3 chars", () => {
    expect(tokenize("How LONG does Shipping take?")).toEqual(["how", "long", "does", "shipping", "take"]);
    expect(tokenize("a an of it to")).toEqual([]);
  });
});

describe("scoreChunks", () => {
  it("ranks the most relevant chunk first", () => {
    const ranked = scoreChunks("how long does shipping take", FIXTURE);
    expect(ranked[0].docId).toBe("doc-shipping");
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it("weights title matches x2 over incidental body mentions", () => {
    // "shipping" appears once in the pricing body but the shipping doc has it in title + body.
    const ranked = scoreChunks("shipping", FIXTURE);
    const shipping = ranked.find((r) => r.docId === "doc-shipping")!;
    const pricing = ranked.find((r) => r.docId === "doc-pricing")!;
    expect(shipping.score).toBeGreaterThan(pricing.score);
  });

  it("returns no chunks when nothing matches", () => {
    expect(scoreChunks("quantum entanglement", FIXTURE)).toEqual([]);
  });

  it("returns no chunks for stop-word-only queries", () => {
    expect(scoreChunks("a an of it to", FIXTURE)).toEqual([]);
  });

  it("sums occurrences across repeated query terms only once (deduped terms)", () => {
    const once = scoreChunks("shipping shipping", FIXTURE);
    const single = scoreChunks("shipping", FIXTURE);
    expect(once[0].score).toBe(single[0].score);
  });

  it("is case-insensitive", () => {
    const lower = scoreChunks("shipping", FIXTURE);
    const upper = scoreChunks("SHIPPING", FIXTURE);
    expect(upper.map((r) => r.docId)).toEqual(lower.map((r) => r.docId));
  });
});

describe("retrieveKnowledge (DB-backed)", () => {
  const orgNames: string[] = [];
  let seq = 0;

  async function makeWorkspace() {
    seq += 1;
    const org = await db.organization.create({ data: { name: `Ret Org ${Date.now()}-${seq}` } });
    orgNames.push(org.name);
    return db.workspace.create({
      data: { orgId: org.id, name: `Ret WS ${seq}`, slug: `ret-ws-${Date.now()}-${seq}` },
    });
  }

  afterAll(async () => {
    if (orgNames.length > 0) {
      await db.organization.deleteMany({ where: { name: { in: orgNames } } });
    }
    await db.$disconnect();
  });

  it("is tenant-scoped and honors topK", async () => {
    const wsA = await makeWorkspace();
    const wsB = await makeWorkspace();

    const docA = await db.knowledgeDoc.create({
      data: { workspaceId: wsA.id, title: "Shipping policy", content: "Shipping takes 3 to 5 business days for every order." },
    });
    const docB = await db.knowledgeDoc.create({
      data: { workspaceId: wsB.id, title: "Secret shipping", content: "Other tenant shipping secrets here." },
    });
    await indexDocument(docA.id);
    await indexDocument(docB.id);

    const hits = await retrieveKnowledge(wsA.id, "shipping", 4);
    expect(hits.length).toBeGreaterThan(0);
    // Nothing from the other tenant leaks in.
    expect(hits.every((h) => h.docId === docA.id)).toBe(true);
    expect(hits[0].docTitle).toBe("Shipping policy");

    const limited = await retrieveKnowledge(wsA.id, "shipping", 1);
    expect(limited.length).toBeLessThanOrEqual(1);

    expect(await retrieveKnowledge(wsA.id, "   ")).toEqual([]);
  });
});
