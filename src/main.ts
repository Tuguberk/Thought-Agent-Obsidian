import { Plugin, TFile, Notice, FileSystemAdapter, requestUrl } from "obsidian";
import {
  AIAgentSettingTab,
  DEFAULT_SETTINGS,
  type AIAgentSettings,
} from "./settings";
import { ChatView, CHAT_VIEW_TYPE } from "./views/ChatView";
import { PreviewView, PREVIEW_VIEW_TYPE } from "./views/PreviewView";
import { GraphQueryView, GRAPH_VIEW_TYPE } from "./views/GraphQueryView";
import { AnthropicProvider } from "./providers/AnthropicProvider";
import { OpenAICompatibleProvider } from "./providers/OpenAICompatibleProvider";
import type { LLMProvider } from "./providers/LLMProvider";
import { AgentLoop } from "./agent/AgentLoop";
import { ToolExecutor } from "./agent/ToolExecutor";
import { VectorStore } from "./retrieval/VectorStore";
import { Indexer } from "./retrieval/Indexer";
import { initEmbedder } from "./retrieval/Embedder";
import { ChangeApplier } from "./changes/ChangeApplier";
import {
  defaultSessionContext,
  type SessionContext,
} from "./agent/SessionContext";
import type { PendingChange } from "./changes/PendingChange";
import { ExcalidrawAdapter } from "./excalidraw/ExcalidrawAdapter";
import { DiagramIndexer } from "./excalidraw/DiagramIndexer";
import { DiagramWatcher } from "./excalidraw/DiagramWatcher";
import { DiagramExtractor } from "./excalidraw/DiagramExtractor";

type ChatModelContextListener = () => void;

export default class AIAgentPlugin extends Plugin {
  settings!: AIAgentSettings;
  vectorStore!: VectorStore;
  indexer!: Indexer;
  excalidrawAdapter!: ExcalidrawAdapter;
  private diagramIndexer!: DiagramIndexer;
  private diagramWatcher!: DiagramWatcher;
  private applier!: ChangeApplier;
  private session: SessionContext = defaultSessionContext();

  // Pending change queue
  private pendingChanges: PendingChange[] = [];
  private statusBarItem!: HTMLElement;
  private chatModelContextListeners = new Set<ChatModelContextListener>();
  private chatModelContextFingerprint = "";

