import { loadConfig, loadEnv } from '../src/config'
import { createDb } from '../src/db/client'
import { backfillRepo, collectionFilter } from '../src/ingest/backfill'
import { ColdList, ColdPdsList } from '../src/ingest/cold'

/**
 * One-shot repo import for a DID — recover records the live sync missed (e.g.
 * what a blocklist dropped). Idempotent: re-running is safe.
 *
 *   bun run scripts/backfill-repo.ts <did>          # only the configured collections
 *   bun run scripts/backfill-repo.ts <did> --all    # every collection in the repo
 *
 * Scoped to `config.collectionFilters` by default so it doesn't drag in a repo's
 * unrelated collections. Cold-aware: a cold DID/PDS's records land unembedded.
 * Records land `embed_status='pending'` (or `skipped` if cold); the running app's
 * embed worker fills embeddings for the ones with prose.
 */
const did = process.argv[2]
const all = process.argv.includes('--all')
if (!did || !did.startsWith('did:')) {
  console.error('usage: bun run scripts/backfill-repo.ts <did> [--all]')
  process.exit(1)
}

const env = loadEnv()
const config = await loadConfig()
const { db, client } = createDb(env.databaseUrl)

// Reproduce the live ingester's cold decision for this DID.
const coldList = new ColdList()
await coldList.load(db)
const coldPdsList = new ColdPdsList(db)
await coldPdsList.loadPatterns()
await coldPdsList.ensureDecided([did])

console.log(`backfilling ${did} ${all ? '(all collections)' : '(configured collections)'} …`)
const started = Bun.nanoseconds()
const result = await backfillRepo(db, config, did, {
  ...(all ? {} : { collections: collectionFilter(config) }),
  applyOptions: { coldDid: (d) => coldList.has(d) || coldPdsList.isCold(d) },
  onProgress: (done, applied) => process.stdout.write(`\r  ${done} kept, ${applied} applied`),
})
const seconds = ((Bun.nanoseconds() - started) / 1e9).toFixed(1)

const collections = Object.entries(result.byCollection).sort((a, b) => b[1] - a[1])
console.log(
  `\n\nrev ${result.rev} — ${result.applied} applied, ${result.skipped} skipped, ${result.filtered} filtered out (${seconds}s)`,
)
console.log(`${collections.length} collections:`)
for (const [collection, count] of collections) console.log(`  ${String(count).padStart(7)}  ${collection}`)

await client.end()
