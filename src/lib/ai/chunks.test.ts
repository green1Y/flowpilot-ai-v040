/**
 * Stage 4c chunking tests: boundary behavior, overlap, never-mid-word
 * guarantee, and the indexDocument rebuild cycle.
 */
import { describe, it, expect, afterAll } from "vitest";
import { db } from "@/lib/db";
import { chunkText, indexDocument } from "./chunks";

const LONG_TEXT = Array.from(
  { length: 40 },
  (_, i) =>
    `Sentence number ${i + 1} explains one small fact about our store policies in plain words.`
).join(" ");

describe("chunkText", () => {
  it("returns a single normalized chunk for short text", () => {
    const out = chunkText("  Hello   world. ");
    expect(out).toEqual(["Hello world."]);
  });

  it("returns [] for empty/whitespace input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\t ")).toEqual([]);
  });

  it("splits long text into multiple chunks within size + overlap bounds", () => {
    const out = chunkText(LONG_TEXT, { chunkSize: 600, overlap: 100 });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.length).toBeLessThanOrEqual(700); // chunkSize + overlap
    }
  });

  it("never splits mid-word: every chunk is made of complete source words", () => {
    const out = chunkText(LONG_TEXT, { chunkSize: 600, overlap: 100 });
    const sourceWords = new Set(LONG_TEXT.replace(/\s+/g, " ").split(" "));
    for (const c of out) {
      for (const word of c.split(/\s+/)) {
        expect(sourceWords.has(word)).toBe(true);
      }
    }
  });

  it("overlaps consecutive chunks on shared words", () => {
    const out = chunkText(LONG_TEXT, { chunkSize: 600, overlap: 100 });
    const firstWords = out[0].split(/\s+/);
    const secondWords = out[1].split(/\s+/);
    // The second chunk must start with words taken from the first chunk's tail.
    const sharedPrefix = secondWords.slice(0, 5).join(" ");
    expect(out[0]).toContain(sharedPrefix);
    expect(firstWords.length).toBeGreaterThan(5);
  });

  it("keeps chunks at sentence boundaries when possible", () => {
    const text = "First sentence here. Second sentence here. Third sentence here.";
    const out = chunkText(text, { chunkSize: 40, overlap: 0 });
    // "First sentence here." (20) + " Second sentence here." (22) = 42 > 40,
    // so chunk 1 holds the first sentence alone.
    expect(out[0]).toBe("First sentence here.");
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it("hard-splits over-long sentences on word boundaries only", () => {
    const sentence = Array.from({ length: 50 }, () => "word").join(" ") + ".";
    const out = chunkText(sentence, { chunkSize: 60, overlap: 0 });
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.length).toBeLessThanOrEqual(60);
      expect(c).not.toMatch(/\S{61,}/); // no chunk holds a fragment longer than chunkSize
    }
    // Reassembling the chunks (space-joined) recovers the sentence.
    expect(out.join(" ")).toBe(sentence);
  });

  it("respects custom options", () => {
    const out = chunkText(LONG_TEXT, { chunkSize: 200, overlap: 0 });
    for (const c of out) expect(c.length).toBeLessThanOrEqual(200);
    expect(out.length).toBeGreaterThan(chunkText(LONG_TEXT).length);
  });
});

describe("indexDocument", () => {
  const orgNames: string[] = [];
  let seq = 0;

  async function makeWorkspace() {
    seq += 1;
    const org = await db.organization.create({ data: { name: `Chunk Org ${Date.now()}-${seq}` } });
    orgNames.push(org.name);
    return db.workspace.create({
      data: { orgId: org.id, name: `Chunk WS ${seq}`, slug: `chunk-ws-${Date.now()}-${seq}` },
    });
  }

  afterAll(async () => {
    if (orgNames.length > 0) {
      await db.organization.deleteMany({ where: { name: { in: orgNames } } });
    }
    await db.$disconnect();
  });

  it("creates tenant-scoped chunks and rebuilds them on re-index", async () => {
    const ws = await makeWorkspace();
    const doc = await db.knowledgeDoc.create({
      data: { workspaceId: ws.id, title: "Policies", content: LONG_TEXT },
    });

    const count = await indexDocument(doc.id);
    expect(count).toBe(chunkText(LONG_TEXT).length);
    expect(count).toBeGreaterThan(1);

    const chunks = await db.knowledgeChunk.findMany({
      where: { docId: doc.id },
      orderBy: { chunkIndex: "asc" },
    });
    expect(chunks).toHaveLength(count);
    // Tenant scoping + ordering are stored on every chunk.
    for (const [i, c] of chunks.entries()) {
      expect(c.workspaceId).toBe(ws.id);
      expect(c.chunkIndex).toBe(i);
    }

    // Re-index after a content change replaces (not appends) chunks.
    await db.knowledgeDoc.update({ where: { id: doc.id }, data: { content: "Short new content here." } });
    const count2 = await indexDocument(doc.id);
    expect(count2).toBe(1);
    const chunks2 = await db.knowledgeChunk.findMany({ where: { docId: doc.id } });
    expect(chunks2).toHaveLength(1);
    expect(chunks2[0].content).toBe("Short new content here.");
  });

  it("throws for an unknown doc id", async () => {
    await expect(indexDocument("nope-not-a-doc")).rejects.toThrow("Knowledge doc not found");
  });
});
