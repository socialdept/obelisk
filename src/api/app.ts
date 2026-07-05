import { Hono } from 'hono'
import type { ObeliskConfig } from '../config'
import { ConstellationClient } from '../constellation/client'
import type { Db } from '../db/client'
import { metricsText, readyReport, type HealthProviders } from '../health'
import type { EmbeddingProvider } from '../embed/provider'
import { Blocklist } from '../ingest/blocklist'
import { PdsBlocklist } from '../ingest/pds-blocklist'
import { TabAdmin } from '../ingest/tab-admin'
import { LexiconRegistry } from '../lexicon/registry'
import type { FetchFn } from '../webhooks/worker'
import { bearerAuth } from './auth'
import { bodyLimit, rateLimit, RateLimiter, requestTimeout, UNLIMITED, type Limits } from './ratelimit'
import { xrpcRoutes } from './xrpc/collections'

export interface ApiDeps {
  db: Db
  config: ObeliskConfig
  /** Embedding backend (LAB-9): Ollama or OpenAI. Field name kept for continuity. */
  ollama: EmbeddingProvider
  constellation?: ConstellationClient
  lexicons?: LexiconRegistry
  /** Footprint-Tab enrollment client. Defaults to unconfigured (no-op) — see TabAdmin. */
  tabAdmin?: TabAdmin
  /** Injectable for the testWebhook procedure's delivery; defaults to global fetch. */
  fetchFn?: FetchFn
  /** Shared DID deny-list (LAB-47). Defaults to an empty in-memory list. */
  blocklist?: Blocklist
  /** Shared PDS deny-list (LAB-48). Defaults to an empty in-memory list. */
  pdsBlocklist?: PdsBlocklist
  /** Abuse guards (LAB-52). Defaults to UNLIMITED (off) — production passes real values. */
  limits?: Limits
  /** Live component snapshots for /readyz + /metrics (LAB-54). */
  health?: HealthProviders
  /** Disables API authentication entirely. Local development only. */
  devMode?: boolean
}

/**
 * The entire HTTP surface is atproto-shaped XRPC — there is no REST plane.
 *
 *   • /xrpc/{collection}.{verb}          — collection plane (queried records)
 *   • /xrpc/social.dept.obelisk.{verb}   — service plane (queries + procedures)
 *
 * Bearer-authed unless devMode.
 */
export function createApp({ db, config, ollama, constellation, lexicons, tabAdmin, fetchFn, blocklist, pdsBlocklist, limits, health, devMode }: ApiDeps): Hono {
  const app = new Hono()

  // Liveness — cheap, unauthenticated, no dependency checks: is the process up?
  app.get('/health', (c) => c.json({ ok: true }))
  app.get('/healthz', (c) => c.json({ ok: true }))

  // Readiness — dependency checks (DB + workers + Ollama). 200 when serving
  // (degraded still counts), 503 only when a critical dependency is down.
  app.get('/readyz', async (c) => {
    const report = await readyReport(db, health ?? {})
    return c.json(report, report.ok ? 200 : 503)
  })

  // Prometheus metrics — behind auth (unless devMode); probes above stay open.
  if (!devMode) app.use('/metrics', bearerAuth(db))
  app.get('/metrics', async (c) => {
    const report = await readyReport(db, health ?? {})
    return c.text(metricsText(report), 200, { 'Content-Type': 'text/plain; version=0.0.4' })
  })

  const constellationClient = constellation ?? new ConstellationClient(db, config.constellation)
  const lexiconRegistry = lexicons ?? new LexiconRegistry(db)
  const tab = tabAdmin ?? new TabAdmin(undefined)
  const denyList = blocklist ?? new Blocklist()
  const pdsDenyList = pdsBlocklist ?? new PdsBlocklist(db)
  const lim = limits ?? UNLIMITED
  const limiter = new RateLimiter()

  const xrpc = new Hono()
  // Middleware order: reject over-size bodies first (cheap), then authenticate
  // (sets tokenId), then rate-limit (keys on tokenId), then apply the deadline.
  xrpc.use('*', bodyLimit(lim.maxBodyBytes))
  if (devMode) {
    console.warn('⚠️  OBELISK_DEV_MODE — API authentication is DISABLED')
  } else {
    xrpc.use('*', bearerAuth(db))
  }
  xrpc.use('*', rateLimit(limiter, lim))
  xrpc.use('*', requestTimeout(lim.requestTimeoutMs))
  xrpc.route(
    '/',
    xrpcRoutes({
      db,
      ollama,
      config,
      constellation: constellationClient,
      lexicons: lexiconRegistry,
      tab,
      fetchFn,
      blocklist: denyList,
      pdsBlocklist: pdsDenyList,
      sse: { limiter, max: lim.maxSseConnections },
    }),
  )
  app.route('/xrpc', xrpc)

  return app
}
