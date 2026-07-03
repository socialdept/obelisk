export interface ChunkOptions {
  chunkChars: number
  chunkOverlap: number
}

/**
 * Split text into chunks of at most chunkChars, preferring paragraph then
 * sentence boundaries, with chunkOverlap characters of context carried over.
 */
export function chunkText(text: string, options: ChunkOptions): string[] {
  const { chunkChars, chunkOverlap } = options
  const trimmed = text.trim()
  if (trimmed === '') return []
  if (trimmed.length <= chunkChars) return [trimmed]

  const chunks: string[] = []
  let position = 0

  while (position < trimmed.length) {
    const end = Math.min(position + chunkChars, trimmed.length)
    const slice = trimmed.slice(position, end)
    const breakAt = end < trimmed.length ? findBreak(slice) : slice.length
    const chunk = slice.slice(0, breakAt).trim()

    if (chunk !== '') chunks.push(chunk)
    if (end >= trimmed.length) break

    position += Math.max(breakAt - chunkOverlap, 1)
  }

  return chunks
}

function findBreak(slice: string): number {
  const paragraph = slice.lastIndexOf('\n\n')
  if (paragraph > slice.length / 2) return paragraph

  const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'))
  if (sentence > slice.length / 2) return sentence + 1

  const space = slice.lastIndexOf(' ')
  if (space > slice.length / 2) return space

  return slice.length
}
