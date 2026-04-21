import { ItemView, WorkspaceLeaf } from 'obsidian'

export const GRAPH_VIEW_TYPE = 'ai-agent-graph'

interface GraphNode {
  id: string
  title: string
  x?: number
  y?: number
  vx?: number
  vy?: number
}

interface GraphEdge {
  from: string
  to: string
}

export class GraphQueryView extends ItemView {
  private nodes: GraphNode[] = []
  private edges: GraphEdge[] = []
  private filterDescription = ''
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private animFrame: number | null = null

  constructor(leaf: WorkspaceLeaf) {
    super(leaf)
  }

  getViewType(): string {
    return GRAPH_VIEW_TYPE
  }

  getDisplayText(): string {
    return 'AI Graph View'
  }

  getIcon(): string {
    return 'git-fork'
  }

  setGraphData(nodes: Array<{ path: string; title: string }>, edges: Array<{ from: string; to: string }>, filterDescription: string): void {
    this.nodes = nodes.map(n => ({ id: n.path, title: n.title }))
    this.edges = edges
    this.filterDescription = filterDescription
    this.initLayout()
    this.renderGraph()
  }

  async onOpen(): Promise<void> {
    this.buildUI()
  }

  onClose(): Promise<void> {
    if (this.animFrame) cancelAnimationFrame(this.animFrame)
    return Promise.resolve()
  }

  private buildUI(): void {
    const container = this.containerEl.children[1] as HTMLElement
    container.empty()
    container.addClass('ai-graph-container')

    const toolbar = container.createDiv('ai-graph-toolbar')
    toolbar.createEl('span', { text: this.filterDescription || 'Filtered Graph', cls: 'ai-graph-filter-label' })

    const closeBtn = toolbar.createEl('button', { text: 'Close' })
    closeBtn.onclick = () => this.leaf.detach()

    this.canvas = container.createEl('canvas', { cls: 'ai-graph-canvas' })
    this.ctx = this.canvas.getContext('2d')

    const resizeObserver = new ResizeObserver(() => this.resizeCanvas())
    resizeObserver.observe(container)
    this.resizeCanvas()

    this.canvas.addEventListener('click', (e) => this.handleCanvasClick(e))

    if (this.nodes.length > 0) {
      this.initLayout()
      this.renderGraph()
    }
  }

  private resizeCanvas(): void {
    if (!this.canvas) return
    const container = this.canvas.parentElement!
    this.canvas.width = container.clientWidth
    this.canvas.height = container.clientHeight - 40
    this.renderGraph()
  }

  private initLayout(): void {
    if (!this.canvas) return
    const w = this.canvas.width || 800
    const h = this.canvas.height || 600

    for (const node of this.nodes) {
      node.x = Math.random() * (w - 100) + 50
      node.y = Math.random() * (h - 100) + 50
      node.vx = 0
      node.vy = 0
    }

    this.simulateForce(50)
  }

  private simulateForce(iterations: number): void {
    if (!this.canvas) return
    const w = this.canvas.width || 800
    const h = this.canvas.height || 600
    const nodeMap = new Map(this.nodes.map(n => [n.id, n]))

    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < this.nodes.length; i++) {
        for (let j = i + 1; j < this.nodes.length; j++) {
          const a = this.nodes[i]
          const b = this.nodes[j]
          const dx = (b.x ?? 0) - (a.x ?? 0)
          const dy = (b.y ?? 0) - (a.y ?? 0)
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          const repulsion = 3000 / (dist * dist)
          const fx = (dx / dist) * repulsion
          const fy = (dy / dist) * repulsion
          a.vx = (a.vx ?? 0) - fx
          a.vy = (a.vy ?? 0) - fy
          b.vx = (b.vx ?? 0) + fx
          b.vy = (b.vy ?? 0) + fy
        }
      }

      for (const edge of this.edges) {
        const a = nodeMap.get(edge.from)
        const b = nodeMap.get(edge.to)
        if (!a || !b) continue
        const dx = (b.x ?? 0) - (a.x ?? 0)
        const dy = (b.y ?? 0) - (a.y ?? 0)
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const spring = (dist - 100) * 0.05
        const fx = (dx / dist) * spring
        const fy = (dy / dist) * spring
        a.vx = (a.vx ?? 0) + fx
        a.vy = (a.vy ?? 0) + fy
        b.vx = (b.vx ?? 0) - fx
        b.vy = (b.vy ?? 0) - fy
      }

      for (const node of this.nodes) {
        node.x = Math.max(30, Math.min(w - 30, (node.x ?? 0) + (node.vx ?? 0)))
        node.y = Math.max(30, Math.min(h - 30, (node.y ?? 0) + (node.vy ?? 0)))
        node.vx = (node.vx ?? 0) * 0.8
        node.vy = (node.vy ?? 0) * 0.8
      }
    }
  }

  private renderGraph(): void {
    if (!this.ctx || !this.canvas) return
    const ctx = this.ctx
    const w = this.canvas.width
    const h = this.canvas.height

    ctx.clearRect(0, 0, w, h)

    const isDark = document.body.classList.contains('theme-dark')
    const edgeColor = isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'
    const nodeColor = isDark ? '#7c6af7' : '#6b57d1'
    const textColor = isDark ? '#e0e0e0' : '#333'

    const nodeMap = new Map(this.nodes.map(n => [n.id, n]))

    ctx.strokeStyle = edgeColor
    ctx.lineWidth = 1
    for (const edge of this.edges) {
      const a = nodeMap.get(edge.from)
      const b = nodeMap.get(edge.to)
      if (!a || !b) continue
      ctx.beginPath()
      ctx.moveTo(a.x ?? 0, a.y ?? 0)
      ctx.lineTo(b.x ?? 0, b.y ?? 0)
      ctx.stroke()
    }

    for (const node of this.nodes) {
      ctx.beginPath()
      ctx.arc(node.x ?? 0, node.y ?? 0, 8, 0, Math.PI * 2)
      ctx.fillStyle = nodeColor
      ctx.fill()

      ctx.fillStyle = textColor
      ctx.font = '11px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(node.title.slice(0, 20), node.x ?? 0, (node.y ?? 0) + 20)
    }
  }

  private handleCanvasClick(e: MouseEvent): void {
    if (!this.canvas) return
    const rect = this.canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    for (const node of this.nodes) {
      const dx = (node.x ?? 0) - mx
      const dy = (node.y ?? 0) - my
      if (Math.sqrt(dx * dx + dy * dy) < 12) {
        const file = this.app.vault.getFileByPath(node.id)
        if (file) {
          this.app.workspace.openLinkText(node.id, '', false)
        }
        break
      }
    }
  }
}
