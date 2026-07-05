import { deriveTextFields } from './fields'
import type { LexiconRegistry } from './registry'
import { textKeysFromFieldPaths } from '../embed/rich'

/**
 * Lexicon-driven text keys for a content $type, memoized per process.
 * Returns null when the lexicon is unresolvable or yields nothing —
 * callers fall back to the default key set.
 */
export function createTextKeysResolver(registry: LexiconRegistry) {
  const cache = new Map<string, Set<string> | null>()

  return async (nsid: string): Promise<Set<string> | null> => {
    if (cache.has(nsid)) return cache.get(nsid)!

    const entry = await registry.get(nsid)
    if (!entry.schema) {
      cache.set(nsid, null)
      return null
    }

    const fields = await deriveTextFields(entry.schema, async (ref) => (await registry.get(ref)).schema)
    const keys = textKeysFromFieldPaths(fields)
    const result = keys.size > 0 ? keys : null
    cache.set(nsid, result)
    return result
  }
}
