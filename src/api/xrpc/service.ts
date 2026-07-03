import type { ObeliskConfig } from '../../config'
import type { ConstellationClient } from '../../constellation/client'
import type { Db } from '../../db/client'
import type { LexiconRegistry } from '../../lexicon/registry'
import { queryEvents } from '../routes/events'
import { getRecordLinks, queryBacklinks, queryNetworkBacklinks } from '../routes/links'
import { getTypeDetail, getTypeInventory } from '../routes/types'
import { xrpcError, type XrpcContext } from './respond'

/** Reserved authority for Obelisk's own service-plane methods (domain dept.social). */
export const SERVICE_NS = 'social.dept.obelisk'

export interface ServiceDeps {
  db: Db
  config: ObeliskConfig
  constellation: ConstellationClient
  lexicons: LexiconRegistry
}

/**
 * Service plane: /xrpc/social.dept.obelisk.{verb} — Obelisk's operations that
 * span collections or concern the archive itself (events, type inventory, the
 * link graph). Keyed by uri/params, not by a collection in the method name.
 * Read-only; unknown verbs return MethodNotImplemented.
 */
export function handleServiceMethod(verb: string, c: XrpcContext, deps: ServiceDeps) {
  switch (verb) {
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
    default:
      return xrpcError(c, 501, 'MethodNotImplemented', `unknown ${SERVICE_NS} method: ${verb || '(none)'}`)
  }
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
