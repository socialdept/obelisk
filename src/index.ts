import { createApp } from './api/app'
import { loadConfig, loadEnv } from './config'
import { createDb } from './db/client'
import { migrate } from './db/migrate'
import { OllamaClient } from './embed/ollama'
import { EmbedWorker } from './embed/worker'
import { Blocklist } from './ingest/blocklist'
import { Ingester } from './ingest/ingester'
import { TabAdmin } from './ingest/tab-admin'
import { createExtractionResolver } from './lexicon/collection'
import { LexiconRegistry } from './lexicon/registry'
import { createTextKeysResolver } from './lexicon/textkeys'
import { WebhookWorker } from './webhooks/worker'

const env = loadEnv()
const config = await loadConfig()

await migrate(env.databaseUrl)

const { db, client } = createDb(env.databaseUrl)
const ollama = new OllamaClient(env.ollamaUrl, config.ollama.model)
const lexicons = new LexiconRegistry(db)
// One shared deny-list: the ingester skips its DIDs, the API mutates it (LAB-47).
const blocklist = new Blocklist()
await blocklist.load(db)
const ingester = new Ingester(db, config, {}, blocklist)
const embedWorker = new EmbedWorker(db, config, ollama, {
  textKeys: createTextKeysResolver(lexicons),
  extraction: createExtractionResolver(lexicons, config.collections),
})
const webhookWorker = new WebhookWorker(db, config)
const tabAdmin = new TabAdmin(env.tabFootprintAdminUrl)

const shutdown = async () => {
  console.log('shutting down…')
  // Hard deadline: a deep embed/ingest backlog must not hold the process
  // (and the port) hostage — anything unfinished redelivers or re-claims.
  setTimeout(() => {
    console.error('shutdown deadline exceeded, exiting')
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

const app = createApp({ db, config, ollama, lexicons, tabAdmin, blocklist, devMode: env.devMode })
const server = Bun.serve({ port: env.port, fetch: app.fetch, idleTimeout: 60 })

console.log(`obelisk: ingesting + embedding, api on :${env.port}`)
