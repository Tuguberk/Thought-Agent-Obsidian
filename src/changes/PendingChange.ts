import { App, TFile } from 'obsidian'
import type { ExcalidrawFile, ExcalidrawElement } from '../excalidraw/ExcalidrawAdapter'
import type { DiagramSpec } from '../excalidraw/DiagramLayoutEngine'

export interface DiffHunk {
  before: string
  after: string
  lineStart?: number
}

export type PendingChange =
  | { kind: 'create'; note: { path: string; content: string; tags: string[] } }
  | { kind: 'edit'; notePath: string; originalContent: string; newContent: string; diff: DiffHunk[] }
  | { kind: 'link'; notePath: string; originalContent: string; insertionPoint: number; linkText: string }
  | { kind: 'reorganize'; steps: PendingChange[]; description: string }
  | { kind: 'create_diagram'; filePath: string; content: ExcalidrawFile; spec: DiagramSpec }
  | { kind: 'update_diagram'; filePath: string; originalContent: ExcalidrawFile; updatedContent: ExcalidrawFile; diffSummary: string }
  | { kind: 'annotate_diagram'; diagramPath: string; notePath: string; diagramAddition: ExcalidrawElement; noteAddition: string }

export async function openChangedFile(app: App, path: string): Promise<void> {
  const isDiagram = path.endsWith('.excalidraw') || path.endsWith('.excalidraw.md')
  if (isDiagram) {
    const file = app.vault.getFileByPath(path)
    if (file instanceof TFile) {
      const leaf = app.workspace.getLeaf('tab')
      await leaf.openFile(file)
    }
  } else {
    await app.workspace.openLinkText(path, '', false)
  }
}

export function getChangePrimaryPath(change: PendingChange): string | null {
  switch (change.kind) {
    case 'create':          return change.note.path
    case 'edit':            return change.notePath
    case 'link':            return change.notePath
    case 'create_diagram':  return change.filePath
    case 'update_diagram':  return change.filePath
    case 'annotate_diagram': return change.diagramPath
    case 'reorganize': {
      for (const step of change.steps) {
        const p = getChangePrimaryPath(step)
        if (p) return p
      }
      return null
    }
  }
}
