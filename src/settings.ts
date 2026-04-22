import { App, Platform, PluginSettingTab, Setting, Notice, requestUrl } from "obsidian";
import type AIAgentPlugin from "./main";

export interface AIAgentSettings {
  provider: "anthropic" | "lmstudio";
  anthropicApiKey: string;
  model: string;
  lmstudioBaseUrl: string;
  lmstudioModel: string;
  lmstudioMaxTokens: number;
  maxIterations: number;
  // Embedding
  embeddingProvider: "local" | "openai" | "google";
  embeddingModel: string;
  openaiEmbeddingApiKey: string;
  openaiEmbeddingModel: string;
  googleEmbeddingApiKey: string;
  googleEmbeddingModel: string;
  // Index metadata
  indexedNotesCount: number;
  indexedChunksCount: number;
  lastIndexedAt: string | null;
  // Excalidraw
  excalidrawEnabled: boolean;
  diagramDefaultFolder: string;
  diagramWatcherEnabled: boolean;
  diagramEmbedStyle: "embed" | "link";
}

export const DEFAULT_SETTINGS: AIAgentSettings = {
  provider: "anthropic",
  anthropicApiKey: "",
  model: "claude-sonnet-4-6",
  lmstudioBaseUrl: "http://localhost:1234/v1",
  lmstudioModel: "",
  lmstudioMaxTokens: 16384,
  maxIterations: 15,
  embeddingProvider: "local",
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  openaiEmbeddingApiKey: "",
  openaiEmbeddingModel: "text-embedding-3-small",
  googleEmbeddingApiKey: "",
  googleEmbeddingModel: "text-embedding-004",
  indexedNotesCount: 0,
  indexedChunksCount: 0,
  lastIndexedAt: null,
  excalidrawEnabled: true,
  diagramDefaultFolder: "Diagrams",
  diagramWatcherEnabled: true,
  diagramEmbedStyle: "embed",
};

export class AIAgentSettingTab extends PluginSettingTab {
  plugin: AIAgentPlugin;

