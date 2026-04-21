import { Notice, FileSystemAdapter } from 'obsidian'

// @xenova/transformers is marked external in esbuild — Node.js require() resolves
// it from node_modules at runtime, preserving import.meta.url and __dirname.
declare const require: (id: string) => Record<string, unknown>

type PipelineFunction = (text: string | string[], options: Record<string, unknown>) => Promise<{ data: Float32Array }>
type TransformersEnv = { cacheDir: string; allowLocalModels: boolean; allowRemoteModels: boolean }

let pipelineInstance: PipelineFunction | null = null
let modelName = 'Xenova/all-MiniLM-L6-v2'
let loading = false
let loadPromise: Promise<void> | null = null

export async function initEmbedder(model: string, pluginDir: string): Promise<void> {
  if (pipelineInstance && modelName === model) return
  if (loading && loadPromise) return loadPromise

  modelName = model
  loading = true

  loadPromise = (async () => {
    try {
      new Notice('Loading embedding model (~25MB)...')

      // Use absolute path so Electron's require() finds the right node_modules
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
  if (!pipelineInstance) throw new Error('Embedder not initialized')
  const output = await pipelineInstance(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

export async function embedBatch(texts: string[], onProgress?: (done: number, total: number) => void): Promise<number[][]> {
  const results: number[][] = []
  for (let i = 0; i < texts.length; i++) {
    results.push(await embed(texts[i]))
    if (onProgress) onProgress(i + 1, texts.length)
    if (i % 10 === 0) await yieldToUI()
  }
  return results
}

function yieldToUI(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}
