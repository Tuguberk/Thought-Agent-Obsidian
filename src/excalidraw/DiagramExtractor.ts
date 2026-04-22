import type { ExcalidrawElement, ExcalidrawFile } from "./ExcalidrawAdapter";

export interface DiagramNode {
  id: string;
  label: string;
  type: "rectangle" | "ellipse" | "diamond" | "text" | "other";
  x: number;
  y: number;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface ExtractedDiagram {
  filePath: string;
  title: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  freeText: string[];
  summary: string;
  rawTextContent: string;
}

export class DiagramExtractor {
  private tryParseElements(fileContent: string): ExcalidrawElement[] | null {
    const tryFile = (raw: string): ExcalidrawElement[] | null => {
      try {
        const parsed = JSON.parse(raw) as ExcalidrawFile;
        if (Array.isArray(parsed.elements)) return parsed.elements;
      } catch {
        // Keep trying alternate markdown encodings.
      }
      return null;
    };

    const direct = tryFile(fileContent);
    if (direct) return direct;

    const fencedMatches = fileContent.matchAll(
      /```\s*(?:json|compressed-json)\s*\n([\s\S]*?)\n```/gi,
    );
    for (const match of fencedMatches) {
      const maybe = tryFile((match[1] ?? "").trim());
      if (maybe) return maybe;
    }

    const firstBrace = fileContent.indexOf("{");
    const lastBrace = fileContent.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const maybe = tryFile(fileContent.slice(firstBrace, lastBrace + 1));
      if (maybe) return maybe;
    }

    return null;
  }

  extractFromElements(
    filePath: string,
    elements: ExcalidrawElement[],
  ): ExtractedDiagram {
    const title =
      filePath
        .split("/")
        .pop()
        ?.replace(/\.excalidraw$/, "") ?? filePath;
    return this.buildDiagram(filePath, title, elements);
  }

  extract(filePath: string, fileContent: string): ExtractedDiagram {
    const title =
      filePath
        .split("/")
        .pop()
        ?.replace(/\.excalidraw$/, "") ?? filePath;

    const elements = this.tryParseElements(fileContent);
    if (!elements) {
      return {
        filePath,
        title,
        nodes: [],
        edges: [],
        freeText: [],
        summary: `[Parse error] Could not read diagram at ${filePath}`,
        rawTextContent: `[DIAGRAM] ${title}`,
      };
    }

    return this.buildDiagram(filePath, title, elements);
  }

  private buildDiagram(
    filePath: string,
    title: string,
    elements: ExcalidrawElement[],
  ): ExtractedDiagram {
    const boundTextIds = new Set<string>();
    for (const el of elements) {
      if (el.boundElements) {
        for (const b of el.boundElements) boundTextIds.add(b.id);
      }
    }

    const nodes: DiagramNode[] = [];
    const nodeIdSet = new Set<string>();

    for (const el of elements) {
      const label = (el.label?.text ?? el.text ?? "").trim();
      const isShape = ["rectangle", "ellipse", "diamond"].includes(el.type);
      const isText = el.type === "text";

      if (isShape) {
        nodeIdSet.add(el.id);
        if (label) {
          nodes.push({
            id: el.id,
            label,
            type: el.type as DiagramNode["type"],
            x: el.x,
            y: el.y,
          });
        }
      } else if (isText && label && !boundTextIds.has(el.id)) {
        nodes.push({ id: el.id, label, type: "text", x: el.x, y: el.y });
        nodeIdSet.add(el.id);
      }
    }

    const edges: DiagramEdge[] = [];
    const arrowBoundTextIds = new Set<string>();

    for (const el of elements) {
      if (el.type !== "arrow") continue;
      if (!el.startBinding?.elementId || !el.endBinding?.elementId) continue;

      const edge: DiagramEdge = {
        from: el.startBinding.elementId,
        to: el.endBinding.elementId,
      };

      const arrowLabel = elements.find(
        (e) =>
          e.type === "text" && e.boundElements?.some((b) => b.id === el.id),
      );
      if (arrowLabel?.text) {
        edge.label = arrowLabel.text.trim();
        arrowBoundTextIds.add(arrowLabel.id);
      } else if (el.text?.trim()) {
        edge.label = el.text.trim();
      } else if (el.label?.text?.trim()) {
        edge.label = el.label.text.trim();
      }

      edges.push(edge);
    }

    const freeText: string[] = [];
    for (const el of elements) {
      if (el.type !== "text" || !el.text?.trim()) continue;
      if (nodeIdSet.has(el.id)) continue;
      if (boundTextIds.has(el.id)) continue;
      if (arrowBoundTextIds.has(el.id)) continue;
      freeText.push(el.text.trim());
    }

    const rawTextContent = [
      `[DIAGRAM] ${title}`,
      ...nodes.map((n) => n.label),
      ...edges.filter((e) => e.label).map((e) => e.label!),
      ...freeText,
    ].join("\n");

    const keyTopics = nodes
      .slice(0, 5)
      .map((n) => n.label)
      .join(", ");
    const summary = `Diagram with ${nodes.length} nodes and ${edges.length} connections. Key topics: ${keyTopics || "(no text found)"}.`;

    return { filePath, title, nodes, edges, freeText, summary, rawTextContent };
  }
}
