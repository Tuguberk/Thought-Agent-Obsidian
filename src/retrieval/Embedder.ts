import { Notice, Platform, requestUrl } from 'obsidian'

// @xenova/transformers is marked external in esbuild — Node.js require() resolves
// it from node_modules at runtime, preserving import.meta.url and __dirname.
declare const require: (id: string) => Record<string, unknown>

type PipelineFunction = (text: string | string[], options: Record<string, unknown>) => Promise<{ data: Float32Array }>
type TransformersEnv = { cacheDir: string; allowLocalModels: boolean; allowRemoteModels: boolean }

export type EmbeddingProvider = 'local' | 'openai' | 'google'

export interface EmbeddingConfig {
  provider: EmbeddingProvider
  localModel?: string   // Xenova/... model name, only for local
  apiKey?: string       // required for openai / google
  apiModel?: string     // e.g. "text-embedding-3-small" / "text-embedding-004"
  pluginDir?: string    // absolute path, only for local
}

let pipelineInstance: PipelineFunction | null = null
let localModelName = 'Xenova/all-MiniLM-L6-v2'
let loading = false
let loadPromise: Promise<void> | null = null

let currentConfig: EmbeddingConfig = { provider: 'local' }
let currentConfigKey = ''
let ready = false

export function isEmbeddingAvailable(): boolean {
  return ready
}

export async function initEmbedder(config: EmbeddingConfig): Promise<void> {
  const key = JSON.stringify(config)
  if (key === currentConfigKey && ready) return

  currentConfig = config
  currentConfigKey = key
  ready = false

  if (config.provider === 'local') {
    if (Platform.isMobile) {
      new Notice(
        'Semantic search unavailable on mobile: local embedding model requires desktop. ' +
        'Set an OpenAI or Google embedding provider in settings to enable it on mobile.',
        8000,
      )
      return
    }
    await initLocalPipeline(config.localModel ?? 'Xenova/all-MiniLM-L6-v2', config.pluginDir ?? '')
    ready = true
    return
  }

  // API providers
  if (!config.apiKey) {
    new Notice('Embedding API key not set — semantic search disabled. Add your key in settings → embeddings.')
    return
  }
  ready = true
  const providerName = config.provider === 'openai' ? 'OpenAI' : 'Google'
  new Notice(`Embedding provider: ${providerName} (${config.apiModel})`)
}

async function initLocalPipeline(model: string, pluginDir: string): Promise<void> {
  if (pipelineInstance && localModelName === model) { ready = true; return }
  if (loading && loadPromise) return loadPromise

  localModelName = model
  loading = true
  loadPromise = (async () => {
    try {
      new Notice('Loading embedding model…')
      const transformers = require(`${pluginDir}/node_modules/@xenova/transformers`)
      const pipeline = transformers.pipeline as (task: string, model: string) => Promise<PipelineFunction>
      const env = transformers.env as TransformersEnv
      env.cacheDir = `${pluginDir}/models/`
      env.allowLocalModels = false
      env.allowRemoteModels = true
      pipelineInstance = await pipeline('feature-extraction', model)
      new Notice('Embedding model loaded.')
    } catch (e) {
      new Notice(`Failed to load embedding model: ${e.message}`)
      throw e
    } finally {
      loading = false
    }
  })()
  return loadPromise
}

export async function embed(text: string): Promise<number[]> {
  if (!ready) return []

  if (currentConfig.provider === 'local') {
    if (!pipelineInstance) return []
    const output = await pipelineInstance(text, { pooling: 'mean', normalize: true })
    return Array.from(output.data)
  }

  if (currentConfig.provider === 'openai') {
    const results = await embedWithOpenAI([text], currentConfig.apiKey!, currentConfig.apiModel!)
    return results[0] ?? []
  }

  if (currentConfig.provider === 'google') {
    return embedWithGoogle(text, currentConfig.apiKey!, currentConfig.apiModel!)
  }

  return []
}

export async function embedBatch(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  if (!ready || texts.length === 0) return texts.map(() => [])

  if (currentConfig.provider === 'openai') {
    const CHUNK = 100
    const results: number[][] = []
    for (let i = 0; i < texts.length; i += CHUNK) {
      const batch = texts.slice(i, i + CHUNK)
      const embeddings = await embedWithOpenAI(batch, currentConfig.apiKey!, currentConfig.apiModel!)
      results.push(...embeddings)
      if (onProgress) onProgress(Math.min(i + CHUNK, texts.length), texts.length)
    }
    return results
  }

  if (currentConfig.provider === 'google') {
    return embedBatchWithGoogle(texts, currentConfig.apiKey!, currentConfig.apiModel!, onProgress)
  }

  // Local: sequential with UI yields
  const results: number[][] = []
  for (let i = 0; i < texts.length; i++) {
    results.push(await embed(texts[i]))
    if (onProgress) onProgress(i + 1, texts.length)
    if (i % 10 === 0) await yieldToUI()
  }
  return results
}

async function embedWithOpenAI(texts: string[], apiKey: string, model: string): Promise<number[][]> {
  const res = await requestUrl({
    url: 'https://api.openai.com/v1/embeddings',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
    throw: false,
  })
  if (res.status >= 400) throw new Error(`OpenAI embedding error ${res.status}: ${res.text}`)
  const data = res.json as { data: Array<{ index: number; embedding: number[] }> }
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
}

async function embedWithGoogle(text: string, apiKey: string, model: string): Promise<number[]> {
  const res = await requestUrl({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${model}`,
      content: { parts: [{ text }] },
    }),
    throw: false,
  })
  if (res.status >= 400) throw new Error(`Google embedding error ${res.status}: ${res.text}`)
  const data = res.json as { embedding: { values: number[] } }
  return data.embedding.values
}

async function embedBatchWithGoogle(
  texts: string[],
  apiKey: string,
  model: string,
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  const CHUNK = 100
  const results: number[][] = []
  for (let i = 0; i < texts.length; i += CHUNK) {
    const batch = texts.slice(i, i + CHUNK)
    const requests = batch.map(text => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
    }))
    const res = await requestUrl({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
      throw: false,
    })
    if (res.status >= 400) throw new Error(`Google batch embedding error ${res.status}: ${res.text}`)
    const data = res.json as { embeddings: Array<{ values: number[] }> }
    results.push(...data.embeddings.map(e => e.values))
    if (onProgress) onProgress(Math.min(i + CHUNK, texts.length), texts.length)
  }
  return results
}

function yieldToUI(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}
