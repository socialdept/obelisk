import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { BackfillStatus } from '../src/api/backfill'
import type { ObeliskConfig } from '../src/config'
import type { ConstellationClient } from '../src/constellation/client'
import type { Db } from '../src/db/client'
import type { LinkSpec } from '../src/ranking/config'
import {
  coverageMet,
  planInteractionSources,
  resolveInteractionSource,
  syncConstellationCount,
} from '../src/ranking/source'
import { setupTestDb, truncateAll } from './helpers'

/** Minimal config: two consumed collections + interaction source overrides. */
function cfg(interactionSources?: ObeliskConfig['interactionSources']): ObeliskConfig {
  return { collections: { consumed: {} }, interactionSources } as unknown as ObeliskConfig
}

function status(overrides: Partial<BackfillStatus> = {}): BackfillStatus {
  return {
    collection: 'consumed',
    recordsArchived: 0,
    recordsIncludingDeleted: 0,
    reposSeen: 1,
    reposCaughtUp: 0,
    reposTotal: null,
    backfillRatePerSec: 0,
    liveRatePerSec: 0,
    lastHistoricalEventAt: null,
    lastEventAt: null,
    windowSeconds: 60,
    backfilling: false,
    complete: false,
    ...overrides,
  }
}

describe('coverageMet', () => {
  test('no status → not met', () => {
    expect(coverageMet(undefined, 0.9)).toBe(false)
  })

  test('null reposTotal → falls back to the drain (complete) flag', () => {
    expect(coverageMet(status({ complete: true }), 0.9)).toBe(true)
    expect(coverageMet(status({ complete: false }), 0.9)).toBe(false)
  })

  test('with a network denominator → ratio vs threshold', () => {
    expect(coverageMet(status({ reposTotal: 100, reposCaughtUp: 95 }), 0.9)).toBe(true)
    expect(coverageMet(status({ reposTotal: 100, reposCaughtUp: 80 }), 0.9)).toBe(false)
  })
})

describe('resolveInteractionSource', () => {
  test('override local/constellation forces regardless of coverage', () => {
    expect(resolveInteractionSource(cfg({ overrides: { consumed: 'constellation' } }), 'consumed', status({ complete: true }))).toBe(
      'constellation',
    )
    expect(resolveInteractionSource(cfg({ overrides: { notconsumed: 'local' } }), 'notconsumed', undefined)).toBe('local')
  })

  test('not consumed → constellation', () => {
    expect(resolveInteractionSource(cfg(), 'app.bsky.feed.like', undefined)).toBe('constellation')
  })

  test('consumed + backfilled (complete) → local', () => {
    expect(resolveInteractionSource(cfg(), 'consumed', status({ complete: true }))).toBe('local')
  })

  test('consumed + not backfilled → constellation', () => {
    expect(resolveInteractionSource(cfg(), 'consumed', status({ complete: false }))).toBe('constellation')
    expect(resolveInteractionSource(cfg(), 'consumed', undefined)).toBe('constellation')
  })

  test('override "auto" applies the rule', () => {
    expect(resolveInteractionSource(cfg({ overrides: { consumed: 'auto' } }), 'consumed', status({ complete: true }))).toBe('local')
  })
})

describe('planInteractionSources', () => {
  test('resolves each spec in a mixed profile independently', () => {
    const links: LinkSpec[] = [
      { collection: 'consumed', path: 'x', weight: 1 },
      { collection: 'app.bsky.feed.like', path: 'subject.uri', weight: 1 },
    ]
    const statuses = new Map([['consumed', status({ complete: true })]])
    const plan = planInteractionSources(cfg(), links, statuses)
    expect(plan.map((p) => p.source)).toEqual(['local', 'constellation'])
  })
})

describe('syncConstellationCount', () => {
  let db: Db
  let teardown: () => Promise<void>

  beforeAll(async () => {
    const setup = await setupTestDb()
    db = setup.db
    teardown = setup.teardown
  })
  afterAll(() => teardown())
  beforeEach(() => truncateAll(db))

  /** A stubbed cached client returning a fixed count. */
  function stubClient(count: number): ConstellationClient {
    return {
      query: async () => ({ data: { count }, cached: false, stale: false, fetchedAt: new Date() }),
    } as unknown as ConstellationClient
  }

  const spec: LinkSpec = { collection: 'app.bsky.feed.like', path: 'subject.uri', weight: 1 }
  const TARGET = 'at://did:plc:x/app.bsky.feed.post/1'

  async function count(): Promise<number | undefined> {
    const rows = await db.execute<{ count: string }>(
      sql`SELECT count FROM interaction_counts WHERE target_uri = ${TARGET} AND kind = 'app.bsky.feed.like:subject.uri'`,
    )
    return rows[0] ? Number(rows[0].count) : undefined
  }

  test('fetches and writes the network count (SET, authoritative)', async () => {
    const n = await syncConstellationCount(db, stubClient(42), spec, TARGET)
    expect(n).toBe(42)
    expect(await count()).toBe(42)

    // Re-sync overwrites (SET), not increments.
    await syncConstellationCount(db, stubClient(40), spec, TARGET)
    expect(await count()).toBe(40)
  })
})
