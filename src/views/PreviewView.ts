import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice } from 'obsidian'
import type { PendingChange } from '../changes/PendingChange'
import type { ChangeApplier } from '../changes/ChangeApplier'

export const PREVIEW_VIEW_TYPE = 'ai-agent-preview'

export interface PreviewCallbacks {
  onApprove: (change: PendingChange) => void
  onReject: (change: PendingChange) => void
}

export class PreviewView extends ItemView {
  private change: PendingChange | null = null
  private applier: ChangeApplier
  private callbacks: PreviewCallbacks
  private handled = false

  constructor(leaf: WorkspaceLeaf, applier: ChangeApplier, callbacks: PreviewCallbacks) {
    super(leaf)
    this.applier = applier
    this.callbacks = callbacks
  }

  getViewType(): string { return PREVIEW_VIEW_TYPE }
  getDisplayText(): string {
    if (this.change?.kind === 'create') return `Create: ${this.change.note.path.split('/').pop()}`
    if (this.change?.kind === 'edit') return `Edit: ${this.change.notePath.split('/').pop()}`
    if (this.change?.kind === 'create_diagram') return `Diagram: ${this.change.spec.title}`
    if (this.change?.kind === 'update_diagram') return `Update diagram: ${this.change.filePath.split('/').pop()}`
    if (this.change?.kind === 'annotate_diagram') return `Annotate: ${this.change.diagramPath.split('/').pop()}`
    return 'AI preview'
  }
  getIcon(): string { return 'eye' }

  setPendingChange(change: PendingChange): void {
    this.change = change
    this.renderChange()
  }

  getPendingChange(): PendingChange | null { return this.change }

  markHandled(): void { this.handled = true }

  onOpen(): Promise<void> {
    if (this.change) this.renderChange()
    return Promise.resolve()
  }

  onClose(): Promise<void> {
    if (!this.handled && this.change) this.callbacks.onReject(this.change)
    return Promise.resolve()
  }

  private async doApprove(): Promise<void> {
    if (!this.change) return
    try {
      await this.applier.apply(this.change)
      const change = this.change
      this.change = null
      this.callbacks.onApprove(change)
      this.leaf.detach()
    } catch (e) {
      new Notice(`Failed to apply change: ${e.message}`)
    }
  }

  private doReject(): void {
    if (!this.change) return
    const change = this.change
    this.change = null
    this.callbacks.onReject(change)
    this.leaf.detach()
  }

  private renderChange(): void {
    const container = this.containerEl.children[1] as HTMLElement
    container.empty()
    container.addClass('ai-preview-container')

    if (!this.change) {
      container.createEl('p', { text: 'No pending changes.' })
      return
    }

    this.renderHeader(container)

    switch (this.change.kind) {
      case 'create':         this.renderCreate(container, this.change); break
      case 'edit':           this.renderEdit(container, this.change); break
      case 'link':           this.renderLink(container, this.change); break
      case 'reorganize':     this.renderReorganize(container, this.change); break
      case 'create_diagram': this.renderCreateDiagram(container, this.change); break
      case 'update_diagram': this.renderUpdateDiagram(container, this.change); break
      case 'annotate_diagram': this.renderAnnotateDiagram(container, this.change); break
    }
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv('ai-preview-header')
    const kindLabel = this.change!.kind.charAt(0).toUpperCase() + this.change!.kind.slice(1)
    header.createEl('h2', { text: `Proposed: ${kindLabel}` })

    const actions = header.createDiv('ai-preview-actions')

    const approveBtn = actions.createEl('button', { text: 'Approve', cls: 'mod-cta' })
    approveBtn.onclick = () => this.doApprove()

    const rejectBtn = actions.createEl('button', { text: 'Reject' })
    rejectBtn.onclick = () => this.doReject()
  }

  private renderCreate(container: HTMLElement, change: Extract<PendingChange, { kind: 'create' }>): void {
    container.createEl('p', { text: `Path: ${change.note.path}`, cls: 'ai-preview-meta' })
    if (change.note.tags.length > 0) {
      container.createEl('p', { text: `Tags: ${change.note.tags.join(', ')}`, cls: 'ai-preview-meta' })
    }
    container.createEl('h3', { text: 'Content preview' })
    const preview = container.createDiv('ai-preview-content')
    void MarkdownRenderer.render(this.app, change.note.content, preview, '', this)
  }

  private renderEdit(container: HTMLElement, change: Extract<PendingChange, { kind: 'edit' }>): void {
    container.createEl('p', { text: `File: ${change.notePath}`, cls: 'ai-preview-meta' })
    const diffContainer = container.createDiv('ai-diff-container')
    const beforeCol = diffContainer.createDiv('ai-diff-before')
    const afterCol = diffContainer.createDiv('ai-diff-after')
    beforeCol.createEl('h3', { text: 'Before' })
    beforeCol.createEl('pre').createEl('code', { text: change.originalContent })
    afterCol.createEl('h3', { text: 'After' })
    afterCol.createEl('pre').createEl('code', { text: change.newContent })
  }

