import { resolveTxt } from 'node:dns/promises'

export interface ResolverDeps {
  lookupTxt: (hostname: string) => Promise<string[][]>
  fetchJson: (url: string) => Promise<unknown>
}

const defaultDeps: ResolverDeps = {
  lookupTxt: resolveTxt,
  fetchJson: async (url) => {
    const response = await fetch(url, { headers: { 'User-Agent': 'obelisk (miguel)' } })
    if (!response.ok) throw new Error(`${url} → ${response.status}`)
    return response.json()
  },
}

/**
 * Resolve an NSID (e.g. blog.pckt.content) to its published lexicon schema:
 * 1. authority = reversed domain segments (pckt.blog)
 * 2. _lexicon.<authority> DNS TXT → did=<did>
 * 3. DID document → PDS endpoint
 * 4. com.atproto.repo.getRecord(repo=did, collection=com.atproto.lexicon.schema, rkey=nsid)
 */
export async function resolveLexicon(nsid: string, deps: ResolverDeps = defaultDeps): Promise<unknown> {
  const authority = nsidAuthority(nsid)
  const did = await resolveAuthorityDid(authority, deps)
  const pds = await resolvePds(did, deps)

  const url = new URL('/xrpc/com.atproto.repo.getRecord', pds)
  url.searchParams.set('repo', did)
  url.searchParams.set('collection', 'com.atproto.lexicon.schema')
  url.searchParams.set('rkey', nsid)

  const response = (await deps.fetchJson(url.toString())) as { value?: unknown }
  if (!response.value) throw new Error(`no lexicon record for ${nsid} in ${did}`)
  return response.value
}

export function nsidAuthority(nsid: string): string {
  const segments = nsid.split('.')
  if (segments.length < 3) throw new Error(`invalid NSID: ${nsid}`)
  return segments.slice(0, -1).reverse().join('.')
}

async function resolveAuthorityDid(authority: string, deps: ResolverDeps): Promise<string> {
  const answers = await deps.lookupTxt(`_lexicon.${authority}`).catch(() => [] as string[][])
  for (const answer of answers) {
    const joined = answer.join('')
    if (joined.startsWith('did=')) return joined.slice('did='.length)
  }
  throw new Error(`no _lexicon TXT record for ${authority}`)
}

async function resolvePds(did: string, deps: ResolverDeps): Promise<string> {
  const doc = (await deps.fetchJson(didDocUrl(did))) as {
    service?: { id: string; type: string; serviceEndpoint: string }[]
  }
  const pds = doc.service?.find((s) => s.type === 'AtprotoPersonalDataServer')
  if (!pds) throw new Error(`no PDS in DID document for ${did}`)
  return pds.serviceEndpoint
}

function didDocUrl(did: string): string {
  if (did.startsWith('did:plc:')) return `https://plc.directory/${did}`
  if (did.startsWith('did:web:')) return `https://${did.slice('did:web:'.length)}/.well-known/did.json`
  throw new Error(`unsupported DID method: ${did}`)
}
