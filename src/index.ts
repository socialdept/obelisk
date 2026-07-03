import { createApp } from './api/app'
import { loadConfig, loadEnv } from './config'
import { createDb } from './db/client'
import { migrate } from './db/migrate'
import { OllamaClient } from './embed/ollama'
import { EmbedWorker } from './embed/worker'
import { Ingester } from './ingest/ingester'
import { LexiconRegistry } from './lexicon/registry'
import { createTextKeysResolver } from './lexicon/textkeys'
import { WebhookWorker } from './webhooks/worker'

const env = loadEnv()
const config = await loadConfig()

await migrate(env.databaseUrl)

const { db, client } = createDb(env.databaseUrl)
const ollama = new OllamaClient(env.ollamaUrl, config.ollama.model)
const lexicons = new LexiconRegistry(db)
const ingester = new Ingester(db, config)
const embedWorker = new EmbedWorker(db, config, ollama, { textKeys: createTextKeysResolver(lexicons) })
const webhookWorker = new WebhookWorker(db, config)

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

const app = createApp({ db, config, ollama, lexicons, devMode: env.devMode })
const server = Bun.serve({ port: env.port, fetch: app.fetch, idleTimeout: 60 })

console.log(`reservoir: ingesting + embedding, api on :${env.port}`)
