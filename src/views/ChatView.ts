import {
  ItemView,
  WorkspaceLeaf,
  Notice,
  MarkdownRenderer,
  setIcon,
} from "obsidian";
import type { Message, ContentBlock } from "../providers/LLMProvider";
import type { AgentLoop } from "../agent/AgentLoop";
import type { SessionContext } from "../agent/SessionContext";
import {
  defaultSessionContext,
} from "../agent/SessionContext";
import type AIAgentPlugin from "../main";

export const CHAT_VIEW_TYPE = "ai-agent-chat";

export class ChatView extends ItemView {
  private plugin: AIAgentPlugin;
  private agentLoop: AgentLoop | null = null;
  private history: Message[] = [];
  private session: SessionContext = defaultSessionContext();

  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private sessionBadgeEl!: HTMLElement;
  private modeMenuBtn!: HTMLButtonElement;
  private modeMenuEl!: HTMLElement;
  private modeAgentItem!: HTMLButtonElement;
  private modePlannerItem!: HTMLButtonElement;
  private modelMenuBtn!: HTMLButtonElement;
  private modelMenuEl!: HTMLElement;
  private runMode: "agent" | "planner" = "agent";
  private disposeModelContextListener: (() => void) | null = null;
  private disposeOutsideMenuListener: (() => void) | null = null;

  private attachments: Array<{ block: ContentBlock; name: string }> = [];
  private attachmentsEl!: HTMLElement;
  private fileInputEl!: HTMLInputElement;

  private abortController: AbortController | null = null;
  private stopped = false;

  constructor(leaf: WorkspaceLeaf, plugin: AIAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Thought agent";
  }
  getIcon(): string {
    return "bot";
  }

  setAgentLoop(loop: AgentLoop): void {
    this.agentLoop = loop;
  }
  updateSession(session: SessionContext): void {
    this.session = session;
    this.refreshSessionBadge();
  }

  private setRunMode(mode: "agent" | "planner"): void {
    this.runMode = mode;
    this.modeMenuBtn.textContent = `${mode === "agent" ? "Agent" : "Planner"} ▾`;
    this.modeAgentItem?.classList.toggle("is-active", mode === "agent");
    this.modePlannerItem?.classList.toggle("is-active", mode === "planner");
    this.closeMenus();
  }

  private toggleMenu(menu: HTMLElement): void {
    const willOpen = !menu.classList.contains("is-open");
    this.closeMenus();
    if (willOpen) menu.classList.add("is-open");
  }

  private closeMenus(): void {
    this.modeMenuEl?.classList.remove("is-open");
    this.modelMenuEl?.classList.remove("is-open");
  }

  private refreshModelMenuLabel(activeModel: string): void {
    this.modelMenuBtn.textContent = `${activeModel} ▾`;
  }

