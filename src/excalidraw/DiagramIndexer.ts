import { App, TFile } from 'obsidian'
import { DiagramExtractor } from './DiagramExtractor'
import { embed } from '../retrieval/Embedder'
import type { VectorStore } from '../retrieval/VectorStore'

export class DiagramIndexer {
  private extractor = new DiagramExtractor()
  private indexing = false

  constructor(
    private app: App,
    private store: VectorStore,
  ) {}

  async reindexAll(): Promise<void> {
    if (this.indexing) return
    this.indexing = true
    const files = this.app.vault.getFiles().filter((f) => f.path.endsWith('.excalidraw'))
    for (const file of files) {
      await this.reindexFile(file.path)
    }
    this.indexing = false
  }

  async reindexFile(filePath: string): Promise<void> {
    try {
      const file = this.app.vault.getAbstractFileByPath(filePath)
      if (!(file instanceof TFile)) return
      const content = await this.app.vault.read(file)
      const extracted = this.extractor.extract(filePath, content)
      const embedding = await embed(extracted.rawTextContent)
      this.store.upsertDiagram({
        id: `diagram:${filePath}`,
        diagramPath: filePath,
        title: extracted.title,
        content: extracted.rawTextContent,
        embedding,
        nodeCount: extracted.nodes.length,
        edgeCount: extracted.edges.length,
      })
    } catch (e) {
      console.error(`[DiagramIndexer] Failed to index ${filePath}:`, e)
    }
  }

  removeFromIndex(filePath: string): void {
    this.store.removeDiagram(`diagram:${filePath}`)
  }
}
