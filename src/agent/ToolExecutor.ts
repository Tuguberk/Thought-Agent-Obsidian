import { App, TFile } from "obsidian";
import type { VectorStore } from "../retrieval/VectorStore";
import type { SessionContext } from "./SessionContext";
import type { PendingChange } from "../changes/PendingChange";
import { hybridSearch } from "../retrieval/HybridSearch";
import { graphEnhancedRetrieval } from "../retrieval/GraphEnhanced";
import { mmr } from "../retrieval/MMR";
import { embed } from "../retrieval/Embedder";
import type { ExcalidrawAdapter, ExcalidrawElement } from "../excalidraw/ExcalidrawAdapter";
import { DiagramExtractor } from "../excalidraw/DiagramExtractor";
import { DiagramLayoutEngine } from "../excalidraw/DiagramLayoutEngine";
import type { SpecNode, SpecEdge, DiagramSpec } from "../excalidraw/DiagramLayoutEngine";

export interface ToolResult {
  content: string;
  pendingChange?: PendingChange;
  graphFilter?: GraphFilter;
}

export interface GraphFilter {
  tags?: string[];
  folders?: string[];
  linkedTo?: string;
  query?: string;
}

export class ToolExecutor {
  private diagramExtractor = new DiagramExtractor()
  private diagramLayoutEngine = new DiagramLayoutEngine()
  private readonly fallbackDiagramFolder = 'Diagrams'

  constructor(
    private app: App,
    private store: VectorStore,
    private session: SessionContext,
    private onSessionUpdate: (ctx: SessionContext) => void,
    private excalidraw?: ExcalidrawAdapter,
    private diagramDefaultFolder = '',
    private diagramEmbedStyle: 'embed' | 'link' = 'embed',
  ) {}

  private normalizeFolderPath(folder?: string): string {
    if (!folder) return ''
    return folder
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .replace(/\\+/g, '/')
      .replace(/\/+/g, '/')
  }

  private resolveDiagramFolder(requestedFolder?: string): string {
    const baseFolder = this.normalizeFolderPath(this.diagramDefaultFolder) || this.fallbackDiagramFolder
    const requested = this.normalizeFolderPath(requestedFolder)

    if (!requested) return baseFolder

    if (requested === baseFolder || requested.startsWith(`${baseFolder}/`)) {
      return requested
    }

    return `${baseFolder}/${requested}`
  }

  private getBacklinkPaths(notePath: string): string[] {
    const resolvedLinks = (
      this.app.metadataCache as unknown as {
        resolvedLinks?: Record<string, Record<string, number>>;
      }
    ).resolvedLinks;
    if (!resolvedLinks) return [];

    const backlinks: string[] = [];
    for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
      if (targets && Object.prototype.hasOwnProperty.call(targets, notePath)) {
        backlinks.push(sourcePath);
      }
    }
    return backlinks;
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      switch (toolName) {
        case "search_notes":
          return await this.searchNotes(input);
        case "get_note":
          return await this.getNote(input);
        case "get_neighbors":
          return await this.getNeighbors(input);
        case "get_backlinks":
          return await this.getBacklinks(input);
        case "query_graph":
          return await this.queryGraph(input);
        case "create_note":
          return this.createNote(input);
        case "edit_note":
          return await this.editNote(input);
        case "link_notes":
          return await this.linkNotes(input);
        case "reorganize":
          return this.reorganize(input);
        case "set_session_constraint":
          return this.setSessionConstraint(input);
        case "read_diagram":
          return await this.readDiagram(input);
        case "search_diagrams":
          return await this.searchDiagrams(input);
        case "create_diagram":
          return await this.createDiagram(input);
        case "update_diagram":
          return await this.updateDiagram(input);
        case "annotate_diagram":
          return await this.annotateDiagram(input);
        default:
          return { content: `Unknown tool: ${toolName}` };
      }
    } catch (e) {
      return { content: `Error executing ${toolName}: ${e.message}` };
    }
  }

  private applySessionFilters(chunks: ReturnType<VectorStore["getAllChunks"]>) {
    let filtered = chunks;
    if (this.session.tagFilter?.length) {
      const tags = this.session.tagFilter;
      filtered = filtered.filter((c) => {
        const file = this.app.vault.getFileByPath(c.notePath);
        if (!file) return false;
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache?.tags) return false;
        return cache.tags.some((t) => tags.includes(t.tag.replace("#", "")));
      });
    }
    if (this.session.folderFilter?.length) {
      const folders = this.session.folderFilter;
      filtered = filtered.filter((c) =>
        folders.some((f) => c.notePath.startsWith(f)),
      );
    }
    return filtered;
  }

  private async searchNotes(
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const query = input.query as string;
    const topK = (input.topK as number) ?? 8;

    const allChunks = this.applySessionFilters(this.store.getAllChunks());
    if (allChunks.length === 0) {
      return {
        content:
          'No indexed notes found. Please run "Re-index vault" in settings.',
      };
    }

    const queryEmbedding = await embed(query);
    const hybridResults = hybridSearch(
      queryEmbedding,
      query,
      allChunks,
      topK * 2,
    );
    const graphResults = graphEnhancedRetrieval(
      this.app,
      hybridResults,
      queryEmbedding,
      this.store,
    );
    const finalResults = mmr(graphResults, topK);

    const output = finalResults.map((r) => ({
      notePath: r.chunk.notePath,
      noteTitle: r.chunk.noteTitle,
      heading: r.chunk.heading,
      content: r.chunk.content.slice(0, 500),
      score: Math.round(r.score * 100) / 100,
      level: r.chunk.level,
    }));

    return { content: JSON.stringify(output, null, 2) };
  }

  private async getNote(input: Record<string, unknown>): Promise<ToolResult> {
    const notePath = input.notePath as string;
    const file = this.app.vault.getFileByPath(notePath);
    if (!file || !(file instanceof TFile)) {
      return { content: `Note not found: ${notePath}` };
    }

    const content = await this.app.vault.read(file);
    const cache = this.app.metadataCache.getFileCache(file);
    const tags = cache?.tags?.map((t) => t.tag) ?? [];
    const outgoingLinks: string[] = [];

    if (cache?.links) {
      for (const link of cache.links) {
        const resolved = this.app.metadataCache.getFirstLinkpathDest(
          link.link,
          file.path,
        );
        if (resolved) outgoingLinks.push(resolved.path);
      }
    }

    const backlinks = this.getBacklinkPaths(file.path);

    return {
      content: JSON.stringify(
        {
          path: notePath,
          title: file.basename,
          fullContent: content,
          tags,
          outgoingLinks,
          backlinks,
        },
        null,
        2,
      ),
    };
  }

  private getNeighbors(
    input: Record<string, unknown>,
  ): ToolResult {
    const notePath = input.notePath as string;
    const depth = (input.depth as number) ?? 1;

    const file = this.app.vault.getFileByPath(notePath);
    if (!file) return { content: `Note not found: ${notePath}` };

    const visited = new Set<string>([notePath]);
    const neighbors: Array<{
      path: string;
      title: string;
      summary: string;
      direction: string;
    }> = [];

    const expand = (currentPath: string, currentDepth: number) => {
      if (currentDepth === 0) return;
      const f = this.app.vault.getFileByPath(currentPath);
      if (!f || !(f instanceof TFile)) return;
      const cache = this.app.metadataCache.getFileCache(f);

      if (cache?.links) {
        for (const link of cache.links) {
          const resolved = this.app.metadataCache.getFirstLinkpathDest(
            link.link,
            f.path,
          );
          if (resolved && !visited.has(resolved.path)) {
            visited.add(resolved.path);
            const summary =
              this.store
                .getChunksForNote(resolved.path)
                .find((c) => c.level === 1)
                ?.content.slice(0, 200) ?? "";
            neighbors.push({
              path: resolved.path,
              title: resolved.basename,
              summary,
              direction: "outgoing",
            });
            expand(resolved.path, currentDepth - 1);
          }
        }
      }

      const backlinkPaths = this.getBacklinkPaths(f.path);
      for (const path of backlinkPaths) {
        if (!visited.has(path)) {
          visited.add(path);
          const resolvedFile = this.app.vault.getFileByPath(path);
          const summary =
            this.store
              .getChunksForNote(path)
              .find((c) => c.level === 1)
              ?.content.slice(0, 200) ?? "";
          neighbors.push({
            path,
            title: resolvedFile?.basename ?? path,
            summary,
            direction: "incoming",
          });
          expand(path, currentDepth - 1);
        }
      }
    };

    expand(notePath, depth);
    return { content: JSON.stringify(neighbors, null, 2) };
  }

  private getBacklinks(
    input: Record<string, unknown>,
  ): ToolResult {
    const notePath = input.notePath as string;
    const file = this.app.vault.getFileByPath(notePath);
    if (!file || !(file instanceof TFile))
      return { content: `Note not found: ${notePath}` };

    const backlinkPaths = this.getBacklinkPaths(file.path);
    if (backlinkPaths.length === 0) return { content: "[]" };

    const result: Array<{ path: string; title: string; context: string }> = [];

    for (const path of backlinkPaths) {
      const sourceFile = this.app.vault.getFileByPath(path);
      const title = sourceFile?.basename ?? path;
      const context = "";
      result.push({ path, title, context: context.slice(0, 300) });
    }

    return { content: JSON.stringify(result, null, 2) };
  }

  private async queryGraph(
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const filter = input.filter as GraphFilter;

    const allFiles = this.app.vault.getMarkdownFiles();
    let matchedPaths: string[] = allFiles.map((f) => f.path);

    if (filter.tags?.length) {
      matchedPaths = matchedPaths.filter((p) => {
        const f = this.app.vault.getFileByPath(p);
        if (!f) return false;
        const cache = this.app.metadataCache.getFileCache(f);
        return cache?.tags?.some((t) =>
          filter.tags!.includes(t.tag.replace("#", "")),
        );
      });
    }

    if (filter.folders?.length) {
      matchedPaths = matchedPaths.filter((p) =>
        filter.folders!.some((f) => p.startsWith(f)),
      );
    }

    if (filter.linkedTo) {
      const targetFile = this.app.vault.getFileByPath(filter.linkedTo);
      if (targetFile) {
        const backlinkPaths = this.getBacklinkPaths(targetFile.path);
        matchedPaths = matchedPaths.filter(
          (p) => backlinkPaths.includes(p) || p === filter.linkedTo,
        );
      }
    }

    if (filter.query) {
      const queryEmbedding = await embed(filter.query);
      const chunks = this.store
        .getAllChunks()
        .filter((c) => matchedPaths.includes(c.notePath) && c.level === 1);
      const results = hybridSearch(
        queryEmbedding,
        filter.query,
        chunks,
        Math.min(60, chunks.length || 60),
      );

      const queryTerms = filter.query
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 2);

      const hasLexicalMatch = (
        path: string,
        title: string,
        content: string,
      ): boolean => {
        if (queryTerms.length === 0) return false;
        const haystack = `${path} ${title} ${content}`.toLowerCase();
        return queryTerms.some((term) => haystack.includes(term));
      };

      const perNote = new Map<string, { score: number; lexical: boolean }>();
      for (const r of results) {
        const current = perNote.get(r.chunk.notePath);
        const lexical = hasLexicalMatch(
          r.chunk.notePath,
          r.chunk.noteTitle,
          r.chunk.content,
        );
        if (!current) {
          perNote.set(r.chunk.notePath, { score: r.score, lexical });
          continue;
        }
        perNote.set(r.chunk.notePath, {
          score: Math.max(current.score, r.score),
          lexical: current.lexical || lexical,
        });
      }

      const scores = Array.from(perNote.values())
        .map((v) => v.score)
        .sort((a, b) => b - a);
      const topScore = scores[0] ?? 0;
      const minAdaptive = Math.max(0.18, topScore * 0.55);
      const lexicalCount = Array.from(perNote.values()).filter(
        (v) => v.lexical,
      ).length;

      const resultPaths = new Set<string>();
      if (lexicalCount > 0) {
        for (const [path, v] of perNote.entries()) {
          if (v.lexical && v.score >= 0.08) resultPaths.add(path);
        }
      } else {
        // No lexical hit: be conservative to avoid showing unrelated notes.
        for (const [path, v] of perNote.entries()) {
          if (
            topScore >= 0.35 &&
            v.score >= Math.max(0.3, Math.max(minAdaptive, topScore * 0.9))
          ) {
            resultPaths.add(path);
          }
        }
      }

      matchedPaths = matchedPaths.filter((p) => resultPaths.has(p));
    }

    const nodes = matchedPaths.map((p) => {
      const f = this.app.vault.getFileByPath(p);
      return { path: p, title: f?.basename ?? p };
    });

    const edges: Array<{ from: string; to: string }> = [];
    for (const node of nodes) {
      const f = this.app.vault.getFileByPath(node.path);
      if (!f) continue;
      const cache = this.app.metadataCache.getFileCache(f);
      if (cache?.links) {
        for (const link of cache.links) {
          const resolved = this.app.metadataCache.getFirstLinkpathDest(
            link.link,
            f.path,
          );
          if (resolved && matchedPaths.includes(resolved.path)) {
            edges.push({ from: node.path, to: resolved.path });
          }
        }
      }
    }

    return {
      content: JSON.stringify(
        { nodes, edges, matchCount: nodes.length },
        null,
        2,
      ),
      graphFilter: filter,
    };
  }

  private createNote(input: Record<string, unknown>): ToolResult {
    const title = input.title as string;
    const content = input.content as string;
    const folder = (input.folder as string | undefined) ?? "";
    const tags = (input.tags as string[] | undefined) ?? [];
    const linksTo = (input.linksTo as string[] | undefined) ?? [];

    let frontmatter = "";
    if (tags.length > 0) {
      frontmatter = `---\ntags: [${tags.join(", ")}]\n---\n\n`;
    }

    let linkSection = "";
    if (linksTo.length > 0) {
      linkSection =
        "\n\n## Related\n" +
        linksTo.map((l) => `- [[${l.replace(/\.md$/, "")}]]`).join("\n");
    }

    const fullContent = frontmatter + content + linkSection;
    const path = folder
      ? `${folder.replace(/\/$/, "")}/${title}.md`
      : `${title}.md`;

    const change: PendingChange = {
      kind: "create",
      note: { path, content: fullContent, tags },
    };

    return {
      content: JSON.stringify({
        status: "pending_approval",
        path,
        preview: fullContent.slice(0, 300),
      }),
      pendingChange: change,
    };
  }

  private async editNote(input: Record<string, unknown>): Promise<ToolResult> {
    const notePath = input.notePath as string;
    const newContent = input.newContent as string;

    const file = this.app.vault.getFileByPath(notePath);
    if (!file || !(file instanceof TFile)) {
      return { content: `Note not found: ${notePath}` };
    }

    const originalContent = await this.app.vault.read(file);

    const change: PendingChange = {
      kind: "edit",
      notePath,
      originalContent,
      newContent,
      diff: [{ before: originalContent, after: newContent }],
    };

    return {
      content: JSON.stringify({ status: "pending_approval", notePath }),
      pendingChange: change,
    };
  }

  private async linkNotes(input: Record<string, unknown>): Promise<ToolResult> {
    const from = input.from as string;
    const to = input.to as string;
    const linkText = input.linkText as string | undefined;
    const insertionPoint = input.insertionPoint as string | undefined;

    const file = this.app.vault.getFileByPath(from);
    if (!file || !(file instanceof TFile)) {
      return { content: `Source note not found: ${from}` };
    }

    const originalContent = await this.app.vault.read(file);
    const toBasename = to.replace(/\.md$/, "");
    const wikilink = linkText
      ? `[[${toBasename}|${linkText}]]`
      : `[[${toBasename}]]`;
    const position =
      insertionPoint === "beginning" ? 0 : originalContent.length;

    const change: PendingChange = {
      kind: "link",
      notePath: from,
      originalContent,
      insertionPoint: position,
      linkText: wikilink,
    };

    return {
      content: JSON.stringify({
        status: "pending_approval",
        from,
        to,
        wikilink,
      }),
      pendingChange: change,
    };
  }

  private reorganize(input: Record<string, unknown>): ToolResult {
    const description = input.description as string;
    const steps = input.steps as Array<Record<string, unknown>>;

    const pendingSteps: PendingChange[] = steps.map((step) => {
      const action = step.action as string;
      if (action === "create") {
        const title = step.title as string;
        const content = (step.content as string) ?? "";
        const folder = step.folder as string | undefined;
        const path = folder
          ? `${folder.replace(/\/$/, "")}/${title}.md`
          : `${title}.md`;
        return { kind: "create" as const, note: { path, content, tags: [] } };
      } else if (action === "edit") {
        return {
          kind: "edit" as const,
          notePath: step.notePath as string,
          originalContent: "",
          newContent: (step.content as string) ?? "",
          diff: [],
        };
      } else {
        return {
          kind: "link" as const,
          notePath: step.from as string,
          originalContent: "",
          insertionPoint: 0,
          linkText: `[[${(step.to as string).replace(/\.md$/, "")}]]`,
        };
      }
    });

    const change: PendingChange = {
      kind: "reorganize",
      description,
      steps: pendingSteps,
    };

    return {
      content: JSON.stringify({
        status: "pending_approval",
        description,
        stepCount: steps.length,
      }),
      pendingChange: change,
    };
  }

  private setSessionConstraint(input: Record<string, unknown>): ToolResult {
    const updated: SessionContext = {
      tagFilter: (input.tagFilter as string[] | null) ?? this.session.tagFilter,
      folderFilter:
        (input.folderFilter as string[] | null) ?? this.session.folderFilter,
      customInstructions:
        (input.customInstructions as string | null) ??
        this.session.customInstructions,
      activeFile: this.session.activeFile,
    };

    if ("tagFilter" in input)
      updated.tagFilter = input.tagFilter as string[] | null;
    if ("folderFilter" in input)
      updated.folderFilter = input.folderFilter as string[] | null;
    if ("customInstructions" in input)
      updated.customInstructions = input.customInstructions as string | null;

    this.onSessionUpdate(updated);
    return { content: JSON.stringify({ status: "updated", session: updated }) };
  }

  // ── Diagram tools ─────────────────────────────────────────────────────────

  private async readDiagram(input: Record<string, unknown>): Promise<ToolResult> {
    if (!this.excalidraw) return { content: 'Excalidraw plugin is not installed.' }
    const filePath = input.filePath as string
    try {
      const file = this.app.vault.getAbstractFileByPath(filePath)
      if (!file || !(file instanceof TFile)) return { content: `Diagram not found: ${filePath}` }
      const content = await this.app.vault.read(file)
      const extracted = this.diagramExtractor.extract(filePath, content)
      return {
        content: JSON.stringify({
          title: extracted.title,
          nodeCount: extracted.nodes.length,
          edgeCount: extracted.edges.length,
          nodes: extracted.nodes,
          edges: extracted.edges,
          freeText: extracted.freeText,
          summary: extracted.summary,
        }, null, 2),
      }
    } catch (e) {
      return { content: `Error reading diagram: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  private async searchDiagrams(input: Record<string, unknown>): Promise<ToolResult> {
    if (!this.excalidraw) return { content: 'Excalidraw plugin is not installed.' }
    const query = input.query as string
    const topK = (input.topK as number) ?? 3
    const queryEmbedding = await embed(query)
    const results = this.store.searchDiagrams(queryEmbedding, topK)
    if (results.length === 0) return { content: 'No diagrams indexed yet. Try re-indexing.' }
    return {
      content: JSON.stringify(results.map((r) => ({
        filePath: r.chunk.diagramPath,
        title: r.chunk.title,
        nodeCount: r.chunk.nodeCount,
        edgeCount: r.chunk.edgeCount,
        summary: r.chunk.content.split('\n').slice(0, 3).join(' '),
        score: Math.round(r.score * 100) / 100,
      })), null, 2),
    }
  }

  private createDiagram(input: Record<string, unknown>): ToolResult {
    if (!this.excalidraw) return { content: 'Excalidraw plugin is not installed.' }
    const spec: DiagramSpec = {
      type: input.type as DiagramSpec['type'],
      title: input.title as string,
      nodes: (input.nodes as SpecNode[]) ?? [],
      edges: (input.edges as SpecEdge[]) ?? [],
    }
    const folder = this.resolveDiagramFolder(input.folder as string | undefined)
    const fileName = `${spec.title.replace(/[/\\:*?"<>|]/g, '-')}.excalidraw`
    const filePath = folder ? `${folder.replace(/\/$/, '')}/${fileName}` : fileName

    const content = this.diagramLayoutEngine.layout(spec)
    const change: PendingChange = { kind: 'create_diagram', filePath, content, spec }

    return {
      content: JSON.stringify({ status: 'pending_approval', filePath, nodeCount: spec.nodes.length, edgeCount: spec.edges.length }),
      pendingChange: change,
    }
  }

  private async updateDiagram(input: Record<string, unknown>): Promise<ToolResult> {
    if (!this.excalidraw) return { content: 'Excalidraw plugin is not installed.' }
    const filePath = input.filePath as string
    let originalContent
    try {
      originalContent = await this.excalidraw.readFile(filePath)
    } catch {
      return { content: `Diagram not found: ${filePath}` }
    }

    const addNodes = (input.addNodes as SpecNode[] | undefined) ?? []
    const addEdges = (input.addEdges as SpecEdge[] | undefined) ?? []
    const updateLabels = (input.updateLabels as Array<{ nodeId: string; newLabel: string }> | undefined) ?? []

    const updatedContent = JSON.parse(JSON.stringify(originalContent))

    // Find bounding box of existing elements to place new nodes in free area
    const existingEls = updatedContent.elements
    const maxX = existingEls.reduce((m: number, e: { x?: number; width?: number }) => Math.max(m, (e.x ?? 0) + (e.width ?? 0)), 200)
    let nextX = maxX + 80, nextY = 100

    const newElIds = new Map<string, string>()
    for (const node of addNodes) {
      const elId = `update_${node.id}_${Date.now()}`
      newElIds.set(node.id, elId)
      updatedContent.elements.push({
        id: elId, type: 'rectangle',
        x: nextX, y: nextY,
        width: 160, height: 60,
        label: { text: node.label },
        backgroundColor: '#f0f9e8', strokeColor: '#888888',
        fontSize: 16, fontFamily: 1, textAlign: 'center', boundElements: [],
      })
      nextY += 100
      if (nextY > 800) { nextY = 100; nextX += 200 }
    }

    for (const edge of addEdges) {
      const fromId = newElIds.get(edge.from) ?? edge.from
      const toId = newElIds.get(edge.to) ?? edge.to
      updatedContent.elements.push({
        id: `arrow_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        type: 'arrow', x: 0, y: 0, width: 0, height: 0,
        startBinding: { elementId: fromId, focus: 0, gap: 8 },
        endBinding: { elementId: toId, focus: 0, gap: 8 },
        strokeColor: '#666666', boundElements: [],
        ...(edge.label ? { label: { text: edge.label } } : {}),
      })
    }

    for (const upd of updateLabels) {
      const el = updatedContent.elements.find((e: { id: string }) => e.id === upd.nodeId)
      if (el) {
        if (el.text !== undefined) el.text = upd.newLabel
        if (el.label) el.label.text = upd.newLabel
      }
    }

    const parts: string[] = []
    if (addNodes.length > 0) parts.push(`${addNodes.length} node(s) added`)
    if (addEdges.length > 0) parts.push(`${addEdges.length} edge(s) added`)
    if (updateLabels.length > 0) parts.push(`${updateLabels.length} label(s) updated`)
    const diffSummary = parts.join(', ') || 'No changes'

    const change: PendingChange = { kind: 'update_diagram', filePath, originalContent, updatedContent, diffSummary }
    return {
      content: JSON.stringify({ status: 'pending_approval', filePath, diffSummary }),
      pendingChange: change,
    }
  }

  private async annotateDiagram(input: Record<string, unknown>): Promise<ToolResult> {
    if (!this.excalidraw) return { content: 'Excalidraw plugin is not installed.' }
    const diagramPath = input.diagramPath as string
    const notePath = input.notePath as string
    const annotationText = (input.annotationText as string | undefined) ?? ''

    const noteFile = this.app.vault.getFileByPath(notePath)
    if (!noteFile) return { content: `Note not found: ${notePath}` }

    const noteName = notePath.replace(/\.md$/, '')

    const style = this.diagramEmbedStyle
    const noteLink = style === 'embed' ? `![[${diagramPath}]]` : `[[${diagramPath}]]`
    const noteAddition = annotationText
      ? `${annotationText}\n${noteLink}`
      : `\n## Related Diagram\n${noteLink}`

    // Find bottom-right corner of diagram
    let diagramEls: ExcalidrawElement[] = []
    try { diagramEls = await this.excalidraw!.getElementsFromFile(diagramPath) } catch { diagramEls = [] }
    const maxX = diagramEls.reduce((m, e) => Math.max(m, e.x + e.width), 600)
    const maxY = diagramEls.reduce((m, e) => Math.max(m, e.y + e.height), 400)

    const diagramAddition: ExcalidrawElement = {
      id: `annotation_${Date.now()}`,
      type: 'text',
      x: maxX + 20, y: maxY + 20,
      width: 200, height: 30,
      text: `→ [[${noteName}]]`,
      strokeColor: '#666666', fontSize: 14, fontFamily: 1,
      textAlign: 'left', boundElements: [],
    }

    const change: PendingChange = { kind: 'annotate_diagram', diagramPath, notePath, diagramAddition, noteAddition }
    return {
      content: JSON.stringify({ status: 'pending_approval', diagramPath, notePath }),
      pendingChange: change,
    }
  }
}
