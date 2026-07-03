import { Hono } from 'hono'
import type { ReservoirConfig } from '../config'
import type { Db } from '../db/client'
import type { OllamaClient } from '../embed/ollama'
import { bearerAuth } from './auth'
import { recordsRoutes } from './routes/records'
import { searchRoutes } from './routes/search'

export interface ApiDeps {
  db: Db
  config: ReservoirConfig
  ollama: OllamaClient
}

export function createApp({ db, config, ollama }: ApiDeps): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.json({ ok: true }))

  const v1 = new Hono()
  v1.use('*', bearerAuth(db))
  v1.route('/records', recordsRoutes(db))
  v1.route('/search', searchRoutes(db, ollama))

  app.route('/api/v1', v1)
  return app
}
