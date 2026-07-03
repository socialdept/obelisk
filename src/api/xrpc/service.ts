import type { ObeliskConfig } from '../../config'
import type { ConstellationClient } from '../../constellation/client'
import type { Db } from '../../db/client'
import type { LexiconRegistry } from '../../lexicon/registry'
import { TabAdmin } from '../../ingest/tab-admin'
import type { FetchFn } from '../../webhooks/worker'
import {
  audienceMembers,
  checkMember,
  createAudience,
  deleteAudience,
  getAudience,
  listAudiences,
  updateAudience,
} from '../../audiences/manage'
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listWebhooks,
  testWebhook,
  updateWebhook,
  type ManageResult,
} from '../../webhooks/manage'
import { backfillStatus } from '../backfill'
import { backfillEvents, queryEvents } from '../routes/events'
import { getRecordLinks, queryBacklinks, queryNetworkBacklinks } from '../routes/links'
import { getTypeDetail, getTypeInventory } from '../routes/types'
import {
  addWatched,
  getWatched,
  listWatched,
  queryFootprint,
  removeWatched,
  updateWatched,
} from '../routes/watched'
import { xrpcError, type XrpcContext } from './respond'

/** Reserved authority for Obelisk's own service-plane methods (domain dept.social). */
export const SERVICE_NS = 'social.dept.obelisk'

export interface ServiceDeps {
  db: Db
  config: ObeliskConfig
  constellation: ConstellationClient
  lexicons: LexiconRegistry
  tab: TabAdmin
  /** Injectable for testWebhook delivery; defaults to global fetch. */
  fetchFn?: FetchFn
}

/**
 * Service plane: /xrpc/social.dept.obelisk.{verb} — Obelisk's operations that
 * span collections or concern the archive itself. Two verb kinds:
 *
 *   • queries    (GET)  — reads: events, type inventory, link graph, footprint,
 *                         and management list/get.
 *   • procedures (POST) — mutations against Obelisk's OWN Postgres (webhooks,
 *                         audiences, watched DIDs, event backfill). This never
 *                         writes to a PDS — hard-boundary #2 is intact.
 *
 * Unknown verbs return MethodNotImplemented; the PDS write ban keeps the
 * collection plane's createRecord/etc unimplemented.
 */
export function handleServiceMethod(verb: string, c: XrpcContext, deps: ServiceDeps) {
  switch (verb) {
    // ── queries ──────────────────────────────────────────────
    case 'getEvents':
      return getEvents(c, deps)
    case 'getTypes':
      return getTypes(c, deps)
    case 'getType':
      return getType(c, deps)
    case 'getLinks':
      return getLinks(c, deps)
    case 'getBacklinks':
      return getBacklinks(c, deps)
    case 'getNetworkBacklinks':
      return getNetworkBacklinks(c, deps)
    case 'getFootprint':
      return getFootprint(c, deps)
    case 'getBackfillStatus':
      return getBackfillStatus(c, deps)
    case 'getWebhooks':
      return getWebhooks(c, deps)
    case 'getWebhook':
      return respond(c, getWebhook(deps.db, Number(c.req.query('id'))))
    case 'getAudiences':
      return getAudiences(c, deps)
    case 'getAudience':
      return respond(c, getAudience(deps.db, c.req.query('name')))
    case 'getAudienceMembers':
      return respond(
        c,
        audienceMembers(deps.db, c.req.query('name'), {
          limit: numParam(c.req.query('limit')),
          offset: numParam(c.req.query('offset')),
        }),
      )
    case 'checkAudienceMember':
      return respond(c, checkMember(deps.db, c.req.query('name'), c.req.query('did')))
    case 'getWatchedDids':
      return getWatchedDids(c, deps)
    case 'getWatchedDid':
      return respond(c, getWatched(deps.db, c.req.query('did')))

    // ── procedures ───────────────────────────────────────────
    case 'createWebhook':
      return respondFromBody(c, (body) => createWebhook(deps.db, body))
    case 'updateWebhook':
      return respondFromBody(c, (body) => updateWebhook(deps.db, body))
    case 'deleteWebhook':
      return respondFromBody(c, (body) => deleteWebhook(deps.db, body.id))
    case 'testWebhook':
      return respondFromBody(c, (body) => testWebhook(deps.db, body.id, deps.fetchFn))
    case 'createAudience':
      return respondFromBody(c, (body) => createAudience(deps.db, body))
    case 'updateAudience':
      return respondFromBody(c, (body) => updateAudience(deps.db, body))
    case 'deleteAudience':
      return respondFromBody(c, (body) => deleteAudience(deps.db, body.name))
    case 'addWatchedDid':
      return respondFromBody(c, (body) => addWatched(deps.db, deps.tab, body))
    case 'updateWatchedDid':
      return respondFromBody(c, (body) => updateWatched(deps.db, deps.tab, body))
    case 'removeWatchedDid':
      return respondFromBody(c, (body) => removeWatched(deps.db, deps.tab, body.did))
    case 'backfillEvents':
      return respondFromBody(c, (body) => backfillEvents(deps.db, body))

    default:
      return xrpcError(c, 501, 'MethodNotImplemented', `unknown ${SERVICE_NS} method: ${verb || '(none)'}`)
  }
}

