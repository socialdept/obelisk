import type { ReservoirConfig } from './src/config'

export default {
  collections: {
    'site.standard.document': {
      textFields: ['title', 'description', 'textContent'],
    },
    'site.standard.publication': {
      textFields: ['name', 'description'],
    },
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
