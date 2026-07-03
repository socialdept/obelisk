export interface ExtractedType {
  path: string
  nsid: string
}

const NSID_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+(\.[a-zA-Z][a-zA-Z0-9]*)$/

/**
 * Recursively collect every `$type` value in a record with its dot-path
 * (arrays as `field[]`, root as `$type`). Only NSID-shaped values count —
 * `blob` and other markers are skipped.
 */
export function extractTypes(record: unknown): ExtractedType[] {
  const types: ExtractedType[] = []
  walk(record, '', types)
  return dedupe(types)
}

function walk(value: unknown, path: string, types: ExtractedType[]): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, `${path}[]`, types)
    return
  }

  if (value === null || typeof value !== 'object') return

  for (const [key, child] of Object.entries(value)) {
    if (key === '$type') {
      if (typeof child === 'string' && NSID_RE.test(child)) {
        types.push({ path: path === '' ? '$type' : `${path}.$type`, nsid: child })
      }
      continue
    }
    walk(child, path === '' ? key : `${path}.${key}`, types)
  }
}

function dedupe(types: ExtractedType[]): ExtractedType[] {
  const seen = new Set<string>()
  return types.filter((type) => {
    const key = `${type.path}\0${type.nsid}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
