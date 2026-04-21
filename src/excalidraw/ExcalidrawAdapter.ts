import { App, TFile } from 'obsidian'

export interface ExcalidrawElement {
  id: string
  type: 'rectangle' | 'ellipse' | 'diamond' | 'text' | 'arrow' | 'line' | 'freedraw' | 'image' | 'frame'
  x: number
  y: number
  width: number
  height: number
  text?: string
  startBinding?: { elementId: string; focus: number; gap: number }
  endBinding?: { elementId: string; focus: number; gap: number }
  boundElements?: { id: string; type: string }[]
  strokeColor?: string
  backgroundColor?: string
  fontSize?: number
  fontFamily?: number
  textAlign?: string
  label?: { text: string }
}

export interface ExcalidrawFile {
  type: 'excalidraw'
  version: 2
  elements: ExcalidrawElement[]
  appState?: object
}

function getExcalidrawAPI(app: App): unknown {
  const plugins = (app as unknown as {
    plugins?: { plugins?: Record<string, { ea?: unknown }> }
  }).plugins?.plugins
  return plugins?.['obsidian-excalidraw-plugin']?.ea ?? null
}

export class ExcalidrawAdapter {
  constructor(private app: App) {}

  get isAvailable(): boolean {
    return getExcalidrawAPI(this.app) !== null
  }

  async getElementsFromFile(filePath: string): Promise<ExcalidrawElement[]> {
    const file = this.app.vault.getAbstractFileByPath(filePath)
    if (!file) throw new Error(`File not found: ${filePath}`)
    const content = await this.app.vault.read(file as TFile)
    const parsed: ExcalidrawFile = JSON.parse(content)
    return parsed.elements ?? []
  }

  async readFile(filePath: string): Promise<ExcalidrawFile> {
    const file = this.app.vault.getAbstractFileByPath(filePath)
    if (!file) throw new Error(`File not found: ${filePath}`)
    const content = await this.app.vault.read(file as TFile)
    return JSON.parse(content) as ExcalidrawFile
  }

  async writeFile(filePath: string, content: ExcalidrawFile): Promise<void> {
    const json = JSON.stringify(content, null, 2)
    const existing = this.app.vault.getAbstractFileByPath(filePath)
    if (existing) {
      await this.app.vault.modify(existing as TFile, json)
    } else {
      const parts = filePath.split('/')
      if (parts.length > 1) {
        const folder = parts.slice(0, -1).join('/')
        try { await this.app.vault.createFolder(folder) } catch { /* exists */ }
      }
      await this.app.vault.create(filePath, json)
    }
  }

  async addElementsToActiveView(elements: ExcalidrawElement[]): Promise<boolean> {
    const api = getExcalidrawAPI(this.app) as {
      addElementsToView?: (els: ExcalidrawElement[], scroll?: boolean, zoom?: boolean) => Promise<void>
    } | null
    if (!api) return false
    try {
      await api.addElementsToView?.(elements, false, false)
      return true
    } catch {
      return false
    }
  }
}
