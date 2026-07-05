import { createApp } from './api/app'
import { loadConfig, loadEnv } from './config'
import { createDb } from './db/client'
import { migrate } from './db/migrate'
import { createEmbeddingProvider } from './embed/provider'
import { EmbedWorker } from './embed/worker'
import { Blocklist } from './ingest/blocklist'
import { Ingester } from './ingest/ingester'
import { PdsBlocklist } from './ingest/pds-blocklist'
import { TabAdmin } from './ingest/tab-admin'
import { createExtractionResolver } from './lexicon/collection'
import { LexiconRegistry } from './lexicon/registry'
import { createTextKeysResolver } from './lexicon/textkeys'
import { logger } from './log'
import { WebhookWorker } from './webhooks/worker'

const log = logger('obelisk')

const env = loadEnv()
const config = await loadConfig()

await migrate(env.databaseUrl)

const { db, client } = createDb(env.databaseUrl, { statementTimeoutMs: env.dbStatementTimeoutMs })
const embedder = createEmbeddingProvider(env, config)
const lexicons = new LexiconRegistry(db)
// Shared deny-lists: the ingester skips their DIDs/PDSes, the API mutates them.
const blocklist = new Blocklist()
await blocklist.load(db)
const pdsBlocklist = new PdsBlocklist(db, undefined, (config.identity?.didPdsCacheTtlSeconds ?? 86_400) * 1000)
await pdsBlocklist.loadPatterns()
const ingester = new Ingester(db, config, {}, blocklist, pdsBlocklist)
const embedWorker = new EmbedWorker(db, config, embedder, {
  claimSize: env.embedBatchSize,
  textKeys: createTextKeysResolver(lexicons),
  extraction: createExtractionResolver(lexicons, config.collections),
})
const webhookWorker = new WebhookWorker(db, config)
const tabAdmin = new TabAdmin(env.tabFootprintAdminUrl)

const shutdown = async () => {
  log.info('shutting down')
  // Hard deadline: a deep embed/ingest backlog must not hold the process
  // (and the port) hostage — anything unfinished redelivers or re-claims.
  setTimeout(() => {
    log.error('shutdown deadline exceeded, exiting')
    process.exit(1)
  }, 10_000)

  server.stop()
  await ingester.stop()
  await embedWorker.stop()
  await webhookWorker.stop()
  await client.end()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

ingester.start(env.tabWsUrl)
embedWorker.start()
webhookWorker.start()

const app = createApp({
  db,
  config,
  ollama: embedder,
  lexicons,
  tabAdmin,
  blocklist,
  pdsBlocklist,
  limits: env.limits,
  health: {
    ingester: () => ingester.status(),
    embedWorker: () => embedWorker.status(),
    webhookWorker: () => webhookWorker.status(),
    embedder: () => embedder.health(),
  },
  devMode: env.devMode,
})
log.info('embedding provider', { provider: embedder.name, dimensions: embedder.dimensions })
const server = Bun.serve({ port: env.port, hostname: env.host, fetch: app.fetch, idleTimeout: 60 })

log.info('started', { host: env.host, port: env.port })
