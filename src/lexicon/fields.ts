/** Resolves an external NSID to its lexicon schema, or null if unavailable. */
export type ExternalResolver = (nsid: string) => Promise<unknown | null>

interface WalkState {
  fields: Set<string>
  visited: Set<string>
  resolveExternal: ExternalResolver
  depth: number
}

const MAX_DEPTH = 5

/**
 * Derive string-typed property paths from a lexicon schema — the raw material
 * for content extraction. Follows local `#def` refs, external `nsid(#def)`
 * refs, and union members (with a cycle guard), so fields hidden behind
 * indirection are still found. Open unions (`refs: []`) yield nothing here —
 * the /types API fills that gap with $types actually observed in the archive.
 */
export async function deriveTextFields(
  schema: unknown,
  resolveExternal: ExternalResolver = async () => null,
): Promise<string[]> {
  const state: WalkState = { fields: new Set(), visited: new Set(), resolveExternal, depth: 0 }
  const defs = defsOf(schema)
  if (!defs) return []

  for (const [defName, def] of Object.entries(defs)) {
    const marker = `${schemaId(schema)}#${defName}`
    state.visited.add(marker)
    await walk(def, defName === 'main' ? '' : `#${defName}`, schema, state)
  }

  return [...state.fields].sort()
}

async function walk(node: unknown, path: string, schema: unknown, state: WalkState): Promise<void> {
  if (node === null || typeof node !== 'object' || state.depth > MAX_DEPTH) return

  const typed = node as {
    type?: string
    record?: unknown
    items?: unknown
    properties?: Record<string, unknown>
    ref?: string
    refs?: string[]
  }

  switch (typed.type) {
    case 'string':
      if (path !== '') state.fields.add(path)
      return
    case 'record':
      return walk(typed.record, path, schema, state)
    case 'array':
      return walk(typed.items, `${path}[]`, schema, state)
    case 'ref':
      return typed.ref ? followRef(typed.ref, path, schema, state) : undefined
    case 'union': {
      for (const ref of typed.refs ?? []) await followRef(ref, path, schema, state)
      return
    }
  }

  if (!typed.properties) return
  for (const [name, prop] of Object.entries(typed.properties)) {
    await walk(prop, path === '' ? name : `${path}.${name}`, schema, state)
  }
}

async function followRef(ref: string, path: string, schema: unknown, state: WalkState): Promise<void> {
  const [nsid, defName = 'main'] = ref.split('#') as [string, string?]
  const targetSchema = nsid === '' ? schema : await resolveSchema(nsid, state)
  if (!targetSchema) return

  const marker = `${schemaId(targetSchema)}#${defName}`
  if (state.visited.has(marker)) return
  state.visited.add(marker)

  const def = defsOf(targetSchema)?.[defName]
  if (!def) return

  state.depth += 1
  await walk(def, path, targetSchema, state)
  state.depth -= 1
}

async function resolveSchema(nsid: string, state: WalkState): Promise<unknown | null> {
  return state.resolveExternal(nsid).catch(() => null)
}

function defsOf(schema: unknown): Record<string, unknown> | undefined {
  return (schema as { defs?: Record<string, unknown> }).defs
}

function schemaId(schema: unknown): string {
  return (schema as { id?: string }).id ?? 'unknown'
}
