import { Hono } from 'hono'
import type { ReservoirConfig } from '../config'
import { ConstellationClient } from '../constellation/client'
import type { Db } from '../db/client'
import type { OllamaClient } from '../embed/ollama'
import { LexiconRegistry } from '../lexicon/registry'
import { bearerAuth } from './auth'
import { linksRoutes } from './routes/links'
import { recordsRoutes } from './routes/records'
import { searchRoutes } from './routes/search'
import { typesRoutes } from './routes/types'

export interface ApiDeps {
  db: Db
  config: ReservoirConfig
  ollama: OllamaClient
  constellation?: ConstellationClient
  lexicons?: LexiconRegistry
  /** Disables API authentication entirely. Local development only. */
  devMode?: boolean
}

export function createApp({ db, config, ollama, constellation, lexicons, devMode }: ApiDeps): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.json({ ok: true }))

  const v1 = new Hono()
  if (devMode) {
    console.warn('⚠️  RESERVOIR_DEV_MODE — API authentication is DISABLED')
  } else {
    v1.use('*', bearerAuth(db))
  }
  // linksRoutes first: its concrete sub-paths must win over /records/:did/:collection/:rkey
  v1.route('/records', linksRoutes(db, constellation ?? new ConstellationClient(db, config.constellation)))
  v1.route('/records', recordsRoutes(db))
  v1.route('/search', searchRoutes(db, ollama))
  v1.route('/types', typesRoutes(db, lexicons ?? new LexiconRegistry(db)))

  app.route('/api/v1', v1)
  return app
}
