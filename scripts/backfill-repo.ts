import { loadConfig, loadEnv } from '../src/config'
import { createDb } from '../src/db/client'
import { backfillRepo } from '../src/ingest/backfill'

/**
 * One-shot full-repo import for a DID, across every collection — independent of
 * the network sync filter. Idempotent: re-running is safe.
 *
 *   bun run scripts/backfill-repo.ts <did>
 *
 * Records land as `embed_status='pending'`; the running app's embed worker
 * fills embeddings for the ones with prose.
 */
const did = process.argv[2]
if (!did || !did.startsWith('did:')) {
  console.error('usage: bun run scripts/backfill-repo.ts <did>')
  process.exit(1)
}

const env = loadEnv()
const config = await loadConfig()
const { db, client } = createDb(env.databaseUrl)

console.log(`backfilling ${did} …`)
const started = Bun.nanoseconds()
const result = await backfillRepo(db, config, did, {
  onProgress: (done, applied) => process.stdout.write(`\r  ${done} seen, ${applied} applied`),
})
const seconds = ((Bun.nanoseconds() - started) / 1e9).toFixed(1)

const collections = Object.entries(result.byCollection).sort((a, b) => b[1] - a[1])
console.log(`\n\nrev ${result.rev} — ${result.applied} applied, ${result.skipped} skipped of ${result.total} (${seconds}s)`)
console.log(`${collections.length} collections:`)
for (const [collection, count] of collections) console.log(`  ${String(count).padStart(7)}  ${collection}`)

await client.end()
