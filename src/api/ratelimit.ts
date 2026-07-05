import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { getConnInfo } from 'hono/bun'
import { xrpcError } from './xrpc/respond'

/**
 * Abuse guards for the XRPC surface (LAB-52). In-memory, single-process — which
 * matches Obelisk's single-unit boundary (counters reset on restart and don't
 * span instances; we run one instance, so that's fine). Every limit defaults to
 * disabled (0 / Infinity) so the API is unthrottled unless the deployment sets
 * the knobs — tests and local dev stay unlimited; production passes real values.
 */

/** Fixed-window request counter + live-tail concurrency tracker. */
export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>()
  private sse = new Map<string, number>()

  /** Count one request against `key`; false (with a Retry-After) when over `limit`. */
  hit(key: string, limit: number, windowMs = 60_000): { ok: boolean; retryAfter: number } {
    const now = Date.now()
    const w = this.windows.get(key)
    if (!w || now >= w.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs })
      this.sweep(now)
      return { ok: true, retryAfter: 0 }
    }
    if (w.count >= limit) return { ok: false, retryAfter: Math.ceil((w.resetAt - now) / 1000) }
    w.count += 1
    return { ok: true, retryAfter: 0 }
  }

  /** Reserve a concurrent SSE slot for `key`; false when already at `max`. */
  acquireSse(key: string, max: number): boolean {
    const n = this.sse.get(key) ?? 0
    if (n >= max) return false
    this.sse.set(key, n + 1)
    return true
  }

  releaseSse(key: string): void {
    const n = (this.sse.get(key) ?? 1) - 1
    if (n <= 0) this.sse.delete(key)
    else this.sse.set(key, n)
  }

  /** Drop expired windows only when the map grows large — cheap amortized GC. */
  private sweep(now: number): void {
    if (this.windows.size < 10_000) return
    for (const [k, w] of this.windows) if (now >= w.resetAt) this.windows.delete(k)
  }
}

/** Shared live-tail concurrency guard, threaded to the SSE handler. */
export interface SseGuard {
  limiter: RateLimiter
  max: number
}

export interface Limits {
  /** Requests/min per identity for ordinary methods. 0 = unlimited. */
  rateLimitPerMin: number
  /** Requests/min for expensive methods (search/aggregate/footprint/feed/network). 0 = unlimited. */
  rateLimitExpensivePerMin: number
  /** Max request body in bytes (Content-Length). 0 = unlimited. */
  maxBodyBytes: number
  /** Per-request deadline in ms (SSE exempt). 0 = no deadline. */
  requestTimeoutMs: number
  /** Max concurrent live-tail (subscribeEvents) connections per identity. */
  maxSseConnections: number
}

export const UNLIMITED: Limits = {
  rateLimitPerMin: 0,
  rateLimitExpensivePerMin: 0,
  maxBodyBytes: 0,
  requestTimeoutMs: 0,
  maxSseConnections: Number.MAX_SAFE_INTEGER,
}

/** Method suffixes whose queries are DB-heavy — a tighter bucket than the default. */
const EXPENSIVE = ['.searchRecords', '.aggregate', '.getFootprint', '.getRankedFeed', '.getNetworkBacklinks']
const SSE_SUFFIX = '.subscribeEvents'

/** Best-effort client identity: real IP behind the proxy, else the socket peer. */
function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Rate-limit key: the authenticated token when present, else the client IP. */
export function rateKeyFor(c: Context): string {
  const tokenId = c.get('tokenId')
  return tokenId !== undefined ? `t:${tokenId}` : `ip:${clientIp(c)}`
}

/** Reject over-size request bodies (413) by Content-Length, before parsing. */
export function bodyLimit(maxBytes: number) {
  return createMiddleware(async (c, next) => {
    if (maxBytes > 0 && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const len = Number(c.req.header('content-length') ?? '0')
      if (Number.isFinite(len) && len > maxBytes) {
        return xrpcError(c, 413, 'PayloadTooLarge', `request body exceeds ${maxBytes} bytes`)
      }
    }
    return next()
  })
}

/** Per-identity fixed-window rate limit; the live tail is exempt (see SSE cap). */
export function rateLimit(limiter: RateLimiter, limits: Limits) {
  return createMiddleware(async (c, next) => {
    const path = c.req.path
    if (path.endsWith(SSE_SUFFIX)) return next()

    const expensive = EXPENSIVE.some((s) => path.endsWith(s))
    const limit = expensive ? limits.rateLimitExpensivePerMin : limits.rateLimitPerMin
    if (limit <= 0) return next()

    const res = limiter.hit(`${expensive ? 'x' : 'd'}:${rateKeyFor(c)}`, limit)
    if (!res.ok) {
      c.header('Retry-After', String(res.retryAfter))
      return xrpcError(c, 429, 'RateLimitExceeded', 'rate limit exceeded, retry after the Retry-After window')
    }
    return next()
  })
}

/**
 * Per-request deadline. The SSE live tail is long-lived by design, so it's
 * exempt. This bounds the HTTP response; the DB statement_timeout (set on the
 * runtime client) is what actually cancels a slow query underneath.
 */
export function requestTimeout(ms: number) {
  return createMiddleware(async (c, next) => {
    if (ms <= 0 || c.req.path.endsWith(SSE_SUFFIX)) return next()

    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<Response>((resolve) => {
      timer = setTimeout(() => resolve(xrpcError(c, 503, 'Timeout', `request exceeded ${ms}ms`)), ms)
    })
    try {
      const timedOut = await Promise.race([next().then(() => undefined), deadline])
      if (timedOut) return timedOut
    } finally {
      clearTimeout(timer)
    }
  })
}
