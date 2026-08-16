/**
 * Trim the delivered tail of the event log. The log had no retention, so it
 * grows for the life of the archive.
 *
 * Dry run by default — this deletes history, so it never runs unprompted:
 *
 *   bun run scripts/prune-events.ts --days=7
 *   bun run scripts/prune-events.ts --days=7 --execute
 *
 * Only events every webhook subscription has already been delivered past AND
 * that are older than --days are removed. Pull consumers keep their cursors in
 * their own database and are invisible here, so --days is what protects them:
 * set it comfortably longer than any consumer could plausibly be offline.
 */
import { loadEnv } from '../src/config'
import { createDb } from '../src/db/client'
import { pruneEvents } from '../src/db/retention'

const args = new Set(process.argv.slice(2))
const execute = args.has('--execute')
const daysArg = [...args].find((a) => a.startsWith('--days='))
const retentionDays = Number(daysArg?.split('=')[1] ?? 7)

if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
  console.error(`--days must be a positive number, got: ${daysArg ?? '(unset)'}`)
  process.exit(1)
}

const env = loadEnv()
const { db, client } = createDb(env.databaseUrl)

const result = await pruneEvents(db, { retentionDays, dryRun: !execute })

console.log('')
console.log(`retention        : ${retentionDays} days`)
console.log(`slowest consumer : ${result.heldBy ? `${result.heldBy.name} @ cursor ${result.heldBy.cursor}` : 'none'}`)
console.log(`highest id safe  : ${result.cutoffId ?? '(none)'}`)
console.log(`eligible rows    : ${result.eligible}`)

if (execute) {
  console.log(`deleted          : ${result.deleted}`)
  console.log('')
  console.log('Postgres does not return the space to the OS on DELETE. To reclaim it:')
  console.log('  VACUUM (ANALYZE) events;          -- returns space for reuse by this table')
  console.log('  VACUUM FULL events;               -- returns it to the OS, takes an exclusive lock')
} else {
  console.log('')
  console.log('Dry run. Re-run with --execute to delete.')
}

await client.end()
