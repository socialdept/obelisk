/**
 * Best-effort content-language detection (LAB-43). Lexicon-generic: reads a
 * record's own `langs`/`lang` field (many lexicons carry one — e.g. bsky posts'
 * `langs`) and normalizes to a lowercase base code. Returns null when absent, so
 * the FTS config falls back to the configured default (english) rather than
 * guessing. A heavier statistical detector is a follow-up if consumers need it.
 */
export function detectLanguage(record: Record<string, unknown> | null): string | null {
  if (!record) return null
  const langs = record.langs
  if (Array.isArray(langs) && typeof langs[0] === 'string') return normalize(langs[0])
  if (typeof record.lang === 'string') return normalize(record.lang)
  return null
}

function normalize(lang: string): string {
  return lang.toLowerCase().split('-')[0]!.slice(0, 20)
}
