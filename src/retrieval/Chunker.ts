import { chunkId } from '../utils/hash'

export interface Chunk {
  id: string
  level: 1 | 2 | 3
  notePath: string
  noteTitle: string
  heading: string | null
  content: string
  embedding: number[]
  tokenCount: number
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function extractHeadings(content: string): string[] {
  return content
    .split('\n')
    .filter(l => /^#{1,2} /.test(l))
    .map(l => l.replace(/^#+\s*/, ''))
}

function splitByHeadings(content: string): Array<{ heading: string | null; body: string }> {
  const lines = content.split('\n')
  const sections: Array<{ heading: string | null; body: string }> = []
  let currentHeading: string | null = null
  let currentLines: string[] = []

  for (const line of lines) {
    if (/^#{1,2} /.test(line)) {
      if (currentLines.length > 0 || currentHeading !== null) {
        sections.push({ heading: currentHeading, body: currentLines.join('\n').trim() })
      }
      currentHeading = line.replace(/^#+\s*/, '')
      currentLines = []
    } else {
      currentLines.push(line)
    }
  }

  if (currentLines.length > 0 || currentHeading !== null) {
    sections.push({ heading: currentHeading, body: currentLines.join('\n').trim() })
  }

  return sections
}

function slidingWindowChunks(text: string, targetTokens = 300, overlapFraction = 0.2): string[] {
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0)
  if (paragraphs.length === 0) return []

  const chunks: string[] = []
  let current: string[] = []
  let currentTokens = 0

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para)
    if (currentTokens + paraTokens > targetTokens && current.length > 0) {
      chunks.push(current.join('\n\n'))
      const overlapCount = Math.ceil(current.length * overlapFraction)
      current = current.slice(-overlapCount)
      currentTokens = current.reduce((s, p) => s + estimateTokens(p), 0)
    }
    current.push(para)
    currentTokens += paraTokens
  }

  if (current.length > 0) {
    chunks.push(current.join('\n\n'))
  }

  return chunks
}

export function chunkNote(notePath: string, noteTitle: string, content: string): Omit<Chunk, 'embedding'>[] {
  const chunks: Omit<Chunk, 'embedding'>[] = []
  const firstLines = content.split('\n').slice(0, 5).join('\n')
  const headings = extractHeadings(content)
  const summaryContent = `# ${noteTitle}\n\n${firstLines}\n\n## Outline\n${headings.map(h => `- ${h}`).join('\n')}`

  chunks.push({
    id: chunkId(notePath, 1, 0),
    level: 1,
    notePath,
    noteTitle,
    heading: null,
    content: summaryContent,
    tokenCount: estimateTokens(summaryContent),
  })

  const sections = splitByHeadings(content)
  sections.forEach((section, sIdx) => {
    if (!section.body.trim()) return
    const headingLabel = section.heading ?? noteTitle
    const l2Content = `${section.heading ? `## ${section.heading}\n\n` : ''}${section.body}`

    chunks.push({
      id: chunkId(notePath, 2, sIdx),
      level: 2,
      notePath,
      noteTitle,
      heading: headingLabel,
      content: l2Content,
      tokenCount: estimateTokens(l2Content),
    })

    const subChunks = slidingWindowChunks(section.body)
    subChunks.forEach((sub, subIdx) => {
      chunks.push({
        id: chunkId(notePath, 3, sIdx * 1000 + subIdx),
        level: 3,
        notePath,
        noteTitle,
        heading: headingLabel,
        content: sub,
        tokenCount: estimateTokens(sub),
      })
    })
  })

  return chunks
}
