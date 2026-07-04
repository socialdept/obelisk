import { sql } from 'drizzle-orm'
import type { BackfillStatus } from '../api/backfill'
import type { ObeliskConfig } from '../config'
import type { ConstellationClient } from '../constellation/client'
import type { Db } from '../db/client'
import type { LinkSpec } from './config'
import { interactionKind } from './interactions'

/**
 * Interaction source resolution (LAB-40). For each interaction spec's collection,
 * decide whether its counts come from the LOCAL rollup (ingest-maintained) or
 * from CONSTELLATION network backlinks — so ranking stays honest when we only
 * have a partial view of an interaction type.
 *
 * Rule: local when we actively consume the collection AND coverage is met;
 * otherwise constellation. `overrides` force a source regardless.
 */

export type InteractionSource = 'local' | 'constellation'

export interface InteractionSourceConfig {
  /** Coverage bar for `auto` resolution (used once a network denominator exists). */
  threshold?: number
  /** Per-collection force: `local` / `constellation` skip the rule; `auto` applies it. */
  overrides?: Record<string, InteractionSource | 'auto'>
}

const DEFAULT_THRESHOLD = 0.9

/**
 * Is a collection backfilled "enough" to trust local counts? A true network `%`
 * needs `reposTotal`, which no atproto service exposes today (always null — see
 * backfill.ts), so we fall back to the drain-based `complete` flag. When a
 * denominator lands, the `threshold` comparison takes over with no call-site change.
 */
export function coverageMet(status: BackfillStatus | undefined, threshold: number): boolean {
  if (!status) return false
  if (status.reposTotal != null && status.reposTotal > 0) {
    return status.reposCaughtUp / status.reposTotal >= threshold
  }
  return status.complete
}

export function resolveInteractionSource(
  config: ObeliskConfig,
  collection: string,
  status: BackfillStatus | undefined,
): InteractionSource {
  const override = config.interactionSources?.overrides?.[collection]
  if (override === 'local' || override === 'constellation') return override

  // `auto` (or unset) → apply the rule.
  if (!(collection in config.collections)) return 'constellation'
  const threshold = config.interactionSources?.threshold ?? DEFAULT_THRESHOLD
  return coverageMet(status, threshold) ? 'local' : 'constellation'
}

export interface SpecSource {
  spec: LinkSpec
  source: InteractionSource
}

/**
 * Resolve every spec in a profile independently — a profile mixing a
 * well-backfilled (local) collection with a non-consumed (constellation) one is
 * normal. `statusByCollection` is the per-collection backfill status.
 */
export function planInteractionSources(
  config: ObeliskConfig,
  links: LinkSpec[],
  statusByCollection: Map<string, BackfillStatus>,
): SpecSource[] {
  return links.map((spec) => ({
    spec,
    source: resolveInteractionSource(config, spec.collection, statusByCollection.get(spec.collection)),
  }))
}

/**
 * Fetch a target's network-backlink count for a constellation-resolved spec and
 * write it into `interaction_counts` (authoritative SET, not increment). Reuses
 * the cached Constellation client — no uncached hammering. Returns the count.
 */
export async function syncConstellationCount(
  db: Db,
  client: ConstellationClient,
  spec: LinkSpec,
  targetUri: string,
): Promise<number> {
  // Constellation expects a leading-dot dotted path (e.g. `.subject.uri`).
  const path = spec.path.startsWith('.') ? spec.path : `.${spec.path}`
  const result = await client.query('links/count', { target: targetUri, collection: spec.collection, path })
  const count = Number((result.data as { count?: number })?.count ?? 0)

  const kind = interactionKind(spec.collection, spec.path)
  await db.execute(sql`
    INSERT INTO interaction_counts (target_uri, kind, count)
    VALUES (${targetUri}, ${kind}, ${count})
    ON CONFLICT (target_uri, kind) DO UPDATE SET count = ${count}
  `)
  return count
}
