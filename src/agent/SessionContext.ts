export interface ActiveFileInfo {
  path: string
  content: string  // first ~500 chars of the note
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
    lines.push(`ACTIVE NOTE: The user currently has the note "${ctx.activeFile.path}" open in the editor.`)
    lines.push(`If the user says "edit", "update", "add to", "modify", "change", "fix", "append", "prepend" or similar write commands without specifying a note path, they most likely mean this active note.`)
    lines.push(`Use get_note on this path to read its full content before making changes.`)
    if (ctx.activeFile.content) {
      lines.push(`The first part of the active note content:\n---\n${ctx.activeFile.content}\n---`)
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
