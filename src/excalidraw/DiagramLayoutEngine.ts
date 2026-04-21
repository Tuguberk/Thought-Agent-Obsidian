import type { ExcalidrawElement, ExcalidrawFile } from "./ExcalidrawAdapter";

export interface SpecNode {
  id: string;
  label: string;
  level?: number;
  shape?: "rect" | "ellipse" | "diamond";
  timestamp?: string;
  x?: number;
  y?: number;
}

export interface SpecEdge {
  from: string;
  to: string;
  label?: string;
}

export interface DiagramSpec {
  type: "mindmap" | "flowchart" | "timeline" | "entity-graph";
  title: string;
  nodes: SpecNode[];
  edges: SpecEdge[];
}

// ── Layout constants ──────────────────────────────────────────────────────────
const W = 160,
  H = 60;
const CW = 1400,
  CH = 900;
const HG = 80,
  VG = 100;
const COLORS = {
  root: "#a5d8ff",
  branch: "#b2f2bb",
  leaf: "#ffffff",
  decision: "#ffec99",
  edge: "#343a40",
  text: "#1e1e1e",
};

// ── Seeded PRNG (mulberry32) ──────────────────────────────────────────────────
function makePrng(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Element factories (full Excalidraw v2 schema) ─────────────────────────────

let _counter = 0;
function newId(): string {
  return `ta${(++_counter).toString(36)}${Date.now().toString(36)}`;
}

function nextSeed(rng: () => number) {
  return Math.floor(rng() * 2147483647);
}

const NOW = Date.now();

function base(
  id: string,
  type: ExcalidrawElement["type"],
  x: number,
  y: number,
  w: number,
  h: number,
  rng: () => number,
): ExcalidrawElement {
  return {
    id,
    type,
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: COLORS.edge,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
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
  } as unknown as ExcalidrawElement;
}

function makeShape(
  type: "rectangle" | "ellipse" | "diamond",
  x: number,
  y: number,
  w: number,
  h: number,
  bg: string,
  label: string,
  fontSize: number,
  rng: () => number,
): ExcalidrawElement[] {
  const shapeId = newId();
  const textId = newId();

  const shape = {
    ...base(shapeId, type, x, y, w, h, rng),
    backgroundColor: bg,
    roundness:
      type === "rectangle"
        ? { type: 3 }
        : type === "ellipse"
          ? { type: 2 }
          : null,
    boundElements: [{ type: "text", id: textId }],
  } as unknown as ExcalidrawElement;

  const textEl = makeTextBound(
    textId,
    label,
    x,
    y,
    w,
    h,
    fontSize,
    shapeId,
    rng,
  );

  return [shape, textEl];
}

function makeTextBound(
  id: string,
  text: string,
  px: number,
  py: number,
  pw: number,
  ph: number,
  fontSize: number,
  containerId: string,
  rng: () => number,
): ExcalidrawElement {
  return {
    ...base(id, "text", px, py, pw, ph, rng),
    text,
    fontSize,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    baseline: Math.round(fontSize * 0.8),
    containerId,
    originalText: text,
    lineHeight: 1.25,
    autoResize: true,
    strokeColor: COLORS.text,
    backgroundColor: "transparent",
    boundElements: [],
  } as unknown as ExcalidrawElement;
}

function makeFloatingText(
  id: string,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  rng: () => number,
): ExcalidrawElement {
  return {
    ...base(id, "text", x, y, 200, Math.ceil(fontSize * 1.25), rng),
    text,
    fontSize,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "top",
    baseline: Math.round(fontSize * 0.8),
    containerId: null,
    originalText: text,
    lineHeight: 1.25,
    autoResize: true,
    strokeColor: COLORS.text,
    backgroundColor: "transparent",
    boundElements: [],
  } as unknown as ExcalidrawElement;
}

interface ArrowGeometry {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

type NodeShapeKind = "rectangle" | "ellipse" | "diamond" | "text";

interface NodePlacement {
  id: string;
  cx: number;
  cy: number;
  width: number;
  height: number;
  shape: NodeShapeKind;
}

function anchorOnShape(
  node: NodePlacement,
  towardX: number,
  towardY: number,
  padding = 8,
): { x: number; y: number } {
  const dx = towardX - node.cx;
  const dy = towardY - node.cy;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return { x: node.cx, y: node.cy };

  const ux = dx / dist;
  const uy = dy / dist;
  const rx = Math.max(1, node.width / 2);
  const ry = Math.max(1, node.height / 2);

  let t = 1;
  if (node.shape === "ellipse") {
    const denom = Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
    t = denom > 1e-6 ? 1 / denom : 1;
  } else if (node.shape === "diamond") {
    const denom = Math.abs(dx) / rx + Math.abs(dy) / ry;
    t = denom > 1e-6 ? 1 / denom : 1;
  } else {
    const tx =
      Math.abs(dx) > 1e-6 ? rx / Math.abs(dx) : Number.POSITIVE_INFINITY;
    const ty =
      Math.abs(dy) > 1e-6 ? ry / Math.abs(dy) : Number.POSITIVE_INFINITY;
    const raw = Math.min(tx, ty);
    t = Number.isFinite(raw) ? raw : 1;
  }

  return {
    x: node.cx + dx * t + ux * padding,
    y: node.cy + dy * t + uy * padding,
  };
}

function edgeGeometry(from: NodePlacement, to: NodePlacement): ArrowGeometry {
  const start = anchorOnShape(from, to.cx, to.cy, 6);
  const end = anchorOnShape(to, from.cx, from.cy, 6);
  return { fromX: start.x, fromY: start.y, toX: end.x, toY: end.y };
}

function makeArrow(
  fromId: string,
  toId: string,
  rng: () => number,
  label?: string,
  geometry?: ArrowGeometry,
): ExcalidrawElement[] {
  const arrowId = newId();
  const elements: ExcalidrawElement[] = [];
  const startX = geometry?.fromX ?? 0;
  const startY = geometry?.fromY ?? 0;
  const endX = geometry?.toX ?? 80;
  const endY = geometry?.toY ?? 0;
  const originX = Math.min(startX, endX);
  const originY = Math.min(startY, endY);
  const relStartX = startX - originX;
  const relStartY = startY - originY;
  const relEndX = endX - originX;
  const relEndY = endY - originY;
  const w = Math.max(1, Math.abs(endX - startX));
  const h = Math.max(1, Math.abs(endY - startY));

  const arrow = {
    ...base(arrowId, "arrow", originX, originY, w, h, rng),
    points: [
      [relStartX, relStartY],
      [relEndX, relEndY],
    ],
    lastCommittedPoint: null,
    startBinding: { elementId: fromId, focus: 0, gap: 8 },
    endBinding: { elementId: toId, focus: 0, gap: 8 },
    startArrowhead: null,
    endArrowhead: "arrow",
    strokeColor: COLORS.edge,
    roundness: { type: 2 },
    boundElements: label ? [{ type: "text", id: "" }] : [],
  } as unknown as ExcalidrawElement;

  if (label) {
    const textId = newId();
    (arrow as unknown as Record<string, unknown>).boundElements = [
      { type: "text", id: textId },
    ];
    const midX = startX + (endX - startX) / 2;
    const midY = startY + (endY - startY) / 2;
    const labelEl = {
      ...base(textId, "text", midX - 60, midY - 26, 120, 20, rng),
      text: label,
      fontSize: 13,
      fontFamily: 1,
      textAlign: "center",
      verticalAlign: "middle",
      baseline: 10,
      containerId: arrowId,
      originalText: label,
      lineHeight: 1.25,
      autoResize: true,
      strokeColor: COLORS.text,
      backgroundColor: "transparent",
      boundElements: [],
    } as unknown as ExcalidrawElement;
    elements.push(labelEl);
  }

  elements.unshift(arrow);
  return elements;
}

function makeLine(
  x: number,
  y: number,
  w: number,
  h: number,
  rng: () => number,
): ExcalidrawElement {
  return {
    ...base(newId(), "line", x, y, w, h, rng),
    points: [
      [0, 0],
      [w, h],
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
    strokeColor: COLORS.edge,
    roundness: null,
    fillStyle: "solid",
    strokeWidth: 2,
  } as unknown as ExcalidrawElement;
}

function buildFile(elements: ExcalidrawElement[]): ExcalidrawFile {
  // Excalidraw draws later elements on top. Keep connectors/background lines at the back layer.
  const backLayerTypes = new Set(["arrow", "line"]);
  const ordered = [
    ...elements.filter((el) => backLayerTypes.has(el.type)),
    ...elements.filter((el) => !backLayerTypes.has(el.type)),
  ];

  return {
    type: "excalidraw",
    version: 2,
    elements: ordered,
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  } as unknown as ExcalidrawFile;
}

// ── Layout engine ─────────────────────────────────────────────────────────────

export class DiagramLayoutEngine {
  layout(spec: DiagramSpec): ExcalidrawFile {
    _counter = 0;
    if (this.hasAiCoordinates(spec.nodes)) {
      return this.aiPositioned(spec);
    }
    switch (spec.type) {
      case "mindmap":
        return this.mindmap(spec);
      case "flowchart":
        return this.flowchart(spec);
      case "timeline":
        return this.timeline(spec);
      case "entity-graph":
        return this.entityGraph(spec);
    }
  }

  private hasAiCoordinates(nodes: SpecNode[]): boolean {
    return (
      nodes.length > 0 &&
      nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))
    );
  }

  private aiPositioned(spec: DiagramSpec): ExcalidrawFile {
    const rng = makePrng(42);
    const els: ExcalidrawElement[] = [];
    const pos = new Map<string, NodePlacement>();
    const margin = 90;

    const xs = spec.nodes.map((n) => n.x as number);
    const ys = spec.nodes.map((n) => n.y as number);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const srcW = Math.max(1, maxX - minX);
    const srcH = Math.max(1, maxY - minY);
    const targetW = CW - margin * 2;
    const targetH = CH - margin * 2;
    const scale = Math.min(targetW / srcW, targetH / srcH, 1.8);

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const placed: Array<{ cx: number; cy: number }> = [];

    const orderedNodes = [...spec.nodes].sort((a, b) => {
      if ((a.y as number) !== (b.y as number))
        return (a.y as number) - (b.y as number);
      if ((a.x as number) !== (b.x as number))
        return (a.x as number) - (b.x as number);
      return a.id.localeCompare(b.id);
    });

    for (const node of orderedNodes) {
      const mappedX = CW / 2 + ((node.x as number) - centerX) * scale;
      const mappedY = CH / 2 + ((node.y as number) - centerY) * scale;
      let cx = Math.max(margin, Math.min(CW - margin, mappedX));
      let cy = Math.max(margin, Math.min(CH - margin, mappedY));

      for (let shift = 0; shift < 30; shift++) {
        const overlap = placed.some(
          (p) => Math.abs(p.cx - cx) < W + 26 && Math.abs(p.cy - cy) < H + 24,
        );
        if (!overlap) break;
        cx = Math.min(CW - margin, cx + 26);
        if (shift % 4 === 3) cy = Math.min(CH - margin, cy + 22);
      }

      const type =
        node.shape === "ellipse"
          ? "ellipse"
          : node.shape === "diamond"
            ? "diamond"
            : node.level === 0
              ? "ellipse"
              : "rectangle";
      const bg =
        type === "ellipse"
          ? COLORS.root
          : type === "diamond"
            ? COLORS.decision
            : COLORS.branch;
      const shEls = makeShape(
        type,
        cx - W / 2,
        cy - H / 2,
        W,
        H,
        bg,
        node.label,
        14,
        rng,
      );
      els.push(...shEls);
      pos.set(node.id, {
        id: shEls[0].id,
        cx,
        cy,
        width: W,
        height: H,
        shape: type,
      });
      placed.push({ cx, cy });
    }

    for (const e of spec.edges) {
      const f = pos.get(e.from);
      const t = pos.get(e.to);
      if (!f || !t) continue;
      els.push(...makeArrow(f.id, t.id, rng, e.label, edgeGeometry(f, t)));
    }

    return buildFile(els);
  }

  // ── Mind map ────────────────────────────────────────────────────────────────
  private mindmap(spec: DiagramSpec): ExcalidrawFile {
    const rng = makePrng(42);
    const els: ExcalidrawElement[] = [];
    const pos = new Map<string, NodePlacement>();

    const cx = CW / 2,
      cy = CH / 2;
    const root = spec.nodes.find((n) => n.level === 0) ?? spec.nodes[0];
    if (!root) return buildFile([]);

    const rootEls = makeShape(
      "ellipse",
      cx - 110,
      cy - 40,
      220,
      80,
      COLORS.root,
      root.label,
      18,
      rng,
    );
    els.push(...rootEls);
    pos.set(root.id, {
      id: rootEls[0].id,
      cx,
      cy,
      width: 220,
      height: 80,
      shape: "ellipse",
    });

    const l1 = spec.nodes.filter((n) => n.level === 1);
    l1.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / Math.max(l1.length, 1) - Math.PI / 2;
      const r = 320;
      const nx = cx + r * Math.cos(angle),
        ny = cy + r * Math.sin(angle);
      const shEls = makeShape(
        "rectangle",
        nx - W / 2,
        ny - H / 2,
        W,
        H,
        COLORS.branch,
        node.label,
        15,
        rng,
      );
      els.push(...shEls);
      pos.set(node.id, {
        id: shEls[0].id,
        cx: nx,
        cy: ny,
        width: W,
        height: H,
        shape: "rectangle",
      });
    });

    const parentChildren = new Map<string, SpecNode[]>();
    for (const e of spec.edges) {
      const child = spec.nodes.find(
        (n) => n.id === e.to && (n.level ?? 99) >= 2,
      );
      if (child) {
        const arr = parentChildren.get(e.from) ?? [];
        arr.push(child);
        parentChildren.set(e.from, arr);
      }
    }
    for (const [parentId, children] of parentChildren) {
      const pp = pos.get(parentId);
      if (!pp) continue;
      const awayAngle = Math.atan2(pp.cy - cy, pp.cx - cx);
      const fan = Math.PI / 2.5;
      children.forEach((child, i) => {
        const off =
          children.length === 1
            ? 0
            : -fan / 2 + (fan / (children.length - 1)) * i;
        const a = awayAngle + off;
        const nx = pp.cx + 230 * Math.cos(a),
          ny = pp.cy + 230 * Math.sin(a);
        const leafW = 200;
        const leafH = Math.ceil(13 * 1.25);
        const tid = newId();
        els.push(
          makeFloatingText(
            tid,
            child.label,
            nx - leafW / 2,
            ny - leafH / 2,
            13,
            rng,
          ),
        );
        pos.set(child.id, {
          id: tid,
          cx: nx,
          cy: ny,
          width: leafW,
          height: leafH,
          shape: "text",
        });
      });
    }

    for (const e of spec.edges) {
      const f = pos.get(e.from),
        t = pos.get(e.to);
      if (f && t)
        els.push(...makeArrow(f.id, t.id, rng, e.label, edgeGeometry(f, t)));
    }
    return buildFile(els);
  }

  // ── Flowchart ───────────────────────────────────────────────────────────────
  private flowchart(spec: DiagramSpec): ExcalidrawFile {
    const rng = makePrng(42);
    const els: ExcalidrawElement[] = [];
    const pos = new Map<string, NodePlacement>();

    const incoming = new Map(spec.nodes.map((n) => [n.id, 0]));
    for (const e of spec.edges)
      incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);

    const rows = new Map<string, number>();
    const bfs: SpecNode[] = [];
    for (const n of spec.nodes) {
      if ((incoming.get(n.id) ?? 0) === 0) {
        rows.set(n.id, 0);
        bfs.push(n);
      }
    }
    for (const n of spec.nodes) {
      if (!rows.has(n.id)) {
        rows.set(n.id, 0);
        bfs.push(n);
      }
    }
    const queue = [...bfs];
    while (queue.length) {
      const node = queue.shift()!;
      const r = rows.get(node.id) ?? 0;
      for (const e of spec.edges) {
        if (e.from !== node.id) continue;
        const child = spec.nodes.find((n) => n.id === e.to);
        if (!child) continue;
        if ((rows.get(e.to) ?? -1) < r + 1) {
          rows.set(e.to, r + 1);
          queue.push(child);
        }
      }
    }

    const outgoing = new Map<string, number>();
    for (const e of spec.edges)
      outgoing.set(e.from, (outgoing.get(e.from) ?? 0) + 1);

    const rowGroups = new Map<number, SpecNode[]>();
    for (const n of spec.nodes) {
      const r = rows.get(n.id) ?? 0;
      const g = rowGroups.get(r) ?? [];
      g.push(n);
      rowGroups.set(r, g);
    }

    const maxRow = Math.max(0, ...rowGroups.keys());
    const totalH = (maxRow + 1) * (H + VG);
    const startY = Math.max(40, (CH - totalH) / 2);

    for (const [row, nodes] of rowGroups) {
      const totalW = nodes.length * W + (nodes.length - 1) * HG;
      const startX = (CW - totalW) / 2;
      const y = startY + row * (H + VG);
      nodes.forEach((n, i) => {
        const x = startX + i * (W + HG);
        const type = (outgoing.get(n.id) ?? 0) >= 2 ? "diamond" : "rectangle";
        const bg = type === "diamond" ? COLORS.decision : COLORS.branch;
        const shEls = makeShape(type, x, y, W, H, bg, n.label, 14, rng);
        els.push(...shEls);
        pos.set(n.id, {
          id: shEls[0].id,
          cx: x + W / 2,
          cy: y + H / 2,
          width: W,
          height: H,
          shape: type,
        });
      });
    }

    for (const e of spec.edges) {
      const f = pos.get(e.from),
        t = pos.get(e.to);
      if (f && t)
        els.push(...makeArrow(f.id, t.id, rng, e.label, edgeGeometry(f, t)));
    }
    return buildFile(els);
  }

  // ── Timeline ─────────────────────────────────────────────────────────────────
  private timeline(spec: DiagramSpec): ExcalidrawFile {
    const rng = makePrng(42);
    const els: ExcalidrawElement[] = [];
    if (spec.nodes.length === 0) return buildFile([]);

    const sorted = [...spec.nodes];
    if (sorted.every((n) => n.timestamp))
      sorted.sort((a, b) => (a.timestamp! < b.timestamp! ? -1 : 1));

    const n = sorted.length;
    const nodeGap = W + HG;
    const totalW = n * nodeGap;
    const startX = Math.max(60, (CW - totalW) / 2) + W / 2;
    const axisY = CH / 2;

    els.push(makeLine(startX - W / 2 - 20, axisY, totalW + 20, 0, rng));

    const pos = new Map<string, NodePlacement>();
    sorted.forEach((node, i) => {
      const x = startX + i * nodeGap;
      const above = i % 2 === 0;
      const y = above ? axisY - 140 : axisY + 60;
      const lbl = node.timestamp
        ? `${node.label}\n${node.timestamp}`
        : node.label;
      const shEls = makeShape(
        "rectangle",
        x - W / 2,
        y,
        W,
        H,
        COLORS.branch,
        lbl,
        13,
        rng,
      );
      els.push(...shEls);
      pos.set(node.id, {
        id: shEls[0].id,
        cx: x,
        cy: y + H / 2,
        width: W,
        height: H,
        shape: "rectangle",
      });
      els.push(makeLine(x, axisY - 8, 0, 16, rng));
    });

    for (const e of spec.edges) {
      const f = pos.get(e.from),
        t = pos.get(e.to);
      if (f && t)
        els.push(...makeArrow(f.id, t.id, rng, e.label, edgeGeometry(f, t)));
    }
    return buildFile(els);
  }

  // ── Entity graph (deterministic layered) ──────────────────────────────────
  private entityGraph(spec: DiagramSpec): ExcalidrawFile {
    const rng = makePrng(42);
    const els: ExcalidrawElement[] = [];
    if (spec.nodes.length === 0) return buildFile([]);

    const incoming = new Map(spec.nodes.map((n) => [n.id, 0]));
    for (const e of spec.edges)
      incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);

    const layers = new Map<string, number>();
    const queue: string[] = [];
    for (const n of spec.nodes) {
      if ((incoming.get(n.id) ?? 0) === 0) {
        layers.set(n.id, 0);
        queue.push(n.id);
      }
    }
    for (const n of spec.nodes) {
      if (!layers.has(n.id)) {
        layers.set(n.id, 0);
        queue.push(n.id);
      }
    }

    while (queue.length) {
      const id = queue.shift()!;
      const layer = layers.get(id) ?? 0;
      for (const e of spec.edges) {
        if (e.from !== id) continue;
        const cur = layers.get(e.to) ?? 0;
        if (cur < layer + 1) {
          layers.set(e.to, layer + 1);
          queue.push(e.to);
        }
      }
    }

    const grouped = new Map<number, SpecNode[]>();
    for (const n of spec.nodes) {
      const layer = layers.get(n.id) ?? 0;
      const arr = grouped.get(layer) ?? [];
      arr.push(n);
      grouped.set(layer, arr);
    }

    const marginX = 120;
    const marginY = 120;
    const layerGap = 250;
    const rowGap = 110;
    const maxLayer = Math.max(0, ...grouped.keys());
    const canvasCenterX = CW / 2;
    const startX = Math.max(marginX, canvasCenterX - (maxLayer * layerGap) / 2);
    const pos = new Map<string, NodePlacement>();

    const orderedLayers = [...grouped.keys()].sort((a, b) => a - b);
    for (const layer of orderedLayers) {
      const nodes = (grouped.get(layer) ?? []).sort((a, b) =>
        a.label.localeCompare(b.label),
      );
      const totalH = nodes.length * H + Math.max(0, nodes.length - 1) * rowGap;
      const startY = Math.max(marginY, (CH - totalH) / 2);
      const x = startX + layer * layerGap;

      nodes.forEach((n, i) => {
        const y = startY + i * (H + rowGap);
        const cx = x;
        const cy = y + H / 2;
        const boundedX = Math.max(marginX, Math.min(CW - marginX, cx));
        const boundedY = Math.max(marginY, Math.min(CH - marginY, cy));

        const type =
          n.shape === "ellipse"
            ? "ellipse"
            : n.shape === "diamond"
              ? "diamond"
              : "rectangle";
        const bg =
          type === "ellipse"
            ? COLORS.root
            : type === "diamond"
              ? COLORS.decision
              : COLORS.branch;
        const shEls = makeShape(
          type,
          boundedX - W / 2,
          boundedY - H / 2,
          W,
          H,
          bg,
          n.label,
          14,
          rng,
        );
        els.push(...shEls);
        pos.set(n.id, {
          id: shEls[0].id,
          cx: boundedX,
          cy: boundedY,
          width: W,
          height: H,
          shape: type,
        });
      });
    }

    for (const n of spec.nodes) {
      if (pos.has(n.id)) continue;
      const fallbackX = marginX + rng() * (CW - 2 * marginX);
      const fallbackY = marginY + rng() * (CH - 2 * marginY);
      const type =
        n.shape === "ellipse"
          ? "ellipse"
          : n.shape === "diamond"
            ? "diamond"
            : "rectangle";
      const bg =
        type === "ellipse"
          ? COLORS.root
          : type === "diamond"
            ? COLORS.decision
            : COLORS.branch;
      const shEls = makeShape(
        type,
        fallbackX - W / 2,
        fallbackY - H / 2,
        W,
        H,
        bg,
        n.label,
        14,
        rng,
      );
      els.push(...shEls);
      pos.set(n.id, {
        id: shEls[0].id,
        cx: fallbackX,
        cy: fallbackY,
        width: W,
        height: H,
        shape: type,
      });
    }

    for (const e of spec.edges) {
      const f = pos.get(e.from),
        t = pos.get(e.to);
      if (f && t)
        els.push(...makeArrow(f.id, t.id, rng, e.label, edgeGeometry(f, t)));
    }
    return buildFile(els);
  }
}
