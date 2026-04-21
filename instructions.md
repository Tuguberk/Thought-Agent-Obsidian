# Obsidian AI Agent Plugin — Implementation Prompt

You are tasked with building an **Obsidian plugin** that adds an AI agent capable of conversing with the user's notes, manipulating the knowledge graph, and creating new notes — all in a fully **agentic** manner (the agent decides what to do, which tools to call, and when it has enough context).

This document is the complete specification. Read it fully before writing any code.

---

## 1. Project Overview

**Name:** Obsidian AI Agent (working title — user can rename)

**Core Idea:** A plugin that lets the user chat with an AI agent that has deep access to their Obsidian vault. The agent can:
- Search notes semantically and traverse the graph structure
- Answer questions grounded in the user's notes
- Focus on specific topics/tags during a session (user-specified constraints)
- Compile information across notes into answers or new notes
- Create and edit notes (always through a preview → user approval → commit flow)
- Link notes together and propose graph reorganizations
- Open a filtered graph view for a specific query (e.g., "show me only Ottoman history notes")

**Key principle:** Fully **agentic** — the agent uses a ReAct loop and decides its own retrieval strategy. No one-shot RAG. The agent can iteratively search, read, traverse, and re-query until it has enough context.

**Out of scope for v1:** Web search, fetching external URLs/YouTube transcripts. Architecture must leave room to add these later.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  Obsidian Plugin                    │
│                                                     │
│  ┌─────────────┐   ┌─────────────┐   ┌───────────┐  │
│  │  ChatView   │   │ PreviewView │   │ GraphView │  │
│  │ (sidebar)   │   │  (tab)      │   │  (tab)    │  │
│  └──────┬──────┘   └──────┬──────┘   └─────┬─────┘  │
│         │                 │                 │       │
│  ┌──────┴─────────────────┴─────────────────┴─────┐ │
│  │              Agent Loop (ReAct)                │ │
│  │   Planner → Tool call → Observe → repeat       │ │
│  └──────┬─────────────────────────────────────────┘ │
│         │                                           │
│  ┌──────┴──────┐         ┌──────────────────────┐   │
│  │   Tools     │◄───────►│  Retrieval Engine    │   │
│  │  (8 total)  │         │ (hybrid+graph+MMR)   │   │
│  └──────┬──────┘         └──────────┬───────────┘   │
│         │                           │               │
│  ┌──────┴───────────────────────────┴────────────┐  │
│  │            Provider Abstraction               │  │
│  │  AnthropicProvider | LocalProvider (later)    │  │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  Data: vectors.json, Obsidian Vault API,            │
│        MetadataCache (links, backlinks, tags)       │
└─────────────────────────────────────────────────────┘
```

---

## 3. Tech Stack

- **Language:** TypeScript
- **Framework:** Obsidian Plugin API
- **LLM Provider (v1):** Anthropic Messages API with native tool use
- **Embeddings:** `@xenova/transformers` with `all-MiniLM-L6-v2` (384-dim, local, ~25MB)
- **Vector Store:** `vectors.json` in the plugin's data folder (simple, upgrade to SQLite if needed later)
- **Build:** esbuild (standard Obsidian plugin toolchain)
- **No heavy frameworks:** No LangChain, no Vercel AI SDK. Direct Anthropic SDK + custom agent loop.

### Why these choices
- Local embeddings → no extra API keys, works offline, user privacy
- Direct Anthropic SDK → Obsidian plugin size stays small, full control of the loop
- Provider abstraction layer → swap in LMStudio/Ollama later without rewriting the agent

---

## 4. Provider Abstraction

Design a `LLMProvider` interface so the agent loop doesn't care which backend is used.

```typescript
interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | ContentBlock[]
}

interface Tool {
  name: string
  description: string
  input_schema: JSONSchema
}

interface LLMResponse {
  content: ContentBlock[]        // text blocks + tool_use blocks
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | ...
}