  async onload(): Promise<void> {
    await this.loadSettings();

    this.vectorStore = new VectorStore(`${this.manifest.dir}/vectors.json`);
    await this.vectorStore.load();

    this.excalidrawAdapter = new ExcalidrawAdapter(this.app);
    this.applier = new ChangeApplier(this.app, this.excalidrawAdapter);
    this.indexer = new Indexer(this.app, this.vectorStore, this);

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
    this.registerView(
      PREVIEW_VIEW_TYPE,
      (leaf) =>
        new PreviewView(leaf, this.applier, {
          onApprove: (change) => this.removePending(change),
          onReject: (change) => this.removePending(change),
        }),
    );
    this.registerView(GRAPH_VIEW_TYPE, (leaf) => new GraphQueryView(leaf));

    this.addSettingTab(new AIAgentSettingTab(this.app, this));

    // Status bar
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("ai-agent-statusbar");
    this.statusBarItem.hide();
    this.renderStatusBar();

    this.addRibbonIcon("bot", "Open thought agent", () => {
      void this.activateChatView();
    });

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => {
        void this.activateChatView();
      },
    });

    this.addCommand({
      id: "approve-all-pending",
      name: "Approve all pending changes",
      callback: () => this.approveAll(),
    });

    this.addCommand({
      id: "reject-all-pending",
      name: "Reject all pending changes",
      callback: () => this.rejectAll(),
    });

    this.addCommand({
      id: "reindex-vault",
      name: "Re-index vault",
      callback: async () => {
        await this.initEmbedderIfNeeded();
        await this.indexer.reindexAll();
      },
    });

    this.addCommand({
      id: "test-connection",
      name: "Test AI connection",
      callback: async () => {
        const provider = this.buildProvider();
        if (!provider) {
          new Notice("No provider configured. Go to settings → thought agent.");
          return;
        }
        try {
          const resp = await provider.chat(
            [{ role: "user", content: 'Say "connected" and nothing else.' }],
            [],
            "You are a helpful assistant.",
          );
          const text = resp.content.find((b) => b.type === "text");
          new Notice(
            `Connection OK: ${(text as { type: "text"; text: string })?.text ?? "no response"}`,
          );
        } catch (e) {
          new Notice(`Connection failed: ${(e as Error).message}`);
        }
      },
    });

    this.app.workspace.onLayoutReady(async () => {
      this.indexer.registerWatcher();
      await this.initEmbedderIfNeeded();
      this.wireAgentLoop();
      this.registerActiveFileTracker();
      this.initExcalidraw();
    });
  }

  onunload(): void {
    void this.vectorStore.save();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as AIAgentSettings;
    this.chatModelContextFingerprint = this.getChatModelContextFingerprint();
  }

  async saveSettings(): Promise<void> {
    const before = this.chatModelContextFingerprint;
    await this.saveData(this.settings);
    this.chatModelContextFingerprint = this.getChatModelContextFingerprint();
    this.wireAgentLoop();
    if (before !== this.chatModelContextFingerprint) {
      this.emitChatModelContextChanged();
    }
  }

  private getChatModelContextFingerprint(): string {
    return JSON.stringify({
      provider: this.settings.provider,
      anthropicApiKey: this.settings.anthropicApiKey,
      model: this.settings.model,
      lmstudioBaseUrl: this.settings.lmstudioBaseUrl,
      lmstudioModel: this.settings.lmstudioModel,
    });
  }

  onChatModelContextChanged(listener: ChatModelContextListener): () => void {
    this.chatModelContextListeners.add(listener);
    return () => {
      this.chatModelContextListeners.delete(listener);
    };
  }

  private emitChatModelContextChanged(): void {
    for (const listener of this.chatModelContextListeners) {
      try {
        listener();
      } catch (e) {
        console.error("Chat model context listener failed", e);
      }
    }
  }

  // ── Pending change queue ─────────────────────────────────────────────────

  private addPending(change: PendingChange): void {
    this.pendingChanges.push(change);
    this.renderStatusBar();
  }

  private removePending(change: PendingChange): void {
    const idx = this.pendingChanges.indexOf(change);
    if (idx !== -1) this.pendingChanges.splice(idx, 1);
    this.renderStatusBar();
  }

  private renderStatusBar(): void {
    this.statusBarItem.empty();
    const count = this.pendingChanges.length;

    if (count === 0) {
      this.statusBarItem.hide();
      return;
    }

    this.statusBarItem.show();

    const label = this.statusBarItem.createEl("span", {
      text: `${count} pending`,
      cls: "ai-statusbar-count",
    });
    label.onclick = () => this.revealFirstPending();

    const approveBtn = this.statusBarItem.createEl("span", {
      text: "Approve all",
      cls: "ai-statusbar-btn ai-statusbar-approve",
    });
    approveBtn.onclick = () => this.approveAll();

    const rejectBtn = this.statusBarItem.createEl("span", {
      text: "Reject all",
      cls: "ai-statusbar-btn ai-statusbar-reject",
    });
    rejectBtn.onclick = () => this.rejectAll();
  }

  private revealFirstPending(): void {
    const leaves = this.app.workspace.getLeavesOfType(PREVIEW_VIEW_TYPE);
    if (leaves.length > 0) void this.app.workspace.revealLeaf(leaves[0]);
  }

  async approveAll(): Promise<void> {
    const changes = [...this.pendingChanges];
    if (changes.length === 0) return;

    let approved = 0;
    for (const change of changes) {
      try {
        await this.applier.apply(change);
        this.removePending(change);
        approved++;
      } catch (e) {
        new Notice(`Failed to apply change: ${(e as Error).message}`);
      }
    }

    // Close all preview leaves without triggering onReject
    for (const leaf of this.app.workspace.getLeavesOfType(PREVIEW_VIEW_TYPE)) {
      (leaf.view as PreviewView).markHandled();
      leaf.detach();
    }

    new Notice(`Approved ${approved} change${approved !== 1 ? "s" : ""}.`);
  }

  rejectAll(): void {
    const count = this.pendingChanges.length;
    if (count === 0) return;

    this.pendingChanges = [];
    this.renderStatusBar();

    for (const leaf of this.app.workspace.getLeavesOfType(PREVIEW_VIEW_TYPE)) {
      (leaf.view as PreviewView).markHandled();
      leaf.detach();
    }

    new Notice(`Rejected ${count} change${count !== 1 ? "s" : ""}.`);
  }

  // ── Provider / agent ─────────────────────────────────────────────────────

  getPluginDir(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return `${adapter.getBasePath()}/${this.manifest.dir ?? ""}`;
    }
    return this.manifest.dir ?? "";
  }

  private async initEmbedderIfNeeded(): Promise<void> {
    try {
      const s = this.settings;
      if (s.embeddingProvider === "openai") {
        await initEmbedder({
          provider: "openai",
          apiKey: s.openaiEmbeddingApiKey,
          apiModel: s.openaiEmbeddingModel,
        });
      } else if (s.embeddingProvider === "google") {
        await initEmbedder({
          provider: "google",
          apiKey: s.googleEmbeddingApiKey,
          apiModel: s.googleEmbeddingModel,
        });
      } else {
        await initEmbedder({
          provider: "local",
          localModel: s.embeddingModel,
          pluginDir: this.getPluginDir(),
        });
      }
    } catch {
      // user notified by initEmbedder
    }
  }

  buildProvider(): LLMProvider | null {
    if (this.settings.provider === "lmstudio") {
      return new OpenAICompatibleProvider(
        this.settings.lmstudioBaseUrl || "http://localhost:1234/v1",
        this.settings.lmstudioModel || "local-model",
        "lm-studio",
        this.settings.lmstudioMaxTokens || 16384,
      );
    }
    if (!this.settings.anthropicApiKey) return null;
    return new AnthropicProvider(
      this.settings.anthropicApiKey,
      this.settings.model,
    );
  }

  getActiveModel(): string {
    if (this.settings.provider === "lmstudio") {
      return this.settings.lmstudioModel || "local-model";
    }
    return this.settings.model;
  }

  async setActiveModel(model: string): Promise<void> {
    if (!model) return;
    if (this.settings.provider === "lmstudio") {
      this.settings.lmstudioModel = model;
    } else {
      this.settings.model = model;
    }
    await this.saveSettings();
  }

  async listAvailableModels(): Promise<string[]> {
    const current = this.getActiveModel();

    try {
      if (this.settings.provider === "lmstudio") {
        const res = await requestUrl({
          url: `${this.settings.lmstudioBaseUrl}/models`,
          throw: false,
        });
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        const data = res.json as { data?: Array<{ id: string }> };
        const models = (data.data ?? []).map((m) => m.id).filter(Boolean);
        return Array.from(new Set([current, ...models].filter(Boolean)));
      }

      if (!this.settings.anthropicApiKey) {
        return Array.from(
          new Set([
            current,
            "claude-sonnet-4-6",
            "claude-opus-4-7",
            "claude-haiku-4-5-20251001",
          ]),
        );
      }

      const res = await requestUrl({
        url: "https://api.anthropic.com/v1/models",
        method: "GET",
        headers: {
          "x-api-key": this.settings.anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
        throw: false,
      });

      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      const data = res.json as { data?: Array<{ id: string }> };
      const models = (data.data ?? []).map((m) => m.id).filter(Boolean);
      return Array.from(new Set([current, ...models].filter(Boolean)));
    } catch {
      if (this.settings.provider === "lmstudio") {
        return Array.from(new Set([current || "local-model"]));
      }
      return Array.from(
        new Set([
          current,
          "claude-sonnet-4-6",
          "claude-opus-4-7",
          "claude-haiku-4-5-20251001",
        ]),
      );
    }
  }

  private initExcalidraw(): void {
    if (
      !this.excalidrawAdapter.isAvailable ||
      !this.settings.excalidrawEnabled
    ) {
      console.debug("[ThoughtAgent] Excalidraw integration disabled.");
      return;
    }
    console.debug("[ThoughtAgent] Excalidraw integration enabled.");
    this.diagramIndexer = new DiagramIndexer(
      this.app,
      this.vectorStore,
      this.excalidrawAdapter,
    );
    this.diagramWatcher = new DiagramWatcher(this.app, this.diagramIndexer);
    if (this.settings.diagramWatcherEnabled) this.diagramWatcher.register();
    void this.diagramIndexer.reindexAll();
    // Re-wire agent loop now that excalidraw is confirmed available
    this.wireAgentLoop();
  }

  private registerActiveFileTracker(): void {
    const diagramExtractor = new DiagramExtractor();

    const setActiveFile = async (file: TFile | null) => {
      if (!file) return;

      const isDiagramFile = await this.excalidrawAdapter.isExcalidrawFile(
        file.path,
      );

      if (isDiagramFile) {
        const elements = this.excalidrawAdapter.isAvailable
          ? await this.excalidrawAdapter.getDecompressedElements(file.path)
          : null;
        const extracted = elements
          ? diagramExtractor.extractFromElements(file.path, elements)
          : diagramExtractor.extract(
              file.path,
              await this.app.vault.cachedRead(file),
            );
        const activeFile = {
          path: file.path,
          content: extracted.rawTextContent.slice(0, 500),
          isDiagram: true as const,
        };
        if (
          this.session.activeFile?.path === activeFile.path &&
          this.session.activeFile?.isDiagram === true &&
          this.session.activeFile?.content === activeFile.content
        )
          return;
        this.session = { ...this.session, activeFile };
        this.getChatView()?.updateSession(this.session);
      } else if (file.extension === "md") {
        const content = await this.app.vault.cachedRead(file);
        const activeFile = { path: file.path, content: content.slice(0, 500) };
        if (
          this.session.activeFile?.path === activeFile.path &&
          this.session.activeFile?.content === activeFile.content
        )
          return;
        this.session = { ...this.session, activeFile };
        this.getChatView()?.updateSession(this.session);
      }
    };

    const clearActiveFile = () => {
      if (this.session.activeFile === null) return;
      this.session = { ...this.session, activeFile: null };
      this.getChatView()?.updateSession(this.session);
    };

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        void setActiveFile(file);
      }),
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!leaf) {
          clearActiveFile();
          return;
        }
        const viewType = leaf.view?.getViewType?.();
        if (viewType === "markdown") return;
        if (viewType === "excalidraw") {
          const file = (leaf.view as unknown as { file?: TFile }).file ?? null;
          void setActiveFile(file);
          return;
        }
        if (viewType === CHAT_VIEW_TYPE) return;
        clearActiveFile();
      }),
    );

    const current = this.app.workspace.getActiveFile();
    if (current) void setActiveFile(current);
  }

  wireAgentLoop(): void {
    const provider = this.buildProvider();
    if (!provider) return;
    const excalidrawAvailable =
      this.excalidrawAdapter?.isAvailable && this.settings.excalidrawEnabled;
    const executor = new ToolExecutor(
      this.app,
      this.vectorStore,
      this.session,
      (updated) => {
        this.session = updated;
        this.getChatView()?.updateSession(updated);
      },
      excalidrawAvailable ? this.excalidrawAdapter : undefined,
      this.settings.diagramDefaultFolder,
      this.settings.diagramEmbedStyle,
    );
    const loop = new AgentLoop(
      provider,
      executor,
      this.settings.maxIterations,
      excalidrawAvailable,
      excalidrawAvailable ? this.excalidrawAdapter : undefined,
    );
    this.getChatView()?.setAgentLoop(loop);
  }

  getChatView(): ChatView | null {
    for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
      if (leaf.view instanceof ChatView) return leaf.view;
    }
    return null;
  }

  async activateChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    if (existing.length > 0) {
      void this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    void this.app.workspace.revealLeaf(leaf);
    this.wireAgentLoop();
  }

  async openPreviewView(change: PendingChange): Promise<void> {
    this.addPending(change);
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: PREVIEW_VIEW_TYPE });
    void this.app.workspace.revealLeaf(leaf);
    const view = leaf.view as PreviewView;
    view.setPendingChange(change);
  }

  async openGraphView(filter: {
    tags?: string[];
    folders?: string[];
    linkedTo?: string;
    query?: string;
  }): Promise<void> {
    let matchCount = 0;
    let matchedPaths: string[] = [];

    const executor = new ToolExecutor(
      this.app,
      this.vectorStore,
      this.session,
      () => {},
    );
    const result = await executor.execute("query_graph", { filter });

    try {
      const data = JSON.parse(result.content) as { matchCount?: unknown; nodes?: { path?: string }[] };
      matchCount = typeof data.matchCount === "number" ? data.matchCount : 0;
      matchedPaths = Array.isArray(data.nodes)
        ? data.nodes
            .map((n) => n.path)
            .filter((p): p is string => typeof p === "string")
        : [];
    } catch (e) {
      console.error("Failed to parse graph query result:", e);
    }

    // Cleanup legacy visible note from previous versions (best effort).
    try {
      const legacyPath = "AI Agent/Graph Query Results.md";
      const legacy = this.app.vault.getFileByPath(legacyPath);
      if (legacy) {
        const text = await this.app.vault.read(legacy);
        if (
          text.includes(
            "This note is managed by AI Agent to drive Local Graph for filtered results.",
          )
        ) {
          await this.app.fileManager.trashFile(legacy);
        }
      }
      const legacyFolder = this.app.vault.getAbstractFileByPath("AI Agent");
      if (
        legacyFolder &&
        "children" in legacyFolder &&
        Array.isArray(legacyFolder.children) &&
        legacyFolder.children.length === 0
      ) {
        await this.app.fileManager.trashFile(legacyFolder);
      }
    } catch {
      // ignore cleanup issues
    }

    const hubCandidates = [
      {
        folder: ".ai-agent",
        path: ".ai-agent/Graph Query Results.md",
        hidden: true,
      },
      { folder: null, path: ".ai-agent-graph-query-results.md", hidden: true },
      // Last-resort fallback for environments that block dot-path note creation.
      {
        folder: "AI Agent",
        path: "AI Agent/Graph Query Results.md",
        hidden: false,
      },
    ];
    const filterParts: string[] = [];
    if (filter.tags?.length) filterParts.push(`tags=${filter.tags.join(", ")}`);
    if (filter.folders?.length)
      filterParts.push(`folders=${filter.folders.join(", ")}`);
    if (filter.linkedTo) filterParts.push(`linkedTo=${filter.linkedTo}`);
    if (filter.query) filterParts.push(`query=${filter.query}`);
    const linkLines = matchedPaths
      .map((p) => `- [[${p.replace(/\.md$/, "")}|${p.replace(/\.md$/, "")}]]`)
      .join("\n");
    const hubContent = [
      "# Graph Query Results",
      "",
      `Filter: ${filterParts.join(" | ") || "none"}`,
      `Matched: ${matchCount}`,
      "",
      "## Matched Notes",
      linkLines || "_No matches found._",
      "",
      "> This note is managed by AI Agent to drive Local Graph for filtered results.",
    ].join("\n");

    let hubPath: string | null = null;
    const hubErrors: string[] = [];
    for (const candidate of hubCandidates) {
      try {
        if (
          candidate.folder &&
          !this.app.vault.getAbstractFileByPath(candidate.folder)
        ) {
          await this.app.vault.createFolder(candidate.folder);
        }
        const existing = this.app.vault.getFileByPath(candidate.path);
        if (existing) await this.app.vault.modify(existing, hubContent);
        else await this.app.vault.create(candidate.path, hubContent);
        hubPath = candidate.path;
        if (!candidate.hidden) {
          new Notice(
            "Hidden graph note path is blocked by current vault settings. Using AI Agent/Graph Query Results.md fallback.",
          );
        }
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        hubErrors.push(`${candidate.path}: ${msg}`);
        // Try next location.
      }
    }

    if (!hubPath) {
      console.error(
        "Failed to prepare graph hub note at all candidate locations.",
        hubErrors,
      );
      const reason = hubErrors[0] ? ` (${hubErrors[0]})` : "";
      new Notice(`Could not create graph query note${reason}`);
      // Fallback without creating files: open local graph for an existing matched note.
      const fallbackPath = filter.linkedTo ?? matchedPaths[0] ?? null;
      if (fallbackPath) {
        const fallbackFile = this.app.vault.getFileByPath(fallbackPath);
        if (fallbackFile) {
          const noteLeaf = this.app.workspace.getLeaf("tab");
          await noteLeaf.openFile(fallbackFile, { active: true });

          const commandIds = [
            "graph:open-local",
            "graph:open-local-graph",
            "workspace:open-local-graph",
          ];
          const commands = (
            this.app as unknown as {
              commands?: {
                commands?: Record<string, unknown>;
                executeCommandById?: (id: string) => boolean;
              };
            }
          ).commands;

          for (const id of commandIds) {
            if (commands?.commands?.[id]) {
              const ok = commands.executeCommandById?.(id);
              if (ok) {
                new Notice("Opened local graph on top filtered match.");
                return;
              }
            }
          }

          const localLeaf = this.app.workspace.getLeaf("tab");
          await localLeaf.setViewState({
            type: "localgraph",
            active: true,
            state: { file: fallbackPath },
          });
          void this.app.workspace.revealLeaf(localLeaf);
          new Notice("Opened local graph on top filtered match.");
          return;
        }
      }

      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: "graph", active: true });
      void this.app.workspace.revealLeaf(leaf);
      return;
    }

    const openLocalGraph = async (notePath: string): Promise<boolean> => {
      const file = this.app.vault.getFileByPath(notePath);
      if (!file) return false;

      // Open note first so local graph can focus it.
      const noteLeaf = this.app.workspace.getLeaf("tab");
      await noteLeaf.openFile(file, { active: true });

      const commandIds = [
        "graph:open-local",
        "graph:open-local-graph",
        "workspace:open-local-graph",
      ];
      const commands = (
        this.app as unknown as {
          commands?: {
            commands?: Record<string, unknown>;
            executeCommandById?: (id: string) => boolean;
          };
        }
      ).commands;

      for (const id of commandIds) {
        if (commands?.commands?.[id]) {
          const ok = commands.executeCommandById?.(id);
          if (ok) return true;
        }
      }

      const localLeaf = this.app.workspace.getLeaf("tab");
      await localLeaf.setViewState({
        type: "localgraph",
        active: true,
        state: { file: notePath },
      });
      void this.app.workspace.revealLeaf(localLeaf);
      return true;
    };

    const openedLocal = await openLocalGraph(hubPath);

    if (!openedLocal) {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: "graph", active: true });
      void this.app.workspace.revealLeaf(leaf);
    }

    const mode = openedLocal ? "Local Graph" : "Graph";
    new Notice(`Opened Obsidian ${mode}. Matched notes: ${matchCount}.`);
  }
}
