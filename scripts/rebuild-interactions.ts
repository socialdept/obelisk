/**
 * Rebuild the interaction-count rollup from record_links (LAB-39). Run after
 * changing ranking interaction specs, or to repair drift. Idempotent.
 *
 *   bun run scripts/rebuild-interactions.ts
 */
import { loadConfig, loadEnv } from '../src/config'
import { createDb } from '../src/db/client'
import { rebuildInteractionCounts } from '../src/ranking/interactions'

const env = loadEnv()
const config = await loadConfig()
const { db, client } = createDb(env.databaseUrl)

const { rows } = await rebuildInteractionCounts(db, config)
console.log(`interaction_counts rebuilt: ${rows} (target_uri, kind) rows`)

await client.end()
