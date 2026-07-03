export interface ExtractedLink {
  path: string
  targetUri: string
  targetDid: string | null
  targetCollection: string | null
  targetRkey: string | null
}

const AT_URI_RE = /^at:\/\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9.-]+)\/([a-zA-Z0-9._~:-]+)$/
const DID_RE = /^did:(?:plc|web):[a-zA-Z0-9._:%-]+$/

/**
 * Recursively walk a record and collect every AT Protocol reference:
 * at:// URIs (parsed into did/collection/rkey) and bare DIDs.
 * Paths use dot notation with `[]` marking array traversal (e.g. `contributors[].did`).
 */
export function extractLinks(record: unknown): ExtractedLink[] {
  const links: ExtractedLink[] = []
  walk(record, '', links)
  return dedupe(links)
}

function walk(value: unknown, path: string, links: ExtractedLink[]): void {
  if (typeof value === 'string') {
    const link = parseTarget(value, path)
    if (link) links.push(link)
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) walk(item, `${path}[]`, links)
    return
  }

  if (value === null || typeof value !== 'object') return
  if (isBlob(value)) return

  for (const [key, child] of Object.entries(value)) {
    if (key === '$type') continue
    walk(child, path === '' ? key : `${path}.${key}`, links)
  }
}

function parseTarget(value: string, path: string): ExtractedLink | null {
  const atMatch = value.match(AT_URI_RE)
  if (atMatch) {
    return {
      path,
      targetUri: value,
      targetDid: atMatch[1] ?? null,
      targetCollection: atMatch[2] ?? null,
      targetRkey: atMatch[3] ?? null,
    }
  }

  if (DID_RE.test(value)) {
    return { path, targetUri: value, targetDid: value, targetCollection: null, targetRkey: null }
  }

  return null
}

function isBlob(value: object): boolean {
  return '$type' in value && (value as { $type?: unknown }).$type === 'blob'
}

function dedupe(links: ExtractedLink[]): ExtractedLink[] {
  const seen = new Set<string>()
  return links.filter((link) => {
    const key = `${link.path}\0${link.targetUri}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
