import type { ReservoirConfig } from './src/config'

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
    userAgent: 'reservoir (miguel)',
  },
  feeds: {
    following: {
      collection: 'site.standard.graph.subscription',
      path: 'publication',
    },
  },
} satisfies ReservoirConfig
