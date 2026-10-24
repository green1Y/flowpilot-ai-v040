import { db } from "@/lib/db";

export interface RetrievedChunk {
  docId: string;
  docTitle: string;
  chunkContent: string;
  score: number;
}

/**
 * Knowledge retrieval for grounding AI replies.
 *
 * HONEST NOTE: this is keyword-based retrieval (token overlap scoring), not
 * vector/semantic search — SQLite has no embedding index, and adding one
 * would change the storage story. The scoring logic is isolated in
 * `scoreChunks` so a future embedding-based scorer can replace it without
 * touching callers.
 */

/** Lowercase word tokens; drops tokens shorter than 3 chars (stop-word noise). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/** Count whole-token occurrences of `term` inside a pre-tokenized array. */
function countOccurrences(term: string, tokens: string[]): number {
  let n = 0;
  for (const t of tokens) if (t === term) n += 1;
  return n;
}

/**
 * Pure scoring step: score = sum over distinct query terms of
 * (occurrences in chunk content) + 2 × (occurrences in doc title).
 * Title matches are weighted ×2 so a clearly-titled doc ("Shipping policy")
 * ranks above incidental mentions in long docs.
 */
export function scoreChunks(
  query: string,
  chunks: Array<{ docId: string; docTitle: string; chunkContent: string }>
): RetrievedChunk[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];

  const scored: RetrievedChunk[] = [];
  for (const c of chunks) {
    const titleTokens = tokenize(c.docTitle);
    const bodyTokens = tokenize(c.chunkContent);
    let score = 0;
    for (const term of terms) {
      score += countOccurrences(term, bodyTokens) + 2 * countOccurrences(term, titleTokens);
    }
    if (score > 0) scored.push({ ...c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId));
  return scored;
}

/**
 * Retrieve the top-K knowledge chunks for a query within one workspace.
 * Tenant-scoped by workspaceId; returns at most topK scored chunks.
 */
export async function retrieveKnowledge(
  workspaceId: string,
  query: string,
  topK = 4
): Promise<RetrievedChunk[]> {
  if (!query.trim()) return [];
  const chunks = await db.knowledgeChunk.findMany({
    where: { workspaceId },
    select: { docId: true, content: true, doc: { select: { title: true } } },
    orderBy: [{ docId: "asc" }, { chunkIndex: "asc" }],
  });
  const scored = scoreChunks(
    query,
    chunks.map((c) => ({ docId: c.docId, docTitle: c.doc.title, chunkContent: c.content }))
  );
  return scored.slice(0, Math.max(0, topK));
}

/** Format a retrieved chunk as a grounding snippet for the AI provider. */
export function chunkToSnippet(c: RetrievedChunk): string {
  return `${c.docTitle}: ${c.chunkContent}`;
}
