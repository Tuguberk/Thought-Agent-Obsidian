import { App, TFile, Notice } from 'obsidian'
import type { PendingChange } from './PendingChange'
import type { ExcalidrawAdapter } from '../excalidraw/ExcalidrawAdapter'

export class ChangeApplier {
  constructor(private app: App, private excalidraw?: ExcalidrawAdapter) {}

  async apply(change: PendingChange): Promise<void> {
    switch (change.kind) {
      case 'create':
        await this.applyCreate(change)
        break
      case 'edit':
        await this.applyEdit(change)
        break
      case 'link':
        await this.applyLink(change)
        break
      case 'reorganize':
        for (const step of change.steps) {
          await this.apply(step)
        }
        break
      case 'create_diagram':
        await this.applyCreateDiagram(change)
        break
      case 'update_diagram':
        await this.applyUpdateDiagram(change)
        break
      case 'annotate_diagram':
        await this.applyAnnotateDiagram(change)
        break
    }
  }

  private async applyCreate(change: Extract<PendingChange, { kind: 'create' }>): Promise<void> {
    const existing = this.app.vault.getFileByPath(change.note.path)
    if (existing) {
      await this.app.vault.modify(existing, change.note.content)
    } else {
      const parts = change.note.path.split('/')
      if (parts.length > 1) {
        const folder = parts.slice(0, -1).join('/')
        try {
          await this.app.vault.createFolder(folder)
        } catch {
          // folder may already exist
        }
      }
      await this.app.vault.create(change.note.path, change.note.content)
    }
    new Notice(`Created: ${change.note.path}`)
  }

  private async applyEdit(change: Extract<PendingChange, { kind: 'edit' }>): Promise<void> {
    const file = this.app.vault.getFileByPath(change.notePath)
    if (!file || !(file instanceof TFile)) {
      throw new Error(`File not found: ${change.notePath}`)
    }
    await this.app.vault.modify(file, change.newContent)
    new Notice(`Edited: ${change.notePath}`)
  }

  private async applyLink(change: Extract<PendingChange, { kind: 'link' }>): Promise<void> {
    const file = this.app.vault.getFileByPath(change.notePath)
    if (!file || !(file instanceof TFile)) {
      throw new Error(`File not found: ${change.notePath}`)
    }
    const content = change.originalContent
    const before = content.slice(0, change.insertionPoint)
    const after = content.slice(change.insertionPoint)
    const newContent = before + '\n' + change.linkText + '\n' + after
    await this.app.vault.modify(file, newContent)
    new Notice(`Linked: ${change.notePath}`)
  }

  private async applyCreateDiagram(change: Extract<PendingChange, { kind: 'create_diagram' }>): Promise<void> {
    if (!this.excalidraw) throw new Error('Excalidraw adapter not available')
    await this.excalidraw.writeFile(change.filePath, change.content)
    new Notice(`Diagram created: ${change.filePath}`)
  }

  private async applyUpdateDiagram(change: Extract<PendingChange, { kind: 'update_diagram' }>): Promise<void> {
    if (!this.excalidraw) throw new Error('Excalidraw adapter not available')
    await this.excalidraw.writeFile(change.filePath, change.updatedContent)
    new Notice(`Diagram updated: ${change.filePath}`)
  }

  private async applyAnnotateDiagram(change: Extract<PendingChange, { kind: 'annotate_diagram' }>): Promise<void> {
    if (!this.excalidraw) throw new Error('Excalidraw adapter not available')

    // Update note
    const noteFile = this.app.vault.getFileByPath(change.notePath)
    if (noteFile instanceof TFile) {
      const current = await this.app.vault.read(noteFile)
      await this.app.vault.modify(noteFile, current + '\n' + change.noteAddition)
    }

    // Update diagram
    const diagram = await this.excalidraw.readFile(change.diagramPath)
    diagram.elements.push(change.diagramAddition)
    await this.excalidraw.writeFile(change.diagramPath, diagram)

    new Notice(`Annotated: ${change.notePath} ↔ ${change.diagramPath}`)
  }
}
