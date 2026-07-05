/**
 * Ranking profiles (LAB-37). A profile is a named list of signals; the compiler
 * (./compile) turns it into one `ORDER BY` expression. Lives outside src/config
 * so both the config validator and the compiler import the types without a cycle.
 *
 *   rankings: {
 *     'bsky-hot': { signals: [
 *       { kind: 'relevance', weight: 1 },
 *       { kind: 'interactions', weight: 2, transform: 'log1p', links: [
 *         { collection: 'app.bsky.feed.like', path: 'subject.uri', weight: 1 } ] },
 *       { kind: 'recency', weight: 1.5, field: 'indexedAt', halfLifeHours: 6 },
 *     ] },
 *   }
 */

export type RankingTransform = 'log1p' | 'clamp' | 'identity'

/** What counts as an inbound interaction: records of `collection` whose `path` points at the row. */
export interface LinkSpec {
  collection: string
  path: string
  weight: number
}

export type RankingSignal =
  | { kind: 'relevance'; weight: number }
  | {
      kind: 'interactions'
      weight: number
      links: LinkSpec[]
      transform?: RankingTransform
      /** clamp bounds (only used by transform: 'clamp'). */
      min?: number
      max?: number
    }
  | {
      kind: 'recency'
      weight: number
      /** `indexedAt`, or a `record.<path>` / bare record path to a timestamp. */
      field: string
      halfLifeHours: number
    }

export interface RankingProfile {
  signals: RankingSignal[]
}

export type RankingConfig = Record<string, RankingProfile>

const TRANSFORMS = new Set<RankingTransform>(['log1p', 'clamp', 'identity'])

/**
 * Validate ranking profiles at boot — a malformed profile should fail loudly on
 * startup, not silently produce garbage `ORDER BY` at query time. Throws on the
 * first problem with a message naming the profile + signal.
 */
export function validateRankings(rankings: RankingConfig | undefined): void {
  if (!rankings) return

  for (const [name, profile] of Object.entries(rankings)) {
    if (!Array.isArray(profile.signals) || profile.signals.length === 0) {
      throw new Error(`ranking "${name}" must have a non-empty signals array`)
    }

    for (const signal of profile.signals) {
      const where = `ranking "${name}" signal "${signal.kind}"`
      if (typeof signal.weight !== 'number' || !Number.isFinite(signal.weight)) {
        throw new Error(`${where}: weight must be a finite number`)
      }

      if (signal.kind === 'relevance') continue

      if (signal.kind === 'interactions') {
        if (!Array.isArray(signal.links) || signal.links.length === 0) {
          throw new Error(`${where}: interactions requires a non-empty links array`)
        }
        for (const link of signal.links) {
          if (!link.collection || !link.path || typeof link.weight !== 'number') {
            throw new Error(`${where}: each link needs collection, path, and a numeric weight`)
          }
        }
        if (signal.transform && !TRANSFORMS.has(signal.transform)) {
          throw new Error(`${where}: unknown transform "${signal.transform}"`)
        }
        continue
      }

      if (signal.kind === 'recency') {
        if (typeof signal.field !== 'string' || !signal.field) {
          throw new Error(`${where}: recency requires a field`)
        }
        if (typeof signal.halfLifeHours !== 'number' || signal.halfLifeHours <= 0) {
          throw new Error(`${where}: recency halfLifeHours must be > 0`)
        }
        continue
      }

      throw new Error(`${where}: unknown signal kind "${(signal as { kind: string }).kind}"`)
    }
  }
}
