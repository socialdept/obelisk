/**
 * Rich content extraction: pull prose out of a record's `content` object
 * regardless of which publishing platform's block structure it uses.
 *
 * Key names to extract are derived from the content type's published lexicon
 * (via the registry) when available, falling back to a battle-tested default
 * set. Values under `html` keys are tag-stripped.
 */

export type TextKeysResolver = (nsid: string) => Promise<Set<string> | null>

export const DEFAULT_TEXT_KEYS = new Set(['plaintext', 'text', 'markdown', 'html', 'caption', 'alt'])

/** Keys that are string-typed in lexicons but never prose. */
export const NON_PROSE_KEYS = new Set([
  'did', 'uri', 'atURI', 'id', 'src', 'url', 'href', 'ref', 'cid', 'rev', 'align', 'role',
  'level', 'lang', 'mimeType', 'path', 'slug', 'color', 'icon',
])

export async function extractRichText(
  record: Record<string, unknown>,
  resolveTextKeys: TextKeysResolver = async () => null,
  richContentFields: string[] = ['content'],
): Promise<string> {
  const sections: string[] = []

  for (const field of richContentFields) {
    const content = record[field]
    if (content === null || typeof content !== 'object') continue

    const contentType = (content as { $type?: unknown }).$type
    const derived = typeof contentType === 'string' ? await resolveTextKeys(contentType).catch(() => null) : null
    const keys = derived && derived.size > 0 ? derived : DEFAULT_TEXT_KEYS

    const parts: string[] = []
    walk(content, keys, parts)
    const text = parts.join('\n\n').trim()
    if (text !== '') sections.push(text)
  }

  return sections.join('\n\n')
}

function walk(value: unknown, keys: Set<string>, parts: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, keys, parts)
    return
  }

  if (value === null || typeof value !== 'object') return

  for (const [key, child] of Object.entries(value)) {
    if (key === '$type' || NON_PROSE_KEYS.has(key)) continue

    if (typeof child === 'string') {
      if (!keys.has(key) || child.trim() === '') continue
      parts.push(key === 'html' ? stripHtml(child) : child.trim())
      continue
    }

    walk(child, keys, parts)
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Leaf key names from lexicon-derived field paths, filtered to plausible prose. */
export function textKeysFromFieldPaths(paths: string[]): Set<string> {
  const keys = new Set<string>()
  for (const path of paths) {
    const leaf = path.split('.').pop()!.replace('[]', '')
    if (!NON_PROSE_KEYS.has(leaf)) keys.add(leaf)
  }
  return keys
}
