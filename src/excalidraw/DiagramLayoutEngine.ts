import type { ExcalidrawElement, ExcalidrawFile } from './ExcalidrawAdapter'

export interface SpecNode {
  id: string
  label: string
  level?: number
  shape?: 'rect' | 'ellipse' | 'diamond'
  timestamp?: string
}

export interface SpecEdge {
  from: string
  to: string
  label?: string
}

export interface DiagramSpec {
  type: 'mindmap' | 'flowchart' | 'timeline' | 'entity-graph'
  title: string
  nodes: SpecNode[]
  edges: SpecEdge[]
}

// ── Layout constants ──────────────────────────────────────────────────────────
const W = 160, H = 60
const CW = 1400, CH = 900
const HG = 80, VG = 100
const COLORS = {
  root: '#a5d8ff', branch: '#b2f2bb', leaf: '#ffffff',
  decision: '#ffec99', edge: '#343a40', text: '#1e1e1e',
}

// ── Seeded PRNG (mulberry32) ──────────────────────────────────────────────────
function makePrng(seed: number) {
  let s = seed
  return () => {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Element factories (full Excalidraw v2 schema) ─────────────────────────────

let _counter = 0
function newId(): string {
  return `ta${(++_counter).toString(36)}${Date.now().toString(36)}`
}

function nextSeed(rng: () => number) {
  return Math.floor(rng() * 2147483647)
}

const NOW = Date.now()

function base(id: string, type: ExcalidrawElement['type'], x: number, y: number, w: number, h: number, rng: () => number): ExcalidrawElement {
  return {
    id, type, x, y, width: w, height: h,
    angle: 0,
    strokeColor: COLORS.edge,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: nextSeed(rng),
    version: 1,
    versionNonce: nextSeed(rng),
    updated: NOW,
    isDeleted: false,
    boundElements: [],
    link: null,
    locked: false,
  } as unknown as ExcalidrawElement
}

function makeShape(
  type: 'rectangle' | 'ellipse' | 'diamond',
  x: number, y: number, w: number, h: number,
  bg: string, label: string, fontSize: number,
  rng: () => number,
): ExcalidrawElement[] {
  const shapeId = newId()
  const textId = newId()

  const shape = {
    ...base(shapeId, type, x, y, w, h, rng),
    backgroundColor: bg,
    roundness: type === 'rectangle' ? { type: 3 } : type === 'ellipse' ? { type: 2 } : null,
    boundElements: [{ type: 'text', id: textId }],
  } as unknown as ExcalidrawElement

  const textEl = makeTextBound(textId, label, x, y, w, h, fontSize, shapeId, rng)

  return [shape, textEl]
}

function makeTextBound(
  id: string, text: string,
  px: number, py: number, pw: number, ph: number,
  fontSize: number, containerId: string,
  rng: () => number,
): ExcalidrawElement {
  return {
    ...base(id, 'text', px, py, pw, ph, rng),
    text,
    fontSize,
    fontFamily: 1,
    textAlign: 'center',
    verticalAlign: 'middle',
    baseline: Math.round(fontSize * 0.8),
    containerId,
    originalText: text,
    lineHeight: 1.25,
    autoResize: true,
    strokeColor: COLORS.text,
    backgroundColor: 'transparent',
    boundElements: [],
  } as unknown as ExcalidrawElement
}

function makeFloatingText(id: string, text: string, x: number, y: number, fontSize: number, rng: () => number): ExcalidrawElement {
  return {
    ...base(id, 'text', x, y, 200, Math.ceil(fontSize * 1.25), rng),
    text,
    fontSize,
    fontFamily: 1,
    textAlign: 'center',
    verticalAlign: 'top',
    baseline: Math.round(fontSize * 0.8),
    containerId: null,
    originalText: text,
    lineHeight: 1.25,
    autoResize: true,
    strokeColor: COLORS.text,
    backgroundColor: 'transparent',
    boundElements: [],
  } as unknown as ExcalidrawElement
}

function makeArrow(fromId: string, toId: string, rng: () => number, label?: string): ExcalidrawElement[] {
  const arrowId = newId()
  const elements: ExcalidrawElement[] = []

  const arrow = {
    ...base(arrowId, 'arrow', 0, 0, 0, 0, rng),
    points: [[0, 0], [80, 0]],
    lastCommittedPoint: null,
    startBinding: { elementId: fromId, focus: 0, gap: 8 },
    endBinding: { elementId: toId, focus: 0, gap: 8 },
    startArrowhead: null,
    endArrowhead: 'arrow',
    strokeColor: COLORS.edge,
    roundness: { type: 2 },
    boundElements: label ? [{ type: 'text', id: '' }] : [],
  } as unknown as ExcalidrawElement

  if (label) {
    const textId = newId()
    ;(arrow as unknown as Record<string, unknown>).boundElements = [{ type: 'text', id: textId }]
    const labelEl = {
      ...base(textId, 'text', 0, -20, 100, 20, rng),
      text: label,
      fontSize: 13,
      fontFamily: 1,
      textAlign: 'center',
      verticalAlign: 'middle',
      baseline: 10,
      containerId: arrowId,
      originalText: label,
      lineHeight: 1.25,
      autoResize: true,
      strokeColor: COLORS.text,
      backgroundColor: 'transparent',
      boundElements: [],
    } as unknown as ExcalidrawElement
    elements.push(labelEl)
  }

  elements.unshift(arrow)
  return elements
}

function makeLine(x: number, y: number, w: number, h: number, rng: () => number): ExcalidrawElement {
  return {
    ...base(newId(), 'line', x, y, w, h, rng),
    points: [[0, 0], [w, h]],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
    strokeColor: COLORS.edge,
    roundness: null,
    fillStyle: 'solid',
    strokeWidth: 2,
  } as unknown as ExcalidrawElement
}

function buildFile(elements: ExcalidrawElement[]): ExcalidrawFile {
  return {
    type: 'excalidraw',
    version: 2,
    elements,
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files: {},
  } as unknown as ExcalidrawFile
}

// ── Layout engine ─────────────────────────────────────────────────────────────

export class DiagramLayoutEngine {
  layout(spec: DiagramSpec): ExcalidrawFile {
    _counter = 0
    switch (spec.type) {
      case 'mindmap':      return this.mindmap(spec)
      case 'flowchart':    return this.flowchart(spec)
      case 'timeline':     return this.timeline(spec)
      case 'entity-graph': return this.entityGraph(spec)
    }
  }

  // ── Mind map ────────────────────────────────────────────────────────────────
  private mindmap(spec: DiagramSpec): ExcalidrawFile {
    const rng = makePrng(42)
    const els: ExcalidrawElement[] = []
    const pos = new Map<string, { cx: number; cy: number; id: string }>()

    const cx = CW / 2, cy = CH / 2
    const root = spec.nodes.find((n) => n.level === 0) ?? spec.nodes[0]
    if (!root) return buildFile([])

    const rootEls = makeShape('ellipse', cx - 110, cy - 40, 220, 80, COLORS.root, root.label, 18, rng)
    els.push(...rootEls)
    pos.set(root.id, { cx, cy, id: rootEls[0].id })

    const l1 = spec.nodes.filter((n) => n.level === 1)
    l1.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / Math.max(l1.length, 1) - Math.PI / 2
      const r = 320
      const nx = cx + r * Math.cos(angle), ny = cy + r * Math.sin(angle)
      const shEls = makeShape('rectangle', nx - W / 2, ny - H / 2, W, H, COLORS.branch, node.label, 15, rng)
      els.push(...shEls)
      pos.set(node.id, { cx: nx, cy: ny, id: shEls[0].id })
    })

    const parentChildren = new Map<string, SpecNode[]>()
    for (const e of spec.edges) {
      const child = spec.nodes.find((n) => n.id === e.to && (n.level ?? 99) >= 2)
      if (child) {
        const arr = parentChildren.get(e.from) ?? []
        arr.push(child); parentChildren.set(e.from, arr)
      }
    }
    for (const [parentId, children] of parentChildren) {
      const pp = pos.get(parentId); if (!pp) continue
      const awayAngle = Math.atan2(pp.cy - cy, pp.cx - cx)
      const fan = Math.PI / 2.5
      children.forEach((child, i) => {
        const off = children.length === 1 ? 0 : -fan / 2 + (fan / (children.length - 1)) * i
        const a = awayAngle + off
        const nx = pp.cx + 230 * Math.cos(a), ny = pp.cy + 230 * Math.sin(a)
        const tid = newId()
        els.push(makeFloatingText(tid, child.label, nx - 80, ny - 13, 13, rng))
        pos.set(child.id, { cx: nx, cy: ny, id: tid })
      })
    }

    for (const e of spec.edges) {
      const f = pos.get(e.from), t = pos.get(e.to)
      if (f && t) els.push(...makeArrow(f.id, t.id, rng, e.label))
    }
    return buildFile(els)
  }

  // ── Flowchart ───────────────────────────────────────────────────────────────
  private flowchart(spec: DiagramSpec): ExcalidrawFile {
    const rng = makePrng(42)
    const els: ExcalidrawElement[] = []
    const pos = new Map<string, { cx: number; cy: number; id: string }>()

    const incoming = new Map(spec.nodes.map((n) => [n.id, 0]))
    for (const e of spec.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1)

    const rows = new Map<string, number>()
    const bfs: SpecNode[] = []
    for (const n of spec.nodes) {
      if ((incoming.get(n.id) ?? 0) === 0) { rows.set(n.id, 0); bfs.push(n) }
    }
    for (const n of spec.nodes) { if (!rows.has(n.id)) { rows.set(n.id, 0); bfs.push(n) } }
    const queue = [...bfs]
    while (queue.length) {
      const node = queue.shift()!
      const r = rows.get(node.id) ?? 0
      for (const e of spec.edges) {
        if (e.from !== node.id) continue
        const child = spec.nodes.find((n) => n.id === e.to); if (!child) continue
        if ((rows.get(e.to) ?? -1) < r + 1) { rows.set(e.to, r + 1); queue.push(child) }
      }
    }

    const outgoing = new Map<string, number>()
    for (const e of spec.edges) outgoing.set(e.from, (outgoing.get(e.from) ?? 0) + 1)

    const rowGroups = new Map<number, SpecNode[]>()
    for (const n of spec.nodes) {
      const r = rows.get(n.id) ?? 0
      const g = rowGroups.get(r) ?? []; g.push(n); rowGroups.set(r, g)
    }

    const maxRow = Math.max(0, ...rowGroups.keys())
    const totalH = (maxRow + 1) * (H + VG)
    const startY = Math.max(40, (CH - totalH) / 2)

    for (const [row, nodes] of rowGroups) {
      const totalW = nodes.length * W + (nodes.length - 1) * HG
      const startX = (CW - totalW) / 2
      const y = startY + row * (H + VG)
      nodes.forEach((n, i) => {
        const x = startX + i * (W + HG)
        const type = (outgoing.get(n.id) ?? 0) >= 2 ? 'diamond' : 'rectangle'
        const bg = type === 'diamond' ? COLORS.decision : COLORS.branch
        const shEls = makeShape(type, x, y, W, H, bg, n.label, 14, rng)
        els.push(...shEls)
        pos.set(n.id, { cx: x + W / 2, cy: y + H / 2, id: shEls[0].id })
      })
    }

    for (const e of spec.edges) {
      const f = pos.get(e.from), t = pos.get(e.to)
      if (f && t) els.push(...makeArrow(f.id, t.id, rng, e.label))
    }
    return buildFile(els)
  }

  // ── Timeline ─────────────────────────────────────────────────────────────────
  private timeline(spec: DiagramSpec): ExcalidrawFile {
    const rng = makePrng(42)
    const els: ExcalidrawElement[] = []
    if (spec.nodes.length === 0) return buildFile([])

    const sorted = [...spec.nodes]
    if (sorted.every((n) => n.timestamp)) sorted.sort((a, b) => (a.timestamp! < b.timestamp! ? -1 : 1))

    const n = sorted.length
    const nodeGap = W + HG
    const totalW = n * nodeGap
    const startX = Math.max(60, (CW - totalW) / 2) + W / 2
    const axisY = CH / 2

    els.push(makeLine(startX - W / 2 - 20, axisY, totalW + 20, 0, rng))

    const pos = new Map<string, string>()
    sorted.forEach((node, i) => {
      const x = startX + i * nodeGap
      const above = i % 2 === 0
      const y = above ? axisY - 140 : axisY + 60
      const lbl = node.timestamp ? `${node.label}\n${node.timestamp}` : node.label
      const shEls = makeShape('rectangle', x - W / 2, y, W, H, COLORS.branch, lbl, 13, rng)
      els.push(...shEls)
      pos.set(node.id, shEls[0].id)
      els.push(makeLine(x, axisY - 8, 0, 16, rng))
    })

    for (const e of spec.edges) {
      const fId = pos.get(e.from), tId = pos.get(e.to)
      if (fId && tId) els.push(...makeArrow(fId, tId, rng, e.label))
    }
    return buildFile(els)
  }

  // ── Entity graph (force-directed) ─────────────────────────────────────────────
  private entityGraph(spec: DiagramSpec): ExcalidrawFile {
    const rng = makePrng(42)
    const els: ExcalidrawElement[] = []
    if (spec.nodes.length === 0) return buildFile([])

    const margin = 120
    const pMap = new Map<string, { x: number; y: number; vx: number; vy: number }>()
    for (const n of spec.nodes) {
      pMap.set(n.id, { x: margin + rng() * (CW - 2 * margin), y: margin + rng() * (CH - 2 * margin), vx: 0, vy: 0 })
    }

    const REPULSION = 9000, SK = 0.08, SL = 260, DAMP = 0.82
    for (let iter = 0; iter < 50; iter++) {
      const list = spec.nodes
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = pMap.get(list[i].id)!, b = pMap.get(list[j].id)!
          const dx = a.x - b.x, dy = a.y - b.y, d = Math.sqrt(dx * dx + dy * dy) || 1
          const f = REPULSION / (d * d)
          a.vx += (dx / d) * f; a.vy += (dy / d) * f
          b.vx -= (dx / d) * f; b.vy -= (dy / d) * f
        }
      }
      for (const e of spec.edges) {
        const a = pMap.get(e.from), b = pMap.get(e.to); if (!a || !b) continue
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1
        const f = SK * (d - SL), fx = (dx / d) * f, fy = (dy / d) * f
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy
      }
      for (const n of spec.nodes) {
        const p = pMap.get(n.id)!
        p.vx *= DAMP; p.vy *= DAMP
        p.x = Math.max(margin, Math.min(CW - margin, p.x + p.vx))
        p.y = Math.max(margin, Math.min(CH - margin, p.y + p.vy))
      }
    }

    const pos = new Map<string, string>()
    for (const n of spec.nodes) {
      const p = pMap.get(n.id)!
      const type = n.shape === 'ellipse' ? 'ellipse' : n.shape === 'diamond' ? 'diamond' : 'rectangle'
      const bg = type === 'ellipse' ? COLORS.root : type === 'diamond' ? COLORS.decision : COLORS.branch
      const shEls = makeShape(type, p.x - W / 2, p.y - H / 2, W, H, bg, n.label, 14, rng)
      els.push(...shEls)
      pos.set(n.id, shEls[0].id)
    }

    for (const e of spec.edges) {
      const fId = pos.get(e.from), tId = pos.get(e.to)
      if (fId && tId) els.push(...makeArrow(fId, tId, rng, e.label))
    }
    return buildFile(els)
  }
}
