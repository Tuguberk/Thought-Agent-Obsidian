import type { Chunk } from "./Chunker";
import { cosineSimilarity } from "../utils/cosine";

export interface DiagramChunk {
  id: string
  diagramPath: string
  title: string
  content: string
  embedding: number[]
  nodeCount: number
  edgeCount: number
}

export interface VectorStoreData {
  chunks: Chunk[];
  diagrams?: DiagramChunk[];
  version: number;
}

export class VectorStore {
  private chunks: Map<string, Chunk> = new Map();
  private diagrams: Map<string, DiagramChunk> = new Map();
  private dataPath: string;
  private saveScheduled = false;

  constructor(dataPath: string) {
    this.dataPath = dataPath;
  }

  private getVaultAdapter(): {
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
  } {
    const app = (
      window as unknown as {
        app?: {
          vault?: {
            adapter?: {
              read(path: string): Promise<string>;
              write(path: string, data: string): Promise<void>;
            };
          };
        };
      }
    ).app;
    const adapter = app?.vault?.adapter;
    if (!adapter) throw new Error("Obsidian vault adapter is not available");
    return adapter;
  }

  async load(): Promise<void> {
    try {
      const raw = await this.getVaultAdapter().read(this.dataPath);
      const data: VectorStoreData = JSON.parse(raw);
      this.chunks = new Map(data.chunks.map((c) => [c.id, c]));
      this.diagrams = new Map((data.diagrams ?? []).map((d) => [d.id, d]));
    } catch {
      this.chunks = new Map();
      this.diagrams = new Map();
    }
  }

  async save(): Promise<void> {
    const data: VectorStoreData = {
      chunks: Array.from(this.chunks.values()),
      diagrams: Array.from(this.diagrams.values()),
      version: 1,
    };
    await this.getVaultAdapter().write(this.dataPath, JSON.stringify(data));
  }

  scheduleSave(): void {
    if (this.saveScheduled) return;
    this.saveScheduled = true;
    setTimeout(() => {
      void this.save().finally(() => { this.saveScheduled = false; });
    }, 2000);
  }

  upsertChunks(chunks: Chunk[]): void {
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, chunk);
    }
    this.scheduleSave();
  }

  removeChunksForNote(notePath: string): void {
    for (const [id, chunk] of this.chunks) {
      if (chunk.notePath === notePath) {
        this.chunks.delete(id);
      }
    }
  }

  getAllChunks(): Chunk[] {
    return Array.from(this.chunks.values());
  }

  getChunksForNote(notePath: string): Chunk[] {
    return Array.from(this.chunks.values()).filter(
      (c) => c.notePath === notePath,
    );
  }

  getChunkById(id: string): Chunk | undefined {
    return this.chunks.get(id);
  }

  size(): number {
    return this.chunks.size;
  }

  noteCount(): number {
    const paths = new Set(
      Array.from(this.chunks.values()).map((c) => c.notePath),
    );
    return paths.size;
  }

  // ── Diagram methods ───────────────────────────────────────────────────────

  upsertDiagram(chunk: DiagramChunk): void {
    this.diagrams.set(chunk.id, chunk);
    this.scheduleSave();
  }

  removeDiagram(id: string): void {
    this.diagrams.delete(id);
    this.scheduleSave();
  }

  getAllDiagrams(): DiagramChunk[] {
    return Array.from(this.diagrams.values());
  }

  searchDiagrams(queryEmbedding: number[], topK = 3): Array<{ chunk: DiagramChunk; score: number }> {
    const results = Array.from(this.diagrams.values()).map((d) => ({
      chunk: d,
      score: cosineSimilarity(queryEmbedding, d.embedding),
    }))
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  diagramCount(): number {
    return this.diagrams.size;
  }
}
