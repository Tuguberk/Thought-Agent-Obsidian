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
