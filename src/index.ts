import { createApp } from './api/app'
import { loadConfig, loadEnv } from './config'
import { createDb } from './db/client'
import { migrate } from './db/migrate'
import { OllamaClient } from './embed/ollama'
import { EmbedWorker } from './embed/worker'
import { Ingester } from './ingest/ingester'
import { WebhookWorker } from './webhooks/worker'

const env = loadEnv()
const config = await loadConfig()

await migrate(env.databaseUrl)

const { db, client } = createDb(env.databaseUrl)
const ollama = new OllamaClient(env.ollamaUrl, config.ollama.model)
const ingester = new Ingester(db, config)
const embedWorker = new EmbedWorker(db, config, ollama)
const webhookWorker = new WebhookWorker(db)

const shutdown = async () => {
  console.log('shutting down…')
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

const app = createApp({ db, config, ollama, devMode: env.devMode })
Bun.serve({ port: env.port, fetch: app.fetch })

console.log(`reservoir: ingesting + embedding, api on :${env.port}`)