  private renderLink(container: HTMLElement, change: Extract<PendingChange, { kind: 'link' }>): void {
    container.createEl('p', { text: `File: ${change.notePath}`, cls: 'ai-preview-meta' })
    container.createEl('p', { text: `Link: ${change.linkText}`, cls: 'ai-preview-meta' })
    const preview = container.createDiv('ai-preview-content')
    const c = change.originalContent
    const before = c.slice(Math.max(0, change.insertionPoint - 100), change.insertionPoint)
    const after = c.slice(change.insertionPoint, change.insertionPoint + 100)
    preview.createEl('p', { text: `...${before}` })
    preview.createEl('strong', { text: ` ${change.linkText} ` })
    preview.createEl('p', { text: `${after}...` })
  }

  private renderReorganize(container: HTMLElement, change: Extract<PendingChange, { kind: 'reorganize' }>): void {
    container.createEl('p', { text: change.description, cls: 'ai-preview-meta' })
    container.createEl('h3', { text: `${change.steps.length} steps` })
    for (let i = 0; i < change.steps.length; i++) {
      const step = change.steps[i]
      const stepEl = container.createDiv('ai-reorganize-step')
      const stepHeader = stepEl.createDiv('ai-reorganize-step-header')
      stepHeader.createEl('span', { text: `Step ${i + 1}: ${step.kind}` })
      const skipBtn = stepHeader.createEl('button', { text: 'Skip' })
      skipBtn.onclick = () => { change.steps.splice(i, 1); this.renderChange() }
      if (step.kind === 'create') stepEl.createEl('code', { text: step.note.path })
      else if (step.kind === 'edit') stepEl.createEl('code', { text: step.notePath })
      else if (step.kind === 'link') stepEl.createEl('code', { text: `${step.notePath} → ${step.linkText}` })
    }
  }

  private renderCreateDiagram(container: HTMLElement, change: Extract<PendingChange, { kind: 'create_diagram' }>): void {
    const typeLabel = change.spec.type.replace('-', ' ').toUpperCase()
    container.createEl('span', { text: typeLabel, cls: 'ai-diagram-badge' })

    container.createEl('p', { text: `File: ${change.filePath}`, cls: 'ai-preview-meta' })
    container.createEl('p', { text: `${change.spec.nodes.length} nodes · ${change.spec.edges.length} edges`, cls: 'ai-preview-meta' })

    container.createEl('h3', { text: 'Nodes' })
    const nodeList = container.createEl('ul')
    const max = Math.min(change.spec.nodes.length, 20)
    for (let i = 0; i < max; i++) {
      const n = change.spec.nodes[i]
      nodeList.createEl('li', { text: n.label + (n.level !== undefined ? ` (level ${n.level})` : '') })
    }
    if (change.spec.nodes.length > 20) {
      nodeList.createEl('li', { text: `… and ${change.spec.nodes.length - 20} more` })
    }

    if (change.spec.edges.length > 0) {
      container.createEl('h3', { text: 'Edges' })
      const edgeList = container.createEl('ul')
      const maxE = Math.min(change.spec.edges.length, 15)
      for (let i = 0; i < maxE; i++) {
        const e = change.spec.edges[i]
        const fromNode = change.spec.nodes.find((n) => n.id === e.from)
        const toNode = change.spec.nodes.find((n) => n.id === e.to)
        const label = e.label ? ` [${e.label}]` : ''
        edgeList.createEl('li', { text: `${fromNode?.label ?? e.from} → ${toNode?.label ?? e.to}${label}` })
      }
      if (change.spec.edges.length > 15) {
        edgeList.createEl('li', { text: `… and ${change.spec.edges.length - 15} more` })
      }
    }

    container.createEl('p', { text: `After approval, this file will be created: ${change.filePath}`, cls: 'ai-preview-meta' })
  }

  private renderUpdateDiagram(container: HTMLElement, change: Extract<PendingChange, { kind: 'update_diagram' }>): void {
    container.createEl('p', { text: `File: ${change.filePath}`, cls: 'ai-preview-meta' })
    container.createEl('p', { text: change.diffSummary, cls: 'ai-preview-meta' })
    const origCount = change.originalContent.elements.length
    const newCount = change.updatedContent.elements.length
    container.createEl('p', { text: `Elements: ${origCount} → ${newCount} (+${newCount - origCount})`, cls: 'ai-preview-meta' })
    container.createEl('p', { text: `After approval, ${change.filePath} will be modified.`, cls: 'ai-preview-meta' })
  }

  private renderAnnotateDiagram(container: HTMLElement, change: Extract<PendingChange, { kind: 'annotate_diagram' }>): void {
    container.createEl('p', { text: `Note: ${change.notePath}`, cls: 'ai-preview-meta' })
    container.createEl('p', { text: `Diagram: ${change.diagramPath}`, cls: 'ai-preview-meta' })

    const panels = container.createDiv('ai-annotate-panels')

    const left = panels.createDiv()
    left.createEl('h3', { text: 'Note addition' })
    left.createEl('pre').createEl('code', { text: change.noteAddition })

    const right = panels.createDiv()
    right.createEl('h3', { text: 'Diagram addition' })
    right.createEl('p', { text: `Text element added: "${change.diagramAddition.text ?? ''}"` })
    right.createEl('p', { text: `Position: bottom-right corner` })
  }
}
