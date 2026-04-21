import { App, TFile, Notice } from 'obsidian'
import { chunkNote, type Chunk } from './Chunker'
import { embed, embedBatch } from './Embedder'
import type { VectorStore } from './VectorStore'
import type AIAgentPlugin from '../main'

export class Indexer {
  private app: App
  private store: VectorStore
  private plugin: AIAgentPlugin
  private indexing = false

  constructor(app: App, store: VectorStore, plugin: AIAgentPlugin) {
    this.app = app
    this.store = store
    this.plugin = plugin
  }

  async reindexAll(): Promise<void> {
    if (this.indexing) {
      new Notice('Indexing already in progress.')
      return
    }

    this.indexing = true
    const files = this.app.vault.getMarkdownFiles()
    new Notice(`Indexing ${files.length} notes...`)

    let done = 0
    for (const file of files) {
      await this.indexFile(file)
      done++
      if (done % 10 === 0) {
        new Notice(`Indexing... ${done}/${files.length}`, 1000)
      }
    }

    this.plugin.settings.indexedNotesCount = this.store.noteCount()
    this.plugin.settings.indexedChunksCount = this.store.size()
    this.plugin.settings.lastIndexedAt = new Date().toISOString()
    await this.plugin.saveSettings()

    await this.store.save()
    this.indexing = false
    new Notice(`Indexing complete: ${this.store.noteCount()} notes, ${this.store.size()} chunks.`)
  }

  async indexFile(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file)
      const title = file.basename
      const rawChunks = chunkNote(file.path, title, content)

      this.store.removeChunksForNote(file.path)

      const texts = rawChunks.map(c => c.content)
      const embeddings = await embedBatch(texts)

      const chunks: Chunk[] = rawChunks.map((c, i) => ({
        ...c,
        embedding: embeddings[i],
      }))

      this.store.upsertChunks(chunks)
    } catch (e) {
      console.error(`Failed to index ${file.path}:`, e)
    }
  }

  async indexSingleFile(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file)
      const title = file.basename
      const rawChunks = chunkNote(file.path, title, content)

      this.store.removeChunksForNote(file.path)

      for (const rawChunk of rawChunks) {
        const embedding = await embed(rawChunk.content)
        this.store.upsertChunks([{ ...rawChunk, embedding }])
      }

      this.plugin.settings.indexedNotesCount = this.store.noteCount()
      this.plugin.settings.indexedChunksCount = this.store.size()
      await this.plugin.saveSettings()
    } catch (e) {
      console.error(`Failed to index ${file.path}:`, e)
    }
  }

  registerWatcher(): void {
    this.app.vault.on('modify', async (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        await this.indexSingleFile(file)
      }
    })

    this.app.vault.on('create', async (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        await this.indexSingleFile(file)
      }
    })

    this.app.vault.on('delete', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        this.store.removeChunksForNote(file.path)
        this.store.scheduleSave()
      }
    })

    this.app.vault.on('rename', async (file, oldPath) => {
      if (file instanceof TFile && file.extension === 'md') {
        this.store.removeChunksForNote(oldPath)
        await this.indexSingleFile(file)
      }
    })
  }
}
