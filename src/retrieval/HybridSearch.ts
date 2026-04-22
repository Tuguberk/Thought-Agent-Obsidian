import { cosineSimilarity, normalizeScores } from '../utils/cosine'
import { bm25 } from './BM25'
import type { Chunk } from './Chunker'

export interface SearchResult {
  chunk: Chunk
  score: number
}

export function hybridSearch(
  queryEmbedding: number[],
  queryText: string,
  chunks: Chunk[],
  topK = 10,
): SearchResult[] {
  if (chunks.length === 0) return []

  // No query embedding (mobile / API key not set) — fall back to BM25 only
  if (queryEmbedding.length === 0) {
    const bm25Results = bm25(queryText, chunks)
    bm25Results.sort((a, b) => b.score - a.score)
    return bm25Results.slice(0, topK)
  }

  // Hybrid: only score chunks that actually have embeddings
  const chunksWithEmbeddings = chunks.filter(c => c.embedding && c.embedding.length > 0)
  if (chunksWithEmbeddings.length === 0) {
    // Chunks exist but none have embeddings yet — BM25 fallback
    const bm25Results = bm25(queryText, chunks)
    bm25Results.sort((a, b) => b.score - a.score)
    return bm25Results.slice(0, topK)
  }

  const semanticRaw = chunksWithEmbeddings.map(c => cosineSimilarity(queryEmbedding, c.embedding))
  const semanticNorm = normalizeScores(semanticRaw)

  const bm25Results = bm25(queryText, chunksWithEmbeddings)
  const bm25Raw = bm25Results.map(r => r.score)
  const bm25Norm = normalizeScores(bm25Raw)

  const combined: SearchResult[] = chunksWithEmbeddings.map((chunk, i) => ({
    chunk,
    score: 0.7 * semanticNorm[i] + 0.3 * bm25Norm[i],
  }))

  combined.sort((a, b) => b.score - a.score)
  return combined.slice(0, topK)
}
