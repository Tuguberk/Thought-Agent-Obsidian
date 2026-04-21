import { App } from "obsidian";
import type { SearchResult } from "./HybridSearch";
import type { VectorStore } from "./VectorStore";
import { cosineSimilarity } from "../utils/cosine";

export function graphEnhancedRetrieval(
  app: App,
  results: SearchResult[],
  queryEmbedding: number[],
  store: VectorStore,
  neighborPenalty = 0.6,
): SearchResult[] {
  const seenPaths = new Set(results.map((r) => r.chunk.notePath));
  const neighborChunks: SearchResult[] = [];
  const resolvedLinks =
    (
      app.metadataCache as unknown as {
        resolvedLinks?: Record<string, Record<string, number>>;
      }
    ).resolvedLinks ?? {};

  const getBacklinkPaths = (notePath: string): string[] => {
    const paths: string[] = [];
    for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
      if (targets && Object.prototype.hasOwnProperty.call(targets, notePath)) {
        paths.push(sourcePath);
      }
    }
    return paths;
  };

  for (const result of results) {
    const file = app.vault.getFileByPath(result.chunk.notePath);
    if (!file) continue;

    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;

    const linkedPaths = new Set<string>();

    if (cache.links) {
      for (const link of cache.links) {
        const resolved = app.metadataCache.getFirstLinkpathDest(
          link.link,
          file.path,
        );
        if (resolved) linkedPaths.add(resolved.path);
      }
    }

    for (const path of getBacklinkPaths(file.path)) {
      linkedPaths.add(path);
    }

    for (const linkedPath of linkedPaths) {
      if (seenPaths.has(linkedPath)) continue;
      seenPaths.add(linkedPath);

      const summaryChunks = store
        .getChunksForNote(linkedPath)
        .filter((c) => c.level === 1);
      for (const chunk of summaryChunks) {
        if (!chunk.embedding || chunk.embedding.length === 0) continue;
        const sim = cosineSimilarity(queryEmbedding, chunk.embedding);
        neighborChunks.push({ chunk, score: sim * neighborPenalty });
      }
    }
  }

  return [...results, ...neighborChunks];
}
