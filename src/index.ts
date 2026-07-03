import { loadConfig, loadEnv } from './config'
import { createDb } from './db/client'
import { migrate } from './db/migrate'
import { Ingester } from './ingest/ingester'

const env = loadEnv()
const config = await loadConfig()

await migrate(env.databaseUrl)

const { db, client } = createDb(env.databaseUrl)
const ingester = new Ingester(db, config)

const shutdown = async () => {
  console.log('shutting down…')
  await ingester.stop()
  await client.end()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

ingester.start(env.tabWsUrl)

console.log('reservoir: ingesting')
