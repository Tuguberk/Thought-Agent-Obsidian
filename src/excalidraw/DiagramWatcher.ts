import { App, TAbstractFile } from 'obsidian'
import type { DiagramIndexer } from './DiagramIndexer'

export class DiagramWatcher {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private app: App,
    private indexer: DiagramIndexer,
  ) {}

  register(): void {
    this.app.vault.on('create', (f: TAbstractFile) => {
      if (f.path.endsWith('.excalidraw')) this.debounce(f.path)
    })
    this.app.vault.on('modify', (f: TAbstractFile) => {
      if (f.path.endsWith('.excalidraw')) this.debounce(f.path)
    })
    this.app.vault.on('delete', (f: TAbstractFile) => {
      if (f.path.endsWith('.excalidraw')) {
        this.cancelDebounce(f.path)
        this.indexer.removeFromIndex(f.path)
      }
    })
  }

  private debounce(path: string): void {
    this.cancelDebounce(path)
    this.timers.set(path, setTimeout(() => {
      this.timers.delete(path)
      void this.indexer.reindexFile(path)
    }, 2000))
  }

  private cancelDebounce(path: string): void {
    const t = this.timers.get(path)
    if (t) { clearTimeout(t); this.timers.delete(path) }
  }
}
