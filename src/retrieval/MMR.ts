import { cosineSimilarity } from '../utils/cosine'
import type { SearchResult } from './HybridSearch'

export function mmr(candidates: SearchResult[], finalK: number, lambda = 0.7): SearchResult[] {
  if (candidates.length === 0) return []

  const selected: SearchResult[] = []
  const remaining = [...candidates]

  while (selected.length < finalK && remaining.length > 0) {
    let bestIdx = 0
    let bestScore = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      const relevance = candidate.score

      let redundancy = 0
      if (selected.length > 0) {
        redundancy = Math.max(
          ...selected.map(s =>
            cosineSimilarity(candidate.chunk.embedding, s.chunk.embedding)
          )
        )
      }

      const mmrScore = lambda * relevance - (1 - lambda) * redundancy
      if (mmrScore > bestScore) {
        bestScore = mmrScore
        bestIdx = i
      }
    }

    selected.push(remaining[bestIdx])
    remaining.splice(bestIdx, 1)
  }

  return selected
}
