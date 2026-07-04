import { sql, type SQL } from 'drizzle-orm'
import { records } from '../db/schema'
import { jsonPath } from '../api/xrpc/where'
import type { LinkSpec, RankingProfile, RankingSignal } from './config'

/** Inputs the compiler can't know on its own — supplied per query. */
export interface RankingContext {
  /**
   * The relevance value expression (e.g. `ts_rank(...)` or a fused rank). Omit
   * for a query with no `q` — the relevance term then contributes 0, so the same
   * profile ranks a chrono-less feed and a search box alike.
   */
  relevance?: SQL
  /** Tiebreaker + cursor column. Defaults to `records.id`. */
  idColumn?: SQL
  /**
   * The "now" anchor for recency decay. Defaults to SQL `now()`. Pass a fixed
   * timestamp (and carry it in the cursor) so a row's score is identical across
   * pages — otherwise a live clock drifts scores and the keyset repeats/skips the
   * boundary row.
   */
  now?: SQL
  /**
   * Inbound interaction count for a set of link specs. Defaults to `0` until the
   * rollup/resolver lands (LAB-39/40) — profiles with an `interactions` signal
   * validate and compile now; the term is just 0.
   */
  interactionCount?: (links: LinkSpec[]) => SQL
}

export interface CompiledRanking {
  /** The score expression: `Σ weightᵢ · transformᵢ(signalᵢ)`. */
  score: SQL
  /** `score DESC, id DESC` — repeats the score expr (safe in any position). */
  orderBy: SQL
  /** The id column used for the tiebreak/cursor. */
  idColumn: SQL
}

const LN2 = 0.6931471805599453

/**
 * Compile a ranking profile to a single score expression (locked: linear sum).
 * `score = Σ weightᵢ · transformᵢ(signalᵢ)`.
 */
export function compileRanking(profile: RankingProfile, ctx: RankingContext = {}): CompiledRanking {
  const idColumn = ctx.idColumn ?? sql`${records.id}`
  const interactionCount = ctx.interactionCount ?? (() => sql`0`)

  const now = ctx.now ?? sql`now()`

  const terms: SQL[] = []
  for (const signal of profile.signals) {
    const term = signalExpr(signal, ctx, now, interactionCount)
    if (term) terms.push(sql`(${lit(signal.weight)} * ${term})`)
  }

  // A constant score in ORDER BY (e.g. no active terms → `0`) is read as a column
  // ordinal by Postgres. Cast guards against that; drop it entirely when empty so
  // ordering falls to the id tiebreak.
  const score = terms.length ? sql.join(terms, sql` + `) : sql`0`
  const orderBy = terms.length
    ? sql`(${score})::double precision DESC, ${idColumn} DESC`
    : sql`${idColumn} DESC`
  return { score, orderBy, idColumn }
}

function signalExpr(
  signal: RankingSignal,
  ctx: RankingContext,
  now: SQL,
  interactionCount: (links: LinkSpec[]) => SQL,
): SQL | null {
  if (signal.kind === 'relevance') {
    // No query → no relevance term (contributes 0), so feed-style ranking works.
    if (!ctx.relevance) return null
    return sql`(${ctx.relevance})`
  }

  if (signal.kind === 'recency') {
    const col = timeColumn(signal.field)
    // exp half-life decay: 1.0 at age 0, 0.5 at one half-life, → 0 as it ages.
    // Clamp the exponent so ancient/future rows can't under/overflow double (they
    // just saturate at ~0 / a large finite, ties then broken by id).
    const exponent = sql`greatest(-700, least(700, ${lit(-LN2)} * extract(epoch from (${now} - ${col})) / 3600.0 / ${lit(signal.halfLifeHours)}))`
    return sql`exp(${exponent})`
  }

  // interactions
  return applyTransform(signal, interactionCount(signal.links))
}

/** A timestamp column for the recency decay: `indexedAt` or a record JSON path. */
function timeColumn(field: string): SQL {
  if (field === 'indexedAt') return sql`${records.indexedAt}`
  const path = field.startsWith('record.') ? field.slice('record.'.length) : field
  return sql`(${jsonPath(path)})::timestamptz`
}

function applyTransform(
  signal: Extract<RankingSignal, { kind: 'interactions' }>,
  x: SQL,
): SQL {
  switch (signal.transform) {
    case 'log1p':
      return sql`ln(1 + (${x}))`
    case 'clamp': {
      let expr = x
      if (signal.min !== undefined) expr = sql`greatest(${lit(signal.min)}, ${expr})`
      if (signal.max !== undefined) expr = sql`least(${lit(signal.max)}, ${expr})`
      return sql`(${expr})`
    }
    default:
      return sql`(${x})`
  }
}

/**
 * Embed a trusted, finite number as a SQL literal (not a bound param). Config
 * weights/half-lives are validated finite at boot; inlining them avoids Postgres
 * `unknown`-type param ambiguity (e.g. unary `-$1`) in the score arithmetic.
 */
function lit(n: number): SQL {
  if (!Number.isFinite(n)) throw new Error(`ranking: non-finite numeric ${n}`)
  return sql.raw(String(n))
}

export interface RankingCursor {
  score: number
  id: number
  /** The `now` anchor (epoch ms) — reused on the next page so scores don't drift. */
  anchorMs: number
}

/** Opaque `(score, id, anchor)` cursor — base64 of `<score>|<id>|<anchorMs>`. */
export function encodeRankingCursor(cursor: RankingCursor): string {
  return Buffer.from(`${cursor.score}|${cursor.id}|${cursor.anchorMs}`).toString('base64url')
}

export function decodeRankingCursor(raw: string): RankingCursor | { error: string } {
  const parts = Buffer.from(raw, 'base64url').toString('utf8').split('|')
  if (parts.length !== 3) return { error: 'invalid cursor' }
  const score = Number(parts[0])
  const id = Number(parts[1])
  const anchorMs = Number(parts[2])
  if (Number.isNaN(score) || !Number.isInteger(id) || !Number.isInteger(anchorMs)) {
    return { error: 'invalid cursor' }
  }
  return { score, id, anchorMs }
}

/**
 * Keyset predicate for the next page of a `score DESC, id DESC` ordering:
 * `score < s OR (score = s AND id < i)`. Repeats the score expression because a
 * SELECT alias isn't visible in WHERE. The caller must compile `score` with the
 * cursor's anchor (`now`) so `s` still matches the boundary row exactly.
 */
export function rankingCursorFilter(score: SQL, idColumn: SQL, s: number, id: number): SQL {
  return sql`((${score}) < ${s} OR ((${score}) = ${s} AND ${idColumn} < ${id}))`
}
