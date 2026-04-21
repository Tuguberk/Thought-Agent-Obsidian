export function hashString(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(36)
}

export function chunkId(notePath: string, level: number, index: number): string {
  return hashString(`${notePath}:${level}:${index}`)
}
