import { App, PluginSettingTab, Setting, Notice, requestUrl } from 'obsidian'
import type AIAgentPlugin from './main'

export interface AIAgentSettings {
  provider: 'anthropic' | 'lmstudio'
  anthropicApiKey: string
  model: string
  lmstudioBaseUrl: string
  lmstudioModel: string
  lmstudioMaxTokens: number
  maxIterations: number
  embeddingModel: string
  indexedNotesCount: number
  indexedChunksCount: number
  lastIndexedAt: string | null
  excalidrawEnabled: boolean
  diagramDefaultFolder: string
  diagramWatcherEnabled: boolean
  diagramEmbedStyle: 'embed' | 'link'
}

export const DEFAULT_SETTINGS: AIAgentSettings = {
  provider: 'anthropic',
  anthropicApiKey: '',
  model: 'claude-sonnet-4-6',
  lmstudioBaseUrl: 'http://localhost:1234/v1',
  lmstudioModel: '',
  lmstudioMaxTokens: 16384,
  maxIterations: 15,
  embeddingModel: 'Xenova/all-MiniLM-L6-v2',
  indexedNotesCount: 0,
  indexedChunksCount: 0,
  lastIndexedAt: null,
  excalidrawEnabled: true,
  diagramDefaultFolder: '',
  diagramWatcherEnabled: true,
  diagramEmbedStyle: 'embed',
}

export class AIAgentSettingTab extends PluginSettingTab {
  plugin: AIAgentPlugin

  constructor(app: App, plugin: AIAgentPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    containerEl.createEl('h2', { text: 'Thought Agent Settings' })

    // --- Provider selector ---
    new Setting(containerEl)
      .setName('Provider')
      .setDesc('LLM provider to use')
      .addDropdown(drop => {
        drop.addOption('anthropic', 'Anthropic (Claude)')
        drop.addOption('lmstudio', 'LM Studio (local)')
        drop.setValue(this.plugin.settings.provider)
        drop.onChange(async (value) => {
          this.plugin.settings.provider = value as 'anthropic' | 'lmstudio'
          await this.plugin.saveSettings()
          this.display()
        })
      })

    // --- Anthropic section ---
    if (this.plugin.settings.provider === 'anthropic') {
      containerEl.createEl('h3', { text: 'Anthropic' })

      new Setting(containerEl)
        .setName('API Key')
        .setDesc('Your Anthropic API key (stored securely in plugin data)')
        .addText(text => {
          text
            .setPlaceholder('sk-ant-...')
            .setValue(this.plugin.settings.anthropicApiKey)
            .onChange(async (value) => {
              this.plugin.settings.anthropicApiKey = value
              await this.plugin.saveSettings()
            })
          text.inputEl.type = 'password'
        })

      new Setting(containerEl)
        .setName('Model')
        .setDesc('Claude model to use')
        .addDropdown(drop => {
          drop.addOption('claude-sonnet-4-6', 'Claude Sonnet 4.6 (recommended)')
          drop.addOption('claude-opus-4-7', 'Claude Opus 4.7')
          drop.addOption('claude-haiku-4-5-20251001', 'Claude Haiku 4.5')
          drop.setValue(this.plugin.settings.model)
          drop.onChange(async (value) => {
            this.plugin.settings.model = value
            await this.plugin.saveSettings()
          })
        })
    }

    // --- LM Studio section ---
    if (this.plugin.settings.provider === 'lmstudio') {
      containerEl.createEl('h3', { text: 'LM Studio' })

      new Setting(containerEl)
        .setName('Base URL')
        .setDesc('LM Studio local server URL (default: http://localhost:1234/v1)')
        .addText(text => {
          text
            .setPlaceholder('http://localhost:1234/v1')
            .setValue(this.plugin.settings.lmstudioBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.lmstudioBaseUrl = value.replace(/\/$/, '')
              await this.plugin.saveSettings()
            })
        })

      new Setting(containerEl)
        .setName('Model name')
        .setDesc('The model identifier shown in LM Studio (e.g. lmstudio-community/Meta-Llama-3-8B-Instruct-GGUF)')
        .addText(text => {
          text
            .setPlaceholder('leave empty to use loaded model')
            .setValue(this.plugin.settings.lmstudioModel)
            .onChange(async (value) => {
              this.plugin.settings.lmstudioModel = value
              await this.plugin.saveSettings()
            })
        })

      new Setting(containerEl)
        .setName('Max tokens')
        .setDesc('Maximum tokens per response (default: 16384). Increase if notes are being cut off.')
        .addText(text => {
          text
            .setPlaceholder('16384')
            .setValue(String(this.plugin.settings.lmstudioMaxTokens))
            .onChange(async (value) => {
              const n = parseInt(value)
              if (!isNaN(n) && n > 0) {
                this.plugin.settings.lmstudioMaxTokens = n
                await this.plugin.saveSettings()
              }
            })
        })

      new Setting(containerEl)
        .setName('Test connection')
        .setDesc('Check that LM Studio is running and reachable')
        .addButton(btn => {
          btn.setButtonText('Test').onClick(async () => {
            btn.setButtonText('Testing...').setDisabled(true)
            try {
              const res = await requestUrl({
                url: `${this.plugin.settings.lmstudioBaseUrl}/models`,
                throw: false,
              })
              if (res.status >= 400) throw new Error(`HTTP ${res.status}`)
              const data = res.json as { data: Array<{ id: string }> }
              const models = data.data.map((m) => m.id).join(', ')
              new Notice(`LM Studio connected. Models: ${models || '(none loaded)'}`)
            } catch (e) {
              new Notice(`Cannot reach LM Studio: ${e.message}`)
            } finally {
              btn.setButtonText('Test').setDisabled(false)
            }
          })
        })
    }

