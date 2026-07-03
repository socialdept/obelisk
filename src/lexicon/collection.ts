import type { CollectionConfig } from '../config'
import { NON_PROSE_KEYS } from '../embed/rich'
import type { LexiconRegistry } from './registry'

/** Field names that read as a record's heading when the lexicon declares them as strings. */
export const TITLE_KEYS = ['title', 'name', 'subject', 'headline', 'displayName']

export interface CollectionExtraction {
  titleFields: string[]
  textFields: string[]
  richContentFields: string[]
}

const EMPTY: CollectionExtraction = { titleFields: [], textFields: [], richContentFields: [] }

/**
 * Where a collection's prose lives, derived from its own published lexicon:
 * top-level string properties split into title-like and body fields, and
 * union/ref/object properties treated as rich content containers.
 * Per-collection config overrides any part; unresolvable lexicons fall back
 * to config alone. Memoized per process.
 */
export function createExtractionResolver(registry: LexiconRegistry, config: Record<string, CollectionConfig>) {
  const cache = new Map<string, CollectionExtraction>()

  return async (collection: string): Promise<CollectionExtraction> => {
    if (cache.has(collection)) return cache.get(collection)!

    const derived = await deriveFromLexicon(registry, collection).catch(() => EMPTY)
    const overrides = config[collection]

    const result: CollectionExtraction = {
      titleFields: overrides?.titleFields ?? derived.titleFields,
      textFields: overrides?.textFields ?? derived.textFields,
      richContentFields: overrides?.richContentFields ?? derived.richContentFields,
    }
    cache.set(collection, result)
    return result
  }
}

async function deriveFromLexicon(registry: LexiconRegistry, collection: string): Promise<CollectionExtraction> {
  const entry = await registry.get(collection)
  const properties = recordProperties(entry.schema)
  if (!properties) return EMPTY

  const titleFields: string[] = []
  const textFields: string[] = []
  const richContentFields: string[] = []

  for (const [name, prop] of Object.entries(properties)) {
    const type = (prop as { type?: string }).type

    if (type === 'string') {
      if (NON_PROSE_KEYS.has(name)) continue
      if (TITLE_KEYS.includes(name)) titleFields.push(name)
      else textFields.push(name)
      continue
    }

    if (isRichContainer(prop)) richContentFields.push(name)
  }

  return { titleFields, textFields, richContentFields }
}

function recordProperties(schema: unknown): Record<string, unknown> | undefined {
  const main = (schema as { defs?: { main?: { type?: string; record?: unknown } } }).defs?.main
  if (!main) return undefined
  const target = main.type === 'record' ? main.record : main
  return (target as { properties?: Record<string, unknown> })?.properties
}

function isRichContainer(prop: unknown): boolean {
  const typed = prop as { type?: string; items?: { type?: string } }
  if (typed.type === 'union' || typed.type === 'ref' || typed.type === 'object' || typed.type === 'unknown') return true
  return typed.type === 'array' && isRichContainer(typed.items)
}
