export interface ActiveFileInfo {
  path: string
  content: string  // first ~500 chars of the note or diagram text
  isDiagram?: boolean
}

export interface SessionContext {
  tagFilter: string[] | null
  folderFilter: string[] | null
  customInstructions: string | null
  activeFile: ActiveFileInfo | null
}

export function defaultSessionContext(): SessionContext {
  return {
    tagFilter: null,
    folderFilter: null,
    customInstructions: null,
    activeFile: null,
  }
}

export function sessionContextDescription(ctx: SessionContext): string | null {
  const parts: string[] = []
  if (ctx.activeFile) parts.push(`Note: ${ctx.activeFile.path}`)
  if (ctx.tagFilter?.length) parts.push(`Tags: ${ctx.tagFilter.join(', ')}`)
  if (ctx.folderFilter?.length) parts.push(`Folders: ${ctx.folderFilter.join(', ')}`)
  if (ctx.customInstructions) parts.push(ctx.customInstructions)
  return parts.length > 0 ? parts.join(' | ') : null
}

export function sessionContextToPrompt(ctx: SessionContext): string {
  const lines: string[] = []
  if (ctx.activeFile) {
    if (ctx.activeFile.isDiagram) {
      lines.push(`ACTIVE DIAGRAM: The user currently has the Excalidraw diagram "${ctx.activeFile.path}" open.`)
      lines.push(`When the user refers to "this", "it", "the diagram", "bu", "bunu", "bu diyagram", or gives a vague command — they mean THIS diagram.`)
      lines.push(`The diagram image has been attached to the user message. Use it to read handwriting, drawings, and visual content.`)
      lines.push(`You can also call read_diagram on "${ctx.activeFile.path}" to get the structured text representation (nodes, edges, labels).`)
    } else {
      lines.push(`ACTIVE NOTE: The user currently has the note "${ctx.activeFile.path}" open in the editor.`)
      lines.push(`If the user says "edit", "update", "add to", "modify", "change", "fix", "append", "prepend" or similar write commands without specifying a note path, they most likely mean this active note.`)
      lines.push(`Use get_note on this path to read its full content before making changes.`)
      if (ctx.activeFile.content) {
        lines.push(`The first part of the active note content:\n---\n${ctx.activeFile.content}\n---`)
      }
    }
  }
  if (ctx.tagFilter?.length) {
    lines.push(`CONSTRAINT: Only consider notes with tags: ${ctx.tagFilter.join(', ')}`)
  }
  if (ctx.folderFilter?.length) {
    lines.push(`CONSTRAINT: Only consider notes in folders: ${ctx.folderFilter.join(', ')}`)
  }
  if (ctx.customInstructions) {
    lines.push(`CUSTOM INSTRUCTION: ${ctx.customInstructions}`)
  }
  return lines.join('\n')
}