  private async refreshModelMenu(): Promise<void> {
    if (!this.modelMenuEl || !this.modelMenuBtn) return;
    this.modelMenuEl.empty();
    this.modelMenuEl.createEl("div", {
      text: "Loading models...",
      cls: "ai-menu-item ai-menu-item-muted",
    });

    try {
      const models = await this.plugin.listAvailableModels();
      const activeModel = this.plugin.getActiveModel();
      this.modelMenuEl.empty();

      for (const model of models) {
        const item = this.modelMenuEl.createEl("button", {
          cls: "ai-menu-item",
        });
        const row = item.createDiv("ai-menu-item-row");
        row.createEl("span", { text: model, cls: "ai-menu-label" });
        const checkEl = row.createSpan("ai-menu-check");
        setIcon(checkEl, "check");
        item.onclick = async () => {
          await this.plugin.setActiveModel(model);
          this.refreshModelMenuLabel(model);
          this.closeMenus();
          new Notice(`Model changed: ${model}`);
        };
        item.classList.toggle("is-active", model === activeModel);
        checkEl.classList.toggle("is-visible", model === activeModel);
      }

      if (!models.includes(activeModel)) {
        const item = this.modelMenuEl.createEl("button", {
          cls: "ai-menu-item is-active",
        });
        const row = item.createDiv("ai-menu-item-row");
        row.createEl("span", { text: activeModel, cls: "ai-menu-label" });
        const checkEl = row.createSpan("ai-menu-check is-visible");
        setIcon(checkEl, "check");
        item.onclick = async () => {
          await this.plugin.setActiveModel(activeModel);
          this.refreshModelMenuLabel(activeModel);
          this.closeMenus();
        };
      }
      this.refreshModelMenuLabel(activeModel);
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      this.modelMenuEl.empty();
      this.modelMenuEl.createEl("div", {
        text: "Model list unavailable",
        cls: "ai-menu-item ai-menu-item-muted",
      });
      this.refreshModelMenuLabel(this.plugin.getActiveModel());
      new Notice(`Model list could not be loaded: ${err}`);
    }
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("ai-chat-container");

    const header = container.createDiv("ai-chat-header");
    header.createEl("span", { text: "Thought agent", cls: "ai-chat-title" });
    const newChatBtn = header.createEl("button", {
      cls: "ai-chat-settings-btn",
      attr: { "aria-label": "New chat" },
    });
    setIcon(newChatBtn, "square-pen");
    newChatBtn.onclick = () => this.newChat();

    this.messagesEl = container.createDiv("ai-chat-messages");
    this.messagesEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const link = target.closest("a");
      if (!link) return;
      const href = link.getAttribute("data-href") ?? link.getAttribute("href");
      if (!href) return;
      const isInternal =
        link.classList.contains("internal-link") ||
        (!href.startsWith("http://") && !href.startsWith("https://") && !href.startsWith("mailto:"));
      if (isInternal) {
        e.preventDefault();
        void this.app.workspace.openLinkText(href, "", false);
      }
    });

    const inputArea = container.createDiv("ai-chat-input-area");
    const composer = inputArea.createDiv("ai-chat-composer");

    this.sessionBadgeEl = composer.createDiv("ai-composer-context");
    this.refreshSessionBadge();

    this.inputEl = composer.createEl("textarea", {
      attr: { placeholder: "Write about your notes...", rows: "3" },
      cls: "ai-chat-input",
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (this.abortController) this.stop();
        else void this.sendMessage();
      }
    });

    this.attachmentsEl = composer.createDiv("ai-attachments");
    this.attachmentsEl.hide();

    this.fileInputEl = composer.createEl("input", {
      attr: {
        type: "file",
        accept: "image/jpeg,image/png,image/gif,image/webp,application/pdf",
        multiple: "true",
      },
      cls: "ai-file-input-hidden",
    });
    this.fileInputEl.addEventListener("change", () => void this.handleFileSelection());

    const controls = composer.createDiv("ai-composer-controls");
    const left = controls.createDiv("ai-composer-left");
    const addBtn = left.createEl("button", {
      text: "+",
      cls: "ai-composer-icon-btn",
      attr: { "aria-label": "Add file" },
    });
    addBtn.onclick = () => this.fileInputEl.click();

    const modeWrap = left.createDiv("ai-menu-wrap");
    this.modeMenuBtn = modeWrap.createEl("button", {
      text: "Agent ▾",
      cls: "ai-menu-trigger",
      attr: { "aria-label": "Open mode menu" },
    });
    this.modeMenuEl = modeWrap.createDiv("ai-menu-panel");
    this.modeAgentItem = this.modeMenuEl.createEl("button", {
      cls: "ai-menu-item is-active",
    });
    {
      const row = this.modeAgentItem.createDiv("ai-menu-item-row");
      const iconEl = row.createSpan("ai-menu-icon");
      setIcon(iconEl, "bot");
      row.createEl("span", { text: "Agent", cls: "ai-menu-label" });
    }
    this.modePlannerItem = this.modeMenuEl.createEl("button", {
      cls: "ai-menu-item",
    });
    {
      const row = this.modePlannerItem.createDiv("ai-menu-item-row");
      const iconEl = row.createSpan("ai-menu-icon");
      setIcon(iconEl, "list-checks");
      row.createEl("span", { text: "Planner", cls: "ai-menu-label" });
    }
    this.modeMenuBtn.onclick = () => this.toggleMenu(this.modeMenuEl);
    this.modeAgentItem.onclick = () => this.setRunMode("agent");
    this.modePlannerItem.onclick = () => this.setRunMode("planner");

    const modelWrap = left.createDiv("ai-menu-wrap ai-model-wrap");
    this.modelMenuBtn = modelWrap.createEl("button", {
      text: `${this.plugin.getActiveModel()} ▾`,
      cls: "ai-menu-trigger ai-model-trigger",
      attr: { "aria-label": "Open model menu" },
    });
    this.modelMenuEl = modelWrap.createDiv("ai-menu-panel ai-model-menu");
    this.modelMenuBtn.onclick = () => this.toggleMenu(this.modelMenuEl);

    this.sendBtn = controls.createEl("button", {
      cls: "mod-cta ai-chat-send-btn",
      attr: { "aria-label": "Send" },
    });
    this.sendBtn.textContent = "↑";
    this.sendBtn.onclick = () => {
      if (this.abortController) this.stop();
      else void this.sendMessage();
    };

    this.renderWelcome();

    await this.refreshModelMenu();
    this.disposeModelContextListener?.();
    this.disposeModelContextListener = this.plugin.onChatModelContextChanged(
      () => {
        void this.refreshModelMenu();
      },
    );

    this.disposeOutsideMenuListener?.();
    const outsideHandler = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (!target) return;
      const modeInside =
        this.modeMenuBtn?.contains(target) || this.modeMenuEl?.contains(target);
      const modelInside =
        this.modelMenuBtn?.contains(target) ||
        this.modelMenuEl?.contains(target);
      if (!modeInside && !modelInside) this.closeMenus();
    };
    activeDocument.addEventListener("mousedown", outsideHandler);
    this.disposeOutsideMenuListener = () => {
      activeDocument.removeEventListener("mousedown", outsideHandler);
    };
  }

  onClose(): Promise<void> {
    this.disposeModelContextListener?.();
    this.disposeModelContextListener = null;
    this.disposeOutsideMenuListener?.();
    this.disposeOutsideMenuListener = null;
    this.stop();
    return Promise.resolve();
  }

  private stop(): void {
    this.stopped = true;
    this.abortController?.abort();
  }

  private renderWelcome(): void {
    this.messagesEl.createDiv("ai-chat-welcome").createEl("p", {
      text: "Ask me anything about your notes. I can search, summarize, link ideas, and create new notes.",
    });
  }

  private newChat(): void {
    this.stop();
    this.history = [];
    this.session = {
      ...this.session,
      tagFilter: null,
      folderFilter: null,
      customInstructions: null,
    };
    this.messagesEl.empty();
    this.renderWelcome();
    this.inputEl.value = "";
    this.setRunning(false);
    this.refreshSessionBadge();
    this.plugin.wireAgentLoop();
  }

  private refreshSessionBadge(): void {
    this.sessionBadgeEl.empty();
    const ctx = this.session;
    const chips: { icon: string; label: string; onClear?: () => void }[] = [];

    if (ctx.activeFile) {
      const name = ctx.activeFile.isDiagram
        ? (ctx.activeFile.path.split("/").pop()?.replace(/\.excalidraw$/, "") ?? ctx.activeFile.path)
        : (ctx.activeFile.path.split("/").pop()?.replace(/\.md$/, "") ?? ctx.activeFile.path);
      chips.push({
        icon: ctx.activeFile.isDiagram ? "🖼️" : "📄",
        label: name,
        onClear: () => {
          this.session = { ...this.session, activeFile: null };
          this.refreshSessionBadge();
        },
      });
    }
    if (ctx.tagFilter?.length) {
      chips.push({
        icon: "#",
        label: ctx.tagFilter.join(", "),
        onClear: () => {
          this.session = { ...this.session, tagFilter: null };
          this.refreshSessionBadge();
        },
      });
    }
    if (ctx.folderFilter?.length) {
      chips.push({
        icon: "📁",
        label: ctx.folderFilter.join(", "),
        onClear: () => {
          this.session = { ...this.session, folderFilter: null };
          this.refreshSessionBadge();
        },
      });
    }

    if (chips.length === 0) {
      this.sessionBadgeEl.hide();
      return;
    }

    this.sessionBadgeEl.show();
    for (const chip of chips) {
      const el = this.sessionBadgeEl.createDiv("ai-context-chip");
      el.createEl("span", { text: chip.icon, cls: "ai-context-chip-icon" });
      el.createEl("span", { text: chip.label, cls: "ai-context-chip-label" });
      if (chip.onClear) {
        const x = el.createEl("button", {
          text: "×",
          cls: "ai-context-chip-clear",
        });
        x.onclick = (e) => {
          e.stopPropagation();
          chip.onClear!();
        };
      }
    }
  }

  private async sendMessage(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || !this.agentLoop) {
      if (!this.agentLoop)
        new Notice(
          "Thought agent not initialized. Check your API key in settings.",
        );
      return;
    }

    this.inputEl.value = "";
    const pendingAttachments = this.attachments.splice(0);
    this.renderAttachmentChips();
    this.stopped = false;
    this.abortController = new AbortController();
    this.setRunning(true);

    this.addUserBubble(text, pendingAttachments);
    const bubble = this.messagesEl.createDiv("ai-bubble ai-bubble-assistant");

    // State for chronological rendering
    let currentTextEl: HTMLElement | null = null;
    let currentRawText = "";
    let lastToolDetailsEl: HTMLElement | null = null;
    let thinkingEl: HTMLElement | null = null;
    const getToolPill = (toolName: string): { label: string; cls: string } => {
      const n = toolName.toLowerCase();
      if (
        n.includes("git") ||
        n.includes("commit") ||
        n.includes("branch") ||
        n.includes("pull_request")
      ) {
        return { label: "GIT", cls: "ai-tool-pill-git" };
      }
      if (
        n.includes("web") ||
        n.includes("http") ||
        n.includes("url") ||
        n.includes("browser")
      ) {
        return { label: "WEB", cls: "ai-tool-pill-web" };
      }
      if (
        n.includes("graph") ||
        n.includes("neighbor") ||
        n.includes("backlink")
      ) {
        return { label: "GRAPH", cls: "ai-tool-pill-graph" };
      }
      if (
        n.includes("search") ||
        n.includes("retriev") ||
        n.includes("query")
      ) {
        return { label: "RET", cls: "ai-tool-pill-ret" };
      }
      if (n.includes("session") || n.includes("constraint")) {
        return { label: "SESSION", cls: "ai-tool-pill-session" };
      }
      return { label: "FS", cls: "ai-tool-pill-fs" };
    };
    const renderMarkdownInto = (el: HTMLElement, raw: string) => {
      if (!raw.trim()) return;
      try {
        el.empty();
        const renderMarkdown = (
          MarkdownRenderer as unknown as {
            renderMarkdown?: (
              markdown: string,
              containerEl: HTMLElement,
              sourcePath: string,
              component: ChatView,
            ) => void | Promise<void>;
          }
        ).renderMarkdown;
        const rendered = renderMarkdown
          ? renderMarkdown(raw, el, "", this)
          : MarkdownRenderer.render(this.app, raw, el, "", this);
        Promise.resolve(rendered)
          .then(() => {
            if (!el.hasChildNodes()) el.textContent = raw;
          })
          .catch(() => {
            el.textContent = raw;
          });
      } catch {
        el.textContent = raw;
      }
    };
    const finalizeTextBlock = (el: HTMLElement, raw: string) => {
      renderMarkdownInto(el, raw);
    };

    const getOrCreateTextEl = () => {
      if (!currentTextEl) {
        currentTextEl = bubble.createDiv("ai-text-block");
        currentRawText = "";
      }
      return currentTextEl;
    };

    try {
      const plannerMode = this.runMode === "planner";
      const loopBudget = plannerMode
        ? Math.min(80, Math.max(this.plugin.settings.maxIterations * 2, 24))
        : this.plugin.settings.maxIterations;
      const runText = plannerMode
        ? [
            "[PLANNER MODE]",
            "First write a concise plan (3-7 steps) under the heading 'Plan'.",
            "Then execute that plan immediately using tools as needed.",
            "Prefer completing all plan steps before finalizing.",
            `User request: ${text}`,
          ].join("\n")
        : text;

      const finalAnswer = await this.agentLoop.run(
        runText,
        this.history,
        this.session,
        {
          signal: this.abortController.signal,
          maxIterationsOverride: loopBudget,

          onThinkingStart: () => {
            if (this.stopped) return;
            if (currentTextEl) {
              finalizeTextBlock(currentTextEl, currentRawText);
            }
            currentTextEl = null; // next text goes into a fresh block
            currentRawText = "";
            lastToolDetailsEl = null;
            thinkingEl = bubble.createDiv("ai-thinking-block");
            thinkingEl.createEl("span", { cls: "ai-thinking-dot" });
            thinkingEl.createEl("span", {
              text: "Thinking…",
              cls: "ai-thinking-label",
            });
            this.scrollToBottom();
          },

          onThinkingEnd: (ms, reasoning) => {
            if (!thinkingEl) return;
            const secs = (ms / 1000).toFixed(1);
            thinkingEl.empty();
            const details = thinkingEl.createEl("details", {
              cls: "ai-thinking-details",
            });
            details.createEl("summary", { text: `Thought for ${secs}s` });
            const contentEl = details.createDiv("ai-thinking-content");
            const reasoningText = (reasoning ?? "").trim();
            if (reasoningText) renderMarkdownInto(contentEl, reasoningText);
            else
              contentEl.textContent =
                "Reasoning content was not provided by the model.";
            thinkingEl = null;
            this.scrollToBottom();
          },

          onTextDelta: (delta) => {
            if (this.stopped) return;
            currentRawText += delta;
            getOrCreateTextEl().textContent = currentRawText;
            this.scrollToBottom();
          },

          onToolCall: (name, input) => {
            if (this.stopped) return;
            if (currentTextEl) {
              finalizeTextBlock(currentTextEl, currentRawText);
            }
            currentTextEl = null; // tool call breaks the current text run
            currentRawText = "";
            const toolEl = bubble.createDiv("ai-tool-call");
            const details = toolEl.createEl("details", {
              cls: "ai-tool-details",
            });
            lastToolDetailsEl = details;
            const summary = details.createEl("summary", {
              cls: "ai-tool-summary",
            });
            const titleRow = summary.createDiv("ai-tool-title-row");
            const pill = getToolPill(name);
            titleRow.createEl("span", {
              text: pill.label,
              cls: `ai-tool-type-pill ${pill.cls}`,
            });
            titleRow.createEl("span", { text: name, cls: "ai-tool-name" });
            details
              .createEl("pre")
              .createEl("code", { text: JSON.stringify(input, null, 2) });
            this.scrollToBottom();
          },

          onToolResult: (name, result) => {
            if (this.stopped || !lastToolDetailsEl) return;
            const resultEl = lastToolDetailsEl.createDiv("ai-tool-result");
            let display = result;
            try {
              display = JSON.stringify(JSON.parse(result), null, 2);
            } catch {
              /* raw */
            }
            if (name !== "query_graph" && display.length > 500) {
              display = display.slice(0, 500) + "…";
            }
            resultEl.createEl("pre").createEl("code", { text: display });
            this.scrollToBottom();
          },

          onPendingChange: (change) => {
            if (!this.stopped) void this.plugin.openPreviewView(change);
          },

          onGraphQuery: (filter) => {
            if (!this.stopped)
              void this.plugin.openGraphView(filter);
          },
        },
        pendingAttachments.map((a) => a.block),
      );

      if (!this.stopped) {
        // Fallback: if streaming callbacks produced no visible text, use final return value.
        const hasVisibleText = Array.from(
          bubble.querySelectorAll(".ai-text-block"),
        ).some((el) => (el.textContent ?? "").trim().length > 0);
        if (!hasVisibleText && finalAnswer?.trim()) {
          currentRawText = finalAnswer;
          getOrCreateTextEl().textContent = finalAnswer;
          finalizeTextBlock(getOrCreateTextEl(), currentRawText);
        }

        const fullText = Array.from(bubble.querySelectorAll(".ai-text-block"))
          .map((el) => el.textContent ?? "")
          .join("\n")
          .trim();
        this.history.push({ role: "user", content: text });
        this.history.push({ role: "assistant", content: fullText });
        if (this.history.length > 40) this.history = this.history.slice(-40);
      }
    } catch (e: unknown) {
      const errName =
        e && typeof e === "object" && "name" in e
          ? String((e as { name?: unknown }).name)
          : "";
      const errMessage = e instanceof Error ? e.message : String(e);
      const label =
        this.stopped || errName === "AbortError"
          ? "[Stopped]"
          : `Error: ${errMessage}`;
      if (!this.stopped || errName !== "AbortError")
        new Notice(`Agent error: ${errMessage}`);
      getOrCreateTextEl().textContent =
        (getOrCreateTextEl().textContent ?? "") + ` ${label}`;
    } finally {
      (thinkingEl as HTMLElement | null)?.remove();
      if (currentTextEl && currentRawText)
        finalizeTextBlock(currentTextEl, currentRawText);
      this.abortController = null;
      this.setRunning(false);
      this.inputEl.focus();
    }
  }

  private addUserBubble(
    text: string,
    attachments: Array<{ block: ContentBlock; name: string }> = [],
  ): void {
    const bubble = this.messagesEl.createDiv("ai-bubble ai-bubble-user");
    if (attachments.length > 0) {
      const attRow = bubble.createDiv("ai-bubble-attachments");
      for (const att of attachments) {
        const chip = attRow.createDiv("ai-bubble-attachment-chip");
        if (att.block.type === "image") {
          const img = chip.createEl("img", { cls: "ai-bubble-attachment-thumb" });
          img.src = `data:${att.block.source.media_type};base64,${att.block.source.data}`;
        } else {
          chip.createEl("span", { text: "📄", cls: "ai-attachment-icon" });
          chip.createEl("span", { text: att.name, cls: "ai-attachment-name" });
        }
      }
    }
    bubble.createDiv({ cls: "ai-bubble-text", text });
    this.scrollToBottom();
  }

  private setRunning(running: boolean): void {
    this.inputEl.disabled = running;
    if (running) {
      this.sendBtn.empty();
      this.sendBtn.createEl("span", { cls: "ai-stop-square" });
      this.sendBtn.title = "Stop";
      this.sendBtn.classList.add("ai-chat-stop-btn");
      this.sendBtn.classList.remove("mod-cta");
    } else {
      this.sendBtn.empty();
      this.sendBtn.textContent = "↑";
      this.sendBtn.title = "";
      this.sendBtn.classList.remove("ai-chat-stop-btn");
      this.sendBtn.classList.add("mod-cta");
    }
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async handleFileSelection(): Promise<void> {
    const files = Array.from(this.fileInputEl.files ?? []);
    this.fileInputEl.value = "";
    for (const file of files) {
      const block = await this.fileToContentBlock(file);
      if (block) this.attachments.push({ block, name: file.name });
    }
    this.renderAttachmentChips();
  }

  private fileToContentBlock(file: File): Promise<ContentBlock | null> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        if (file.type === "application/pdf") {
          resolve({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64 },
          });
        } else if (
          file.type === "image/jpeg" ||
          file.type === "image/png" ||
          file.type === "image/gif" ||
          file.type === "image/webp"
        ) {
          resolve({
            type: "image",
            source: { type: "base64", media_type: file.type, data: base64 },
          });
        } else {
          resolve(null);
        }
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  private renderAttachmentChips(): void {
    this.attachmentsEl.empty();
    if (this.attachments.length === 0) {
      this.attachmentsEl.hide();
      return;
    }
    this.attachmentsEl.show();
    this.attachments.forEach((att, idx) => {
      const chip = this.attachmentsEl.createDiv("ai-attachment-chip");
      if (att.block.type === "image") {
        const img = chip.createEl("img", { cls: "ai-attachment-thumb" });
        img.src = `data:${att.block.source.media_type};base64,${att.block.source.data}`;
      } else {
        chip.createEl("span", { text: "📄", cls: "ai-attachment-icon" });
      }
      chip.createEl("span", { text: att.name, cls: "ai-attachment-name" });
      const rm = chip.createEl("button", { text: "×", cls: "ai-attachment-remove" });
      rm.onclick = () => {
        this.attachments.splice(idx, 1);
        this.renderAttachmentChips();
      };
    });
  }
}