/** Map a ManageResult to an atproto-shaped JSON/error response. */
async function respond<T>(c: XrpcContext, result: ManageResult<T> | Promise<ManageResult<T>>) {
  const r = await result
  if ('error' in r) return xrpcError(c, r.status, r.error, r.message)
  return c.json(r.data as Record<string, unknown>)
}

/**
 * Parse the POST body and run a procedure that returns a ManageResult. Body is
 * untyped here (each management fn validates its own required fields) — the
 * adapter only shuttles JSON in and the result out.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function respondFromBody<T>(c: XrpcContext, run: (body: any) => Promise<ManageResult<T>>) {
  const body = (await c.req.json().catch(() => ({}))) ?? {}
  return respond(c, run(body))
}

function numParam(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

async function getEvents(c: XrpcContext, { db, config }: ServiceDeps) {
  const result = await queryEvents(db, config, c.req.query())
  if ('error' in result) return xrpcError(c, 400, 'InvalidRequest', result.error)
  return c.json(result)
}

async function getTypes(c: XrpcContext, { db }: ServiceDeps) {
  const types = await getTypeInventory(db, {
    collection: c.req.query('collection'),
    path: c.req.query('path'),
  })
  return c.json({ types })
}

async function getType(c: XrpcContext, { db, lexicons }: ServiceDeps) {
  const nsid = c.req.query('nsid')
  if (!nsid) return xrpcError(c, 400, 'InvalidRequest', 'nsid parameter is required')
  return c.json(await getTypeDetail(db, lexicons, nsid))
}

async function getLinks(c: XrpcContext, { db }: ServiceDeps) {
  const uri = c.req.query('uri')
  if (!uri) return xrpcError(c, 400, 'InvalidRequest', 'uri parameter is required')

  const links = await getRecordLinks(db, uri)
  if (!links) return xrpcError(c, 404, 'RecordNotFound', `no record at ${uri}`)
  return c.json({ uri, links })
}

async function getBacklinks(c: XrpcContext, { db }: ServiceDeps) {
  const uri = c.req.query('uri')
  if (!uri) return xrpcError(c, 400, 'InvalidRequest', 'uri parameter is required')

  const backlinks = await queryBacklinks(db, uri, {
    collection: c.req.query('collection'),
    path: c.req.query('path'),
  })
  return c.json({ uri, backlinks })
}

async function getNetworkBacklinks(c: XrpcContext, { constellation }: ServiceDeps) {
  const uri = c.req.query('uri')
  if (!uri) return xrpcError(c, 400, 'InvalidRequest', 'uri parameter is required')

  const result = await queryNetworkBacklinks(constellation, uri, {
    collection: c.req.query('collection'),
    path: c.req.query('path'),
    count: c.req.query('count') === '1',
    cursor: c.req.query('cursor'),
  })
  if (!result) return xrpcError(c, 502, 'UpstreamFailure', 'constellation unavailable')
  return c.json({ uri, ...result })
}

async function getFootprint(c: XrpcContext, { db }: ServiceDeps) {
  const did = c.req.query('did')
  if (!did) return xrpcError(c, 400, 'InvalidRequest', 'did parameter is required')

  return c.json(
    await queryFootprint(db, did, {
      includeDeleted: c.req.query('includeDeleted') === '1',
      cursor: c.req.query('cursor'),
      limit: numParam(c.req.query('limit')),
    }),
  )
}

async function getBackfillStatus(c: XrpcContext, { db }: ServiceDeps) {
  const collection = c.req.query('collection')
  const rows = await backfillStatus(db, { collection, windowSeconds: numParam(c.req.query('window')) })
  // Scoped to one collection → the object; otherwise the whole set.
  if (collection) return c.json(rows[0]!)
  return c.json({ collections: rows })
}

async function getWebhooks(c: XrpcContext, { db }: ServiceDeps) {
  return c.json({ webhooks: await listWebhooks(db) })
}

async function getAudiences(c: XrpcContext, { db }: ServiceDeps) {
  return c.json({ audiences: await listAudiences(db) })
}

async function getWatchedDids(c: XrpcContext, { db }: ServiceDeps) {
  return c.json({ watchedDids: await listWatched(db, c.req.query('active') === '1') })
}