  constructor(app: App, plugin: AIAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Provider selector ---
    new Setting(containerEl).setName("Provider").setHeading();

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("LLM provider to use")
      .addDropdown((drop) => {
        drop.addOption("anthropic", "Anthropic (Claude)");
        drop.addOption("lmstudio", "Lm studio (local)");
        drop.setValue(this.plugin.settings.provider);
        drop.onChange(async (value) => {
          this.plugin.settings.provider = value as "anthropic" | "lmstudio";
          await this.plugin.saveSettings();
          this.display();
        });
      });

    // --- Anthropic section ---
    if (this.plugin.settings.provider === "anthropic") {
      new Setting(containerEl).setName("Anthropic").setHeading();

      new Setting(containerEl)
        .setName("API key")
        .setDesc("Your Anthropic API key (stored securely in plugin data)")
        .addText((text) => {
          text
            .setPlaceholder("Sk-ant-api-...")
            .setValue(this.plugin.settings.anthropicApiKey)
            .onChange(async (value) => {
              this.plugin.settings.anthropicApiKey = value;
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "password";
        });

      new Setting(containerEl)
        .setName("Model")
        .setDesc("Claude model to use")
        .addDropdown((drop) => {
          drop.addOption("claude-sonnet-4-6", "Claude sonnet 4.6 (recommended)");
          drop.addOption("claude-opus-4-7", "Claude opus 4.7");
          drop.addOption("claude-haiku-4-5-20251001", "Claude haiku 4.5");
          drop.setValue(this.plugin.settings.model);
          drop.onChange(async (value) => {
            this.plugin.settings.model = value;
            await this.plugin.saveSettings();
          });
        });
    }

    // --- LM Studio section ---
    if (this.plugin.settings.provider === "lmstudio") {
      new Setting(containerEl).setName("Lm studio").setHeading();

      new Setting(containerEl)
        .setName("Base URL")
        .setDesc("Lm studio local server URL")
        .addText((text) => {
          text
            .setPlaceholder("Server URL")
            .setValue(this.plugin.settings.lmstudioBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.lmstudioBaseUrl = value.replace(/\/$/, "");
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("Model name")
        .setDesc("The model identifier shown in lm studio (leave empty to use the loaded model)")
        .addText((text) => {
          text
            .setPlaceholder("Leave empty to use loaded model")
            .setValue(this.plugin.settings.lmstudioModel)
            .onChange(async (value) => {
              this.plugin.settings.lmstudioModel = value;
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("Max tokens")
        .setDesc("Maximum tokens per response (default: 16384). Increase if notes are being cut off.")
        .addText((text) => {
          text
            .setPlaceholder("16384")
            .setValue(String(this.plugin.settings.lmstudioMaxTokens))
            .onChange(async (value) => {
              const n = parseInt(value);
              if (!isNaN(n) && n > 0) {
                this.plugin.settings.lmstudioMaxTokens = n;
                await this.plugin.saveSettings();
              }
            });
        });

      new Setting(containerEl)
        .setName("Test connection")
        .setDesc("Check that lm studio is running and reachable")
        .addButton((btn) => {
          btn.setButtonText("Test").onClick(async () => {
            btn.setButtonText("Testing...").setDisabled(true);
            try {
              const res = await requestUrl({
                url: `${this.plugin.settings.lmstudioBaseUrl}/models`,
                throw: false,
              });
              if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
              const data = res.json as { data: Array<{ id: string }> };
              const models = data.data.map((m) => m.id).join(", ");
              new Notice(`LM Studio connected. Models: ${models || "(none loaded)"}`);
            } catch (e) {
              new Notice(`Cannot reach LM Studio: ${(e as Error).message}`);
            } finally {
              btn.setButtonText("Test").setDisabled(false);
            }
          });
        });
    }

    // --- Agent ---
    new Setting(containerEl).setName("Agent").setHeading();

    new Setting(containerEl)
      .setName("Max iterations")
      .setDesc("Maximum tool-call iterations per query (default: 15)")
      .addSlider((slider) => {
        slider
          .setLimits(3, 30, 1)
          .setValue(this.plugin.settings.maxIterations)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxIterations = value;
            await this.plugin.saveSettings();
          });
      });

    // --- Embeddings ---
    new Setting(containerEl).setName("Embeddings").setHeading();

    if (Platform.isMobile && this.plugin.settings.embeddingProvider === "local") {
      containerEl.createEl("p", {
        text: "⚠️ local embedding model does not work on mobile. Semantic search is disabled. Select OpenAI or Google below to enable it.",
        cls: "setting-item-description",
      });
    }

    new Setting(containerEl)
      .setName("Embedding provider")
      .setDesc("Source for text embeddings used in semantic search. Changing provider requires re-indexing the vault.")
      .addDropdown((drop) => {
        drop.addOption("local", "Local (default, desktop only)");
        drop.addOption("openai", "OpenAI");
        drop.addOption("google", "Google");
        drop.setValue(this.plugin.settings.embeddingProvider);
        drop.onChange(async (value) => {
          this.plugin.settings.embeddingProvider = value as "local" | "openai" | "google";
          await this.plugin.saveSettings();
          this.display();
        });
      });

    if (this.plugin.settings.embeddingProvider === "local") {
      new Setting(containerEl)
        .setName("Local embedding model")
        .setDesc("Downloads on first use. Desktop only.")
        .addDropdown((drop) => {
          drop.addOption("Xenova/all-MiniLM-L6-v2", "All-minilm-l6-v2 (384-dim, fast)");
          drop.setValue(this.plugin.settings.embeddingModel);
          drop.onChange(async (value) => {
            this.plugin.settings.embeddingModel = value;
            await this.plugin.saveSettings();
          });
        });
    }

    if (this.plugin.settings.embeddingProvider === "openai") {
      new Setting(containerEl)
        .setName("OpenAI API key")
        .setDesc("Used only for embeddings. Can be the same as your main API key.")
        .addText((text) => {
          text
            .setPlaceholder("API key")
            .setValue(this.plugin.settings.openaiEmbeddingApiKey)
            .onChange(async (value) => {
              this.plugin.settings.openaiEmbeddingApiKey = value;
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "password";
        });

      new Setting(containerEl)
        .setName("OpenAI embedding model")
        .addDropdown((drop) => {
          drop.addOption("text-embedding-3-small", "Text-embedding-3-small (1536-dim, recommended)");
          drop.addOption("text-embedding-3-large", "Text-embedding-3-large (3072-dim, best quality)");
          drop.addOption("text-embedding-ada-002", "Text-embedding-ada-002 (1536-dim, legacy)");
          drop.setValue(this.plugin.settings.openaiEmbeddingModel);
          drop.onChange(async (value) => {
            this.plugin.settings.openaiEmbeddingModel = value;
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("Test OpenAI embedding")
        .addButton((btn) => {
          btn.setButtonText("Test").onClick(async () => {
            btn.setButtonText("Testing...").setDisabled(true);
            try {
              const res = await requestUrl({
                url: "https://api.openai.com/v1/embeddings",
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${this.plugin.settings.openaiEmbeddingApiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: this.plugin.settings.openaiEmbeddingModel,
                  input: "test",
                }),
                throw: false,
              });
              if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${res.text}`);
              const data = res.json as { data: Array<{ embedding: number[] }> };
              new Notice(`OpenAI embedding OK — dim: ${data.data[0].embedding.length}`);
            } catch (e) {
              new Notice(`OpenAI embedding failed: ${(e as Error).message}`);
            } finally {
              btn.setButtonText("Test").setDisabled(false);
            }
          });
        });
    }

    if (this.plugin.settings.embeddingProvider === "google") {
      new Setting(containerEl)
        .setName("Google API key")
        .setDesc("Gemini API key from Google AI studio. Used only for embeddings.")
        .addText((text) => {
          text
            .setPlaceholder("API key")
            .setValue(this.plugin.settings.googleEmbeddingApiKey)
            .onChange(async (value) => {
              this.plugin.settings.googleEmbeddingApiKey = value;
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "password";
        });

      new Setting(containerEl)
        .setName("Google embedding model")
        .addDropdown((drop) => {
          drop.addOption("text-embedding-004", "Text-embedding-004 (768-dim, recommended)");
          drop.setValue(this.plugin.settings.googleEmbeddingModel);
          drop.onChange(async (value) => {
            this.plugin.settings.googleEmbeddingModel = value;
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("Test Google embedding")
        .addButton((btn) => {
          btn.setButtonText("Test").onClick(async () => {
            btn.setButtonText("Testing...").setDisabled(true);
            try {
              const model = this.plugin.settings.googleEmbeddingModel;
              const key = this.plugin.settings.googleEmbeddingApiKey;
              const res = await requestUrl({
                url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${key}`,
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: `models/${model}`,
                  content: { parts: [{ text: "test" }] },
                }),
                throw: false,
              });
              if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${res.text}`);
              const data = res.json as { embedding: { values: number[] } };
              new Notice(`Google embedding OK — dim: ${data.embedding.values.length}`);
            } catch (e) {
              new Notice(`Google embedding failed: ${(e as Error).message}`);
            } finally {
              btn.setButtonText("Test").setDisabled(false);
            }
          });
        });
    }

    // --- Index status ---
    new Setting(containerEl).setName("Index status").setHeading();

    const statusEl = containerEl.createDiv("index-status");
    statusEl.addClass("index-status-section");
    const lastIndexed = this.plugin.settings.lastIndexedAt
      ? new Date(this.plugin.settings.lastIndexedAt).toLocaleString()
      : "Never";
    statusEl.createEl("p", {
      text: `Notes: ${this.plugin.settings.indexedNotesCount} | Chunks: ${this.plugin.settings.indexedChunksCount} | Last indexed: ${lastIndexed}`,
    });

    new Setting(containerEl)
      .setName("Re-index vault")
      .setDesc("Re-scan and re-embed all notes")
      .addButton((btn) => {
        btn
          .setButtonText("Re-index")
          .setCta()
          .onClick(async () => {
            btn.setButtonText("Indexing...").setDisabled(true);
            try {
              await this.plugin.indexer?.reindexAll();
              new Notice("Vault re-indexed successfully!");
              this.display();
            } catch (e) {
              new Notice(`Indexing failed: ${(e as Error).message}`);
            } finally {
              btn.setButtonText("Re-index").setDisabled(false);
            }
          });
      });

    // --- Excalidraw Integration ---
    new Setting(containerEl).setName("Excalidraw integration").setHeading();

    const excalidrawAvailable =
      (
        this.plugin as unknown as {
          excalidrawAdapter?: { isAvailable: boolean };
        }
      ).excalidrawAdapter?.isAvailable ?? false;

    containerEl.createEl("p", {
      text: excalidrawAvailable
        ? "Excalidraw plugin detected — diagram features enabled."
        : "Excalidraw plugin not found — diagram features disabled.",
      cls: "ai-preview-meta",
    });

    if (excalidrawAvailable) {
      new Setting(containerEl)
        .setName("Enable diagram watcher")
        .setDesc("Re-index .Excalidraw files when they change (no LLM calls, no tokens consumed).")
        .addToggle((t) => {
          t.setValue(this.plugin.settings.diagramWatcherEnabled);
          t.onChange(async (v) => {
            this.plugin.settings.diagramWatcherEnabled = v;
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("Default diagram folder")
        .setDesc('Base folder for all new diagrams. If empty, thought agent uses "diagrams" automatically. Agent can create subfolders only under this folder.')
        .addText((t) => {
          t.setPlaceholder("E.g. Diagrams")
            .setValue(this.plugin.settings.diagramDefaultFolder)
            .onChange(async (v) => {
              this.plugin.settings.diagramDefaultFolder = v;
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("Note embed style")
        .setDesc("How annotate_diagram links diagrams in notes.")
        .addDropdown((d) => {
          d.addOption("embed", "![[embed]] — renders diagram inline");
          d.addOption("link", "[[link]] — simple wikilink");
          d.setValue(this.plugin.settings.diagramEmbedStyle);
          d.onChange(async (v) => {
            this.plugin.settings.diagramEmbedStyle = v as "embed" | "link";
            await this.plugin.saveSettings();
          });
        });
    }
  }
}