    // --- Shared ---
    containerEl.createEl('h3', { text: 'Agent' })

    new Setting(containerEl)
      .setName('Max iterations')
      .setDesc('Maximum tool-call iterations per query (default: 15)')
      .addSlider(slider => {
        slider
          .setLimits(3, 30, 1)
          .setValue(this.plugin.settings.maxIterations)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxIterations = value
            await this.plugin.saveSettings()
          })
      })

    containerEl.createEl('h3', { text: 'Embeddings' })

    new Setting(containerEl)
      .setName('Embedding model')
      .setDesc('Local embedding model (downloads ~25MB on first use)')
      .addDropdown(drop => {
        drop.addOption('Xenova/all-MiniLM-L6-v2', 'all-MiniLM-L6-v2 (384-dim)')
        drop.setValue(this.plugin.settings.embeddingModel)
        drop.onChange(async (value) => {
          this.plugin.settings.embeddingModel = value
          await this.plugin.saveSettings()
        })
      })

    containerEl.createEl('h3', { text: 'Index status' })

    const statusEl = containerEl.createDiv('index-status')
    const lastIndexed = this.plugin.settings.lastIndexedAt
      ? new Date(this.plugin.settings.lastIndexedAt).toLocaleString()
      : 'Never'
    statusEl.createEl('p', {
      text: `Notes: ${this.plugin.settings.indexedNotesCount} | Chunks: ${this.plugin.settings.indexedChunksCount} | Last indexed: ${lastIndexed}`,
    })

    new Setting(containerEl)
      .setName('Re-index vault')
      .setDesc('Re-scan and re-embed all notes')
      .addButton(btn => {
        btn.setButtonText('Re-index').setCta().onClick(async () => {
          btn.setButtonText('Indexing...').setDisabled(true)
          try {
            await this.plugin.indexer?.reindexAll()
            new Notice('Vault re-indexed successfully!')
            this.display()
          } catch (e) {
            new Notice(`Indexing failed: ${e.message}`)
          } finally {
            btn.setButtonText('Re-index').setDisabled(false)
          }
        })
      })

    // --- Excalidraw Integration ---
    containerEl.createEl('h3', { text: 'Excalidraw Integration' })

    const excalidrawAvailable = (this.plugin as unknown as { excalidrawAdapter?: { isAvailable: boolean } }).excalidrawAdapter?.isAvailable ?? false
    const excalidrawStatusEl = containerEl.createEl('p', {
      text: excalidrawAvailable
        ? '✅ Excalidraw plugin detected — diagram features enabled.'
        : '⚠️ Excalidraw plugin not found — diagram features disabled.',
      cls: 'ai-preview-meta',
    })
    statusEl.style.marginBottom = '8px'

    if (excalidrawAvailable) {
      new Setting(containerEl)
        .setName('Enable diagram watcher')
        .setDesc('Re-index .excalidraw files when they change (no LLM calls, no tokens consumed).')
        .addToggle(t => {
          t.setValue(this.plugin.settings.diagramWatcherEnabled)
          t.onChange(async (v) => {
            this.plugin.settings.diagramWatcherEnabled = v
            await this.plugin.saveSettings()
          })
        })

      new Setting(containerEl)
        .setName('Default diagram folder')
        .setDesc('Folder for new diagrams created by the agent (leave empty for vault root).')
        .addText(t => {
          t.setPlaceholder('e.g. Diagrams')
            .setValue(this.plugin.settings.diagramDefaultFolder)
            .onChange(async (v) => {
              this.plugin.settings.diagramDefaultFolder = v
              await this.plugin.saveSettings()
            })
        })

      new Setting(containerEl)
        .setName('Note embed style')
        .setDesc('How annotate_diagram links diagrams in notes.')
        .addDropdown(d => {
          d.addOption('embed', '![[embed]] — renders diagram inline')
          d.addOption('link', '[[link]] — simple wikilink')
          d.setValue(this.plugin.settings.diagramEmbedStyle)
          d.onChange(async (v) => {
            this.plugin.settings.diagramEmbedStyle = v as 'embed' | 'link'
            await this.plugin.saveSettings()
          })
        })
    }
  }
}
