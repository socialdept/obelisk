import type { ObeliskConfig } from './src/config'

export default {
  // Field locations (title/prose/rich content) are derived from each
  // collection's published lexicon. Add per-collection overrides
  // (titleFields/textFields/richContentFields) only when a lexicon is
  // unpublished or wrong.
  collections: {
    'site.standard.document': {},
    'site.standard.publication': {},
    'site.standard.graph.subscription': {},
    'site.standard.graph.recommend': {},
  },
  ollama: {
    model: 'nomic-embed-text',
    dimensions: 768,
    chunkChars: 1800,
    chunkOverlap: 200,
  },
  constellation: {
    baseUrl: 'https://constellation.microcosm.blue',
    ttlSeconds: 3600,
    userAgent: 'obelisk (@socialde.pt)',
  },
  feeds: {
    following: {
      collection: 'site.standard.graph.subscription',
      path: 'publication',
    },
  },
  // Named ranking profiles (LAB-37): score = Σ weightᵢ · transformᵢ(signalᵢ).
  // The `interactions` term is 0 until the rollup lands (LAB-39/40).
  rankings: {
    // Search: relevance first, freshness as a tiebreaker.
    'relevant-fresh': {
      signals: [
        { kind: 'relevance', weight: 1 },
        { kind: 'recency', weight: 0.3, field: 'indexedAt', halfLifeHours: 168 },
      ],
    },
    // Publishing "trending": recommends weigh most, decayed over a week.
    trending: {
      signals: [
        {
          kind: 'interactions',
          weight: 1,
          transform: 'log1p',
          links: [
            { collection: 'site.standard.graph.subscription', path: 'publication', weight: 1 },
            { collection: 'site.standard.graph.recommend', path: 'document', weight: 3 },
          ],
        },
        { kind: 'recency', weight: 1, field: 'indexedAt', halfLifeHours: 168 },
      ],
    },
  },
} satisfies ObeliskConfig
