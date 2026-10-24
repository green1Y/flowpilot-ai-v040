import { db } from "@/lib/db";

export interface ChunkOptions {
  /** Max characters per chunk (measured before overlap is prepended). */
  chunkSize?: number;
  /** Trailing characters of the previous chunk prepended to each chunk. */
  overlap?: number;
}

const DEFAULT_CHUNK_SIZE = 600;
const DEFAULT_OVERLAP = 100;

/**
 * Split text into chunks on sentence/word boundaries — never mid-word.
 *
 * Strategy: normalize whitespace, split into sentences, greedily pack
 * sentences into chunks of <= chunkSize chars. Over-long sentences are
 * hard-split on word boundaries. Afterwards each chunk (from the second on)
 * gets up to `overlap` chars of the previous chunk's tail prepended, cut at
 * a word boundary so nothing ever splits a word.
 */
export function chunkText(content: string, opts: ChunkOptions = {}): string[] {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;

  const text = content.replace(/\s+/g, " ").trim();
  if (!text) return [];

  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);

  const raw: string[] = [];
  let current = "";

  const flush = (buf: string) => {
    const trimmed = buf.trim();
    if (trimmed) raw.push(trimmed);
  };

  /** Append a segment (one sentence or less) to the chunk being built. */
  const append = (segment: string) => {
    const candidate = current ? `${current} ${segment}` : segment;
    if (candidate.length <= chunkSize) {
      current = candidate;
    } else {
      flush(current);
      current = segment;
    }
  };

  for (const sentence of sentences) {
    if (sentence.length > chunkSize) {
      // Hard-split an over-long sentence on word boundaries only.
      const words = sentence.split(/\s+/).filter(Boolean);
      let buf = "";
      for (const word of words) {
        const candidate = buf ? `${buf} ${word}` : word;
        if (candidate.length > chunkSize) {
          append(buf);
          buf = word;
        } else {
          buf = candidate;
        }
      }
      if (buf) append(buf);
    } else {
      append(sentence);
    }
  }
  flush(current);

  if (overlap <= 0 || raw.length <= 1) return raw;

  // Prepend a word-boundary-safe tail of the previous chunk for context.
  const withOverlap: string[] = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const prev = withOverlap[i - 1];
    let tail = prev.slice(-overlap);
    // Drop a leading partial word so chunks never start mid-word; if there
    // is no word boundary in the tail (e.g. one very long word), drop the
    // overlap entirely rather than risk splitting a word.
    const firstSpace = tail.indexOf(" ");
    if (firstSpace > 0 && firstSpace < tail.length - 1) {
      tail = tail.slice(firstSpace + 1);
    } else {
      tail = "";
    }
    withOverlap.push(tail ? `${tail} ${raw[i]}` : raw[i]);
  }
  return withOverlap;
}

/**
 * Rebuild the chunk index for one knowledge doc: deletes existing chunks,
 * then recreates them from the doc content. Chunks carry the doc's
 * workspaceId so retrieval stays tenant-scoped.
 *
 * @returns number of chunks created.
 */
export async function indexDocument(docId: string): Promise<number> {
  const doc = await db.knowledgeDoc.findUnique({ where: { id: docId } });
  if (!doc) throw new Error(`Knowledge doc not found: ${docId}`);

  await db.knowledgeChunk.deleteMany({ where: { docId } });

  const chunks = chunkText(doc.content);
  if (chunks.length === 0) return 0;

  await db.knowledgeChunk.createMany({
    data: chunks.map((content, i) => ({
      docId,
      workspaceId: doc.workspaceId,
      chunkIndex: i,
      content,
    })),
  });
  return chunks.length;
}