interface LLMProvider {
  chat(messages: Message[], tools: Tool[], systemPrompt: string): Promise<LLMResponse>
  supportsNativeToolUse(): boolean
}
```

**v1 implementation:** `AnthropicProvider` using the official `@anthropic-ai/sdk` package.

**Future-proofing:** Leave a clear extension point for `OpenAICompatibleProvider` (LMStudio, Ollama, vLLM all expose OpenAI-compatible APIs on a local base URL). Do NOT implement it in v1 but structure the code so adding it is drop-in.

---

## 5. Embedding & Retrieval Pipeline

### 5.1 Indexing

On plugin load (and when the vault is first opened with the plugin):
1. Scan all `.md` files in the vault
2. For each file: chunk it (see 5.2), embed each chunk, store
3. Register a file watcher: when a note is created/modified/deleted, re-embed only that note

Show a progress indicator during the initial indexing. Indexing runs in the background.

### 5.2 Chunking Strategy: Hierarchical + Sliding Window

Three levels:

- **Level 1 — Note summary chunk:** One chunk per note, containing the title + first few lines + all headings as an outline. This is a "map" chunk.
- **Level 2 — Heading chunks:** Split by top-level `#` and `##` headings. Each chunk = heading + content under it.
- **Level 3 — Paragraph chunks:** Inside each L2 chunk, apply a sliding window over paragraphs with ~20% overlap. Target chunk size ~300 tokens.

Every chunk carries metadata:
```typescript
interface Chunk {
  id: string                // stable hash
  level: 1 | 2 | 3
  notePath: string
  noteTitle: string
  heading: string | null    // null for L1
  content: string
  embedding: number[]       // 384 dims
  tokenCount: number
}
```

### 5.3 Hybrid Search

Given a query:

1. Embed the query.
2. **Semantic score:** cosine similarity against all chunks.
3. **BM25 score:** compute BM25 over chunk content. Implement from scratch (it's ~40 lines) — no external library.
4. **Combine:** `finalScore = 0.7 * normalize(semantic) + 0.3 * normalize(bm25)`

Normalize each score to [0, 1] using min-max over the current candidate set before combining.

### 5.4 Graph-Enhanced Retrieval

After getting top-K chunks from hybrid search:

1. Collect the set of unique `notePath`s from the top results.
2. For each, query `app.metadataCache` to get:
   - Outgoing links (notes this note links to)
   - Incoming links (backlinks)
3. Pull the L1 (summary) chunks of those neighbor notes.
4. Re-score neighbors against the query with a penalty factor (e.g., multiply by 0.6 to prioritize direct hits).
5. Merge into the candidate pool.

### 5.5 MMR (Maximal Marginal Relevance)

Final step to avoid redundancy:

```
selected = []
while |selected| < final_k:
  for each candidate c not in selected:
    relevance = score(c)
    redundancy = max cosine(c, s) for s in selected
    mmr_score = λ * relevance - (1 - λ) * redundancy
  pick candidate with highest mmr_score
```

Use `λ = 0.7`. Return the final chunks.

### 5.6 Tool-Facing Output Format

When `search_notes` is called, return an array like:

```typescript
{
  notePath: "Folder/Note.md",
  noteTitle: "Ottoman Empire",
  heading: "## Rise of the Empire",
  content: "...chunk text...",
  score: 0.87,
  level: 2
}
```

The agent then decides whether to call `get_note` for full content.

---

## 6. Agent Loop (ReAct)

### 6.1 Loop Structure

```
system_prompt + user_message → provider.chat(..., tools)
  ↓
response has tool_use blocks?
  ├─ Yes → execute each tool → append tool_result → provider.chat(...) again
  └─ No  → final answer → render in ChatView
```

Implement with a max iteration cap (e.g., 15) to prevent infinite loops. If hit, surface a warning.

### 6.2 System Prompt

The system prompt should:
- Establish the agent is an Obsidian knowledge assistant
- Describe each tool briefly
- Tell the agent it should ground answers in the user's notes; when notes are insufficient, say so explicitly rather than hallucinating
- Include any **session constraints** (see 6.3)

### 6.3 Session Constraints

The user can type things like:
- "Sadece #felsefe notlarına odaklan"
- "Only use notes in the /research folder"
- "Forget that constraint"

Implement a simple `SessionContext` object:

```typescript
interface SessionContext {
  tagFilter: string[] | null
  folderFilter: string[] | null
  customInstructions: string | null
}
```

Inject this into:
1. The system prompt (as natural-language instructions for the agent)
2. The retrieval tools (as hard filters applied before scoring)

Parsing user intent to set constraints can itself be handled by the agent — just provide a tool `set_session_constraint(tag?, folder?, instructions?)` or detect via a lightweight prompt-based classifier. **Simpler approach:** add it as a tool the agent can call.

---

## 7. Tool Set (All 8 in v1)

All **write** tools produce a `PendingChange` object that is sent to `PreviewView`. Nothing is written to disk until the user clicks Approve.

### 7.1 Read Tools

**`search_notes`**
- Input: `{ query: string, topK?: number }`
- Runs the full hybrid + graph-enhanced + MMR pipeline
- Returns: array of chunks with metadata (see 5.6)

**`get_note`**
- Input: `{ notePath: string }`
- Returns: `{ path, title, fullContent, tags, outgoingLinks, backlinks }`

**`get_neighbors`**
- Input: `{ notePath: string, depth?: number }` (default depth 1)
- Returns: list of neighboring notes (both outgoing and incoming links), each with title + path + 1-sentence summary (from L1 chunk)

**`get_backlinks`**
- Input: `{ notePath: string }`
- Returns: notes that link to this one, with the link context (surrounding text snippet)

**`query_graph`**
- Input: `{ filter: { tags?, folders?, linkedTo?, query? } }`
- Returns: a subgraph description (list of nodes + edges) AND triggers the `GraphQueryView` to render this subgraph in a new tab for the user to browse
- This is the "show me a filtered graph" feature

### 7.2 Write Tools (All produce PendingChange → PreviewView)

**`create_note`**
- Input: `{ title, content, folder?, tags?, linksTo?: string[] }`
- Produces a `PendingChange` of type `'create'`
- Opens PreviewView with the proposed note

**`edit_note`**
- Input: `{ notePath, newContent }` OR `{ notePath, patch: { find, replace } }`
- Produces `PendingChange` of type `'edit'` with a diff view
- PreviewView shows before/after side by side

**`link_notes`**
- Input: `{ from, to, linkText?, insertionPoint?: 'end' | 'heading:...' }`
- Produces `PendingChange` of type `'link'` — shows which note gets a new `[[link]]` appended and where

**`reorganize`**
- Input: `{ instructions: string, affectedNotes: string[] }`
- The agent uses this when the user says e.g. "reorganize all my CS notes by topic"
- Produces a multi-step `PendingChange` of type `'reorganize'` — a batch of creates/edits/moves
- PreviewView shows the full plan; user can approve all, reject all, or approve individually

### 7.3 PendingChange Data Model

```typescript
type PendingChange =
  | { kind: 'create', note: { path, content, tags } }
  | { kind: 'edit', notePath: string, diff: Diff }
  | { kind: 'link', notePath: string, insertionPoint: number, linkText: string }
  | { kind: 'reorganize', steps: PendingChange[] }
```

---

## 8. UI / Views

Use Obsidian's native `ItemView` for all three.

### 8.1 ChatView (right sidebar)

- Message list (user + assistant)
- Input box at bottom
- Streaming support: as the agent produces text, stream it. As it calls tools, show small collapsible "Agent used tool X" blocks inline.
- Settings icon → opens SettingsTab
- Shows the active SessionContext at the top (small badge like "Focused on: #felsefe"). Click to clear.

### 8.2 PreviewView (opens as a tab when a write tool is called)

- Shows the `PendingChange` in a readable format
- For `create`: rendered preview of the proposed note
- For `edit`: side-by-side diff
- For `link`: highlighted insertion in the target note
- For `reorganize`: expandable list of all steps with individual approve/reject
- Buttons: **Approve**, **Reject**, **Approve with edits** (opens the content in an editor first)

On approval, actually write to the vault via `app.vault.create` / `app.vault.modify`.

### 8.3 GraphQueryView (opens as a tab when `query_graph` is called)

- A custom graph rendering (use `d3-force` or similar; Obsidian's native graph view is not exposed via API)
- Shows only the filtered subgraph
- Clicking a node opens the note
- Top bar shows the filter description ("Tags: #ottoman, #history")
- Button: "Expand to full graph" or "Close"

### 8.4 SettingsTab

- Provider selector (v1: only "Anthropic", but show a disabled "Local (coming soon)" option)
- Anthropic API key input (stored securely via Obsidian's settings)
- Model dropdown (default: `claude-sonnet-4-5` or whatever is current)
- Max agent iterations (default 15)
- Embedding model (v1: only `all-MiniLM-L6-v2`)
- "Re-index vault" button
- Index status display (X notes, Y chunks, last indexed at ...)

---

## 9. File Structure

```
obsidian-ai-agent/
├── manifest.json
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
├── styles.css
├── src/
│   ├── main.ts                    # Plugin entry, commands, view registration
│   ├── settings.ts                # Settings interface + SettingsTab
│   ├── views/
│   │   ├── ChatView.ts
│   │   ├── PreviewView.ts
│   │   └── GraphQueryView.ts
│   ├── agent/
│   │   ├── AgentLoop.ts           # ReAct loop
│   │   ├── SystemPrompt.ts        # Builds system prompt
│   │   ├── SessionContext.ts
│   │   └── ToolExecutor.ts        # Dispatches tool calls
│   ├── tools/
│   │   ├── index.ts               # Tool registry + schemas
│   │   ├── searchNotes.ts
│   │   ├── getNote.ts
│   │   ├── getNeighbors.ts
│   │   ├── getBacklinks.ts
│   │   ├── queryGraph.ts
│   │   ├── createNote.ts
│   │   ├── editNote.ts
│   │   ├── linkNotes.ts
│   │   └── reorganize.ts
│   ├── providers/
│   │   ├── LLMProvider.ts         # Interface
│   │   └── AnthropicProvider.ts
│   ├── retrieval/
│   │   ├── Indexer.ts             # Walks vault, triggers chunking + embedding
│   │   ├── Chunker.ts             # Hierarchical + sliding window
│   │   ├── Embedder.ts            # Wraps @xenova/transformers
│   │   ├── VectorStore.ts         # vectors.json I/O
│   │   ├── HybridSearch.ts        # Semantic + BM25
│   │   ├── BM25.ts
│   │   ├── GraphEnhanced.ts       # Neighbor expansion
│   │   └── MMR.ts
│   ├── changes/
│   │   ├── PendingChange.ts       # Types
│   │   └── ChangeApplier.ts       # Applies approved changes to vault
│   └── utils/
│       ├── hash.ts
│       └── cosine.ts
```

---

## 10. Implementation Order

Build in this order — each step should be testable before moving on.

**Step 1 — Plugin scaffold**
- Clone Obsidian sample plugin template
- Set up manifest.json, build pipeline
- Hello-world command that shows a notice

**Step 2 — Settings + Anthropic connection**
- SettingsTab with API key field
- Implement `AnthropicProvider`
- A debug command that sends a test message and shows the response

**Step 3 — ChatView (dumb version)**
- Right sidebar view
- Send message → provider.chat → display response
- No tools yet, just conversational

**Step 4 — Embedding pipeline**
- `Embedder` wrapping `@xenova/transformers`
- `Chunker` (hierarchical + sliding window)
- `Indexer` that walks the vault
- `VectorStore` with JSON persistence
- Command: "Re-index vault" with progress

**Step 5 — Retrieval**
- `HybridSearch` (semantic + BM25)
- `GraphEnhanced` using `app.metadataCache`
- `MMR`
- Debug command: "Test search" that takes a query and prints the top chunks

**Step 6 — Agent loop + read tools**
- `AgentLoop` with ReAct
- Register `search_notes`, `get_note`, `get_neighbors`, `get_backlinks`
- Wire into ChatView — now chat actually uses the vault

**Step 7 — Write tools + PreviewView**
- `PendingChange` types
- `PreviewView` rendering creates, edits, links
- `ChangeApplier` writing to vault on approval
- Register `create_note`, `edit_note`, `link_notes`, `reorganize`

**Step 8 — GraphQueryView + `query_graph` tool**
- Custom graph renderer (d3-force or simple SVG)
- Register `query_graph` tool
- Open the view when agent calls the tool

**Step 9 — Session constraints**
- `SessionContext` state
- Add constraint-setting tool OR parse from user input
- Pass constraints into retrieval + system prompt
- UI badge in ChatView

**Step 10 — Polish**
- Streaming in ChatView
- Error handling everywhere
- Better indexing progress UX
- Documentation (README.md with screenshots)

---

## 11. Key Implementation Notes

### Obsidian API cheatsheet
```typescript
// Vault
app.vault.getMarkdownFiles()                  // all .md files
app.vault.read(file)                          // read content
app.vault.create(path, content)
app.vault.modify(file, newContent)
app.vault.on('modify' | 'create' | 'delete', cb)

// Metadata (graph data)
app.metadataCache.getFileCache(file)          // { links, tags, headings, frontmatter }
app.metadataCache.getBacklinksForFile(file)   // returns Map of path → references
app.metadataCache.resolvedLinks               // full link graph

// Views
registerView(VIEW_TYPE, (leaf) => new MyView(leaf))
activateView() → workspace.getRightLeaf(false).setViewState({ type: VIEW_TYPE })
```

### `@xenova/transformers` usage
```typescript
import { pipeline } from '@xenova/transformers'

const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
const output = await embedder(text, { pooling: 'mean', normalize: true })
const embedding = Array.from(output.data)  // number[] of length 384
```
First call downloads the model (~25MB) into the plugin's cache. Show a loading indicator.

### Tool schema format (Anthropic)
```typescript
{
  name: "search_notes",
  description: "Search the user's Obsidian vault...",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "..." },
      topK: { type: "number", description: "...", default: 5 }
    },
    required: ["query"]
  }
}
```

### BM25 implementation sketch
```typescript
function bm25(query: string, chunks: Chunk[], k1 = 1.5, b = 0.75) {
  const queryTerms = tokenize(query)
  const avgDocLen = avg(chunks.map(c => c.tokenCount))
  const df = computeDocumentFrequencies(queryTerms, chunks)
  
  return chunks.map(chunk => {
    let score = 0
    for (const term of queryTerms) {
      const tf = termFreq(term, chunk.content)
      const idf = Math.log((chunks.length - df[term] + 0.5) / (df[term] + 0.5) + 1)
      const norm = 1 - b + b * (chunk.tokenCount / avgDocLen)
      score += idf * (tf * (k1 + 1)) / (tf + k1 * norm)
    }
    return { chunk, score }
  })
}
```

### Agent loop pseudocode
```typescript
async function runAgent(userMessage: string, session: SessionContext) {
  const messages: Message[] = [{ role: 'user', content: userMessage }]
  const systemPrompt = buildSystemPrompt(session)
  
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await provider.chat(messages, ALL_TOOLS, systemPrompt)
    messages.push({ role: 'assistant', content: response.content })
    
    const toolUses = response.content.filter(b => b.type === 'tool_use')
    if (toolUses.length === 0) {
      return response  // final answer
    }
    
    const toolResults = await Promise.all(
      toolUses.map(t => toolExecutor.execute(t.name, t.input))
    )
    messages.push({ role: 'tool', content: toolResults })
  }
  
  throw new Error('Max iterations reached')
}
```

---

## 12. Testing Checklist

Before considering v1 done, verify:

- [ ] Indexing 500+ notes completes without freezing the UI
- [ ] `search_notes` returns relevant results for both keyword-heavy and semantic queries
- [ ] Graph-enhanced retrieval pulls in linked notes when appropriate
- [ ] The agent correctly chains tools (e.g., search → get_note → create_note)
- [ ] Every write goes through PreviewView; nothing is written to disk without approval
- [ ] Session constraints actually filter retrieval results
- [ ] `query_graph` opens a working filtered graph view
- [ ] Re-indexing on note change works without duplicating chunks
- [ ] API errors (bad key, rate limit, network) are handled gracefully in ChatView
- [ ] Settings persist across Obsidian restarts
- [ ] The plugin works in a fresh vault with no prior setup

---

## 13. Things to NOT Do

- Do NOT write to the vault without the PreviewView approval step, ever. Even for "small" edits.
- Do NOT add web search, URL fetching, or YouTube transcript tools in v1 (explicitly deferred).
- Do NOT use LangChain, LlamaIndex, or similar heavy frameworks. Keep the dependency footprint small.
- Do NOT hardcode the model name in multiple places — always read from settings.
- Do NOT block the main thread during embedding. Use async/await throughout and yield to the UI periodically during long indexing jobs.
- Do NOT store the API key in plain text in the repo or in shared config — use Obsidian's plugin data storage.
- Do NOT implement the local LLM provider in v1, but DO keep the provider interface clean so it can be added later without refactoring.

---

## 14. Getting Started

1. Start from the official Obsidian sample plugin template: https://github.com/obsidianmd/obsidian-sample-plugin
2. Follow Section 10 (Implementation Order) step by step.
3. Test each step in a dedicated Obsidian test vault before moving on.
4. When in doubt, prefer simplicity — we can always add complexity later.

Now build it.