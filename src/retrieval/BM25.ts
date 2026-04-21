import type { Chunk } from "./Chunker";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function termFreq(term: string, tokens: string[]): number {
  return tokens.filter((t) => t === term).length;
}

export function bm25(
  query: string,
  chunks: Chunk[],
  k1 = 1.5,
  b = 0.75,
): Array<{ chunk: Chunk; score: number }> {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0)
    return chunks.map((c) => ({ chunk: c, score: 0 }));

  const tokenizedChunks = chunks.map((c) => tokenize(c.content));
  const avgDocLen =
    tokenizedChunks.reduce((s, t) => s + t.length, 0) /
    (tokenizedChunks.length || 1);

  const df: Record<string, number> = {};
  for (const term of queryTerms) {
    df[term] = tokenizedChunks.filter((tokens) => tokens.includes(term)).length;
  }

  return chunks.map((chunk, i) => {
    const tokens = tokenizedChunks[i];
    const docLen = tokens.length;
    let score = 0;

    for (const term of queryTerms) {
      const tf = termFreq(term, tokens);
      if (tf === 0) continue;
      const idf = Math.log(
        (chunks.length - df[term] + 0.5) / (df[term] + 0.5) + 1,
      );
      const norm = 1 - b + b * (docLen / avgDocLen);
      score += (idf * (tf * (k1 + 1))) / (tf + k1 * norm);
    }

    return { chunk, score };
  });
}
