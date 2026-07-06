import { loadConfig, loadEnv } from '../src/config'
import { createDb } from '../src/db/client'
import { backfillRepo, collectionFilter } from '../src/ingest/backfill'
import { coldDid, ColdList, ColdPdsList } from '../src/ingest/cold'

/**
 * Reindex every repo hosted on a PDS — recover a whole host the live sync missed
 * (e.g. what a PDS blocklist dropped). Enumerates the PDS's repos via
 * `com.atproto.sync.listRepos` (paginated, no relay needed) and runs `backfillRepo`
 * on each, **sequentially** so a 1GB box isn't flooded with concurrent CAR streams.
 *
 *   bun run scripts/backfill-pds.ts https://pds.example.com                     # configured collections
 *   bun run scripts/backfill-pds.ts https://pds.example.com --all               # every collection
 *   bun run scripts/backfill-pds.ts https://pds.example.com --cold              # archive, don't embed
 *   bun run scripts/backfill-pds.ts https://pds.example.com --cold --note "brid.gy standard.site"
 *
 * `--cold` cools each repo as it's archived: records land unembedded, and every DID
 * that actually had records is added to the cold list (with `--note`, if given), so
 * it stays cold. DIDs with no matching records aren't cooled (no useless entries).
 *
 * Scoped to `config.collectionFilters` by default; already cold-aware regardless of
 * the flag. Idempotent per repo (rev-compare), so re-running after an interruption is
 * safe. One failing repo is logged and skipped; the sweep continues.
 */
const pds = process.argv[2]
const all = process.argv.includes('--all')
const setCold = process.argv.includes('--cold')
const noteIdx = process.argv.indexOf('--note')
const note = noteIdx >= 0 ? process.argv[noteIdx + 1] : undefined
if (!pds || !pds.startsWith('http')) {
  console.error('usage: bun run scripts/backfill-pds.ts <https://pds-url> [--all] [--cold] [--note <text>]')
  process.exit(1)
}
if (note !== undefined && !setCold) {
  console.error('--note only applies with --cold')
  process.exit(1)
}

const USER_AGENT = 'obelisk (miguel)'

async function* listRepos(pdsUrl: string): AsyncIterable<string> {
  let cursor: string | undefined
  do {
    const url = new URL(`${pdsUrl.replace(/\/+$/, '')}/xrpc/com.atproto.sync.listRepos`)
    url.searchParams.set('limit', '1000')
    if (cursor) url.searchParams.set('cursor', cursor)
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) throw new Error(`listRepos ${res.status} from ${pdsUrl}`)
    const body = (await res.json()) as { repos?: { did: string; active?: boolean }[]; cursor?: string }
    for (const repo of body.repos ?? []) {
      if (repo.active === false) continue // deactivated/taken-down repos have no fetchable CAR
      yield repo.did
    }
    cursor = body.cursor
  } while (cursor)
}

const env = loadEnv()
const config = await loadConfig()
const { db, client } = createDb(env.databaseUrl)

// Reproduce the live ingester's cold decision for each DID.
const coldList = new ColdList()
await coldList.load(db)
const coldPdsList = new ColdPdsList(db)
await coldPdsList.loadPatterns()

const collections = all ? undefined : collectionFilter(config)
const scope = all ? 'all collections' : 'configured collections'
console.log(`reindexing all repos on ${pds} (${scope}${setCold ? ', cold' : ''}) …\n`)

let repos = 0
let applied = 0
let filtered = 0
let cooled = 0
let failed = 0
const started = Bun.nanoseconds()

for await (const did of listRepos(pds)) {
  repos += 1
  try {
    await coldPdsList.ensureDecided([did])
    const result = await backfillRepo(db, config, did, {
      resolvePds: async () => pds, // all repos are on this PDS — skip per-DID resolution
      ...(collections ? { collections } : {}),
      // --cold forces records to land unembedded; otherwise honor the existing lists.
      applyOptions: { coldDid: setCold ? () => true : (d) => coldList.has(d) || coldPdsList.isCold(d) },
    })
    applied += result.applied
    filtered += result.filtered

    // Persist the DID to the cold list only if it actually contributed records —
    // no point cooling the thousands of repos on a bridge that carry nothing we keep.
    if (setCold && result.applied > 0) {
      await coldDid(db, coldList, { did, note })
      cooled += 1
    }
    console.log(`  [${repos}] ${did} — ${result.applied} applied, ${result.filtered} filtered`)
  } catch (err) {
    failed += 1
    console.error(`  [${repos}] ${did} — FAILED: ${(err as Error).message}`)
  }
}

const seconds = ((Bun.nanoseconds() - started) / 1e9).toFixed(1)
const coldNote = setCold ? `, ${cooled} cooled` : ''
console.log(`\ndone: ${repos} repos, ${applied} applied, ${filtered} filtered${coldNote}, ${failed} failed (${seconds}s)`)

await client.end()
