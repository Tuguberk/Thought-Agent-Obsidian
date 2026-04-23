import { App, TAbstractFile } from 'obsidian'
import type { DiagramIndexer } from './DiagramIndexer'

export class DiagramWatcher {
  private timers = new Map<string, number>()

  constructor(
    private app: App,
    private indexer: DiagramIndexer,
  ) {}

  register(): void {
    this.app.vault.on('create', (f: TAbstractFile) => {
      if (this.isExcalidrawPath(f.path)) this.debounce(f.path)
    })
    this.app.vault.on('modify', (f: TAbstractFile) => {
      if (this.isExcalidrawPath(f.path)) this.debounce(f.path)
    })
    this.app.vault.on('delete', (f: TAbstractFile) => {
      if (this.isExcalidrawPath(f.path)) {
        this.cancelDebounce(f.path)
        this.indexer.removeFromIndex(f.path)
      }
    })
  }

  private isExcalidrawPath(path: string): boolean {
    return path.endsWith('.excalidraw') || path.endsWith('.excalidraw.md')
  }

  private debounce(path: string): void {
    this.cancelDebounce(path)
    this.timers.set(path, activeWindow.setTimeout(() => {
      this.timers.delete(path)
      void this.indexer.reindexFile(path)
    }, 2000))
  }

  private cancelDebounce(path: string): void {
    const t = this.timers.get(path)
    if (t) { activeWindow.clearTimeout(t); this.timers.delete(path) }
  }
}
