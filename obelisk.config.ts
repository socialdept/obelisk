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
  // Collection globs the archive keeps — mirror Tab's TAB_COLLECTION_FILTERS.
  // A repo backfill filters to these by default (so it doesn't import a repo's
  // unrelated app.bsky.* etc.); pass `all` to a backfill to override.
  collectionFilters: ['site.standard.*'],
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
  // Where the `interactions` signal sources counts per collection (LAB-40).
  // `auto` (default): local when we consume the collection AND it's backfilled,
  // else Constellation. Override to pin a source.
  interactionSources: {
    threshold: 0.9,
    overrides: {
      // 'app.bsky.feed.like': 'constellation', // a collection we don't archive
    },
  },
  // Identity resolution (LAB-48). The PDS deny-list resolves each DID's PDS and
  // caches it in `did_pds` for this long before re-resolving.
  identity: {
    didPdsCacheTtlSeconds: 86_400, // 24h
  },
} satisfies ObeliskConfig
