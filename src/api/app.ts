import { Hono } from 'hono'
import type { ObeliskConfig } from '../config'
import { ConstellationClient } from '../constellation/client'
import type { Db } from '../db/client'
import type { OllamaClient } from '../embed/ollama'
import { TabAdmin } from '../ingest/tab-admin'
import { LexiconRegistry } from '../lexicon/registry'
import { audiencesRoutes } from './routes/audiences'
import { bearerAuth } from './auth'
import { eventsRoutes } from './routes/events'
import { footprintRoutes, watchedRoutes } from './routes/watched'
import { linksRoutes } from './routes/links'
import { recordsRoutes } from './routes/records'
import { searchRoutes } from './routes/search'
import { typesRoutes } from './routes/types'
import { webhooksRoutes } from './routes/webhooks'
import { xrpcRoutes } from './xrpc/collections'

export interface ApiDeps {
  db: Db
  config: ObeliskConfig
  ollama: OllamaClient
  constellation?: ConstellationClient
  lexicons?: LexiconRegistry
  /** Footprint-Tab enrollment client. Defaults to unconfigured (no-op) — see TabAdmin. */
  tabAdmin?: TabAdmin
  /** Disables API authentication entirely. Local development only. */
  devMode?: boolean
}

export function createApp({ db, config, ollama, constellation, lexicons, tabAdmin, devMode }: ApiDeps): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.json({ ok: true }))

  const constellationClient = constellation ?? new ConstellationClient(db, config.constellation)
  const lexiconRegistry = lexicons ?? new LexiconRegistry(db)
  const tab = tabAdmin ?? new TabAdmin(undefined)

  const v1 = new Hono()
  if (devMode) {
    console.warn('⚠️  OBELISK_DEV_MODE — API authentication is DISABLED')
  } else {
    v1.use('*', bearerAuth(db))
  }
  // linksRoutes first: its concrete sub-paths must win over /records/:did/:collection/:rkey
  v1.route('/records', linksRoutes(db, constellationClient))
  v1.route('/records', recordsRoutes(db))
  v1.route('/search', searchRoutes(db, ollama))
  v1.route('/types', typesRoutes(db, lexiconRegistry))
  v1.route('/events', eventsRoutes(db, config))
  v1.route('/webhooks', webhooksRoutes(db))
  v1.route('/audiences', audiencesRoutes(db))
  v1.route('/watched-dids', watchedRoutes(db, tab))
  v1.route('/footprint', footprintRoutes(db))

  app.route('/api/v1', v1)

  // atproto-shaped query surface: /xrpc/{collection}.{verb} (collection plane)
  // + /xrpc/social.dept.obelisk.{verb} (service plane)
  const xrpc = new Hono()
  if (!devMode) xrpc.use('*', bearerAuth(db))
  xrpc.route('/', xrpcRoutes({ db, ollama, config, constellation: constellationClient, lexicons: lexiconRegistry }))
  app.route('/xrpc', xrpc)

  return app
}
