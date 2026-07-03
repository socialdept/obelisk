import { describe, expect, test } from 'bun:test'
import { deriveTextFields } from '../src/api/routes/types'
import { extractTypes } from '../src/ingest/types'
import { nsidAuthority, resolveLexicon } from '../src/lexicon/resolver'

describe('extractTypes', () => {
  test('collects root and nested $type values with paths', () => {
    const types = extractTypes({
      $type: 'site.standard.document',
      content: { $type: 'app.offprint.content', body: 'x' },
      bskyPostRef: { $type: 'com.atproto.repo.strongRef', uri: 'at://x/y/z' },
    })

    expect(types).toEqual([
      { path: '$type', nsid: 'site.standard.document' },
      { path: 'content.$type', nsid: 'app.offprint.content' },
      { path: 'bskyPostRef.$type', nsid: 'com.atproto.repo.strongRef' },
    ])
  })

  test('walks arrays with [] paths and dedupes', () => {
    const types = extractTypes({
      content: {
        items: [
          { $type: 'blog.pckt.block.text', plaintext: 'a' },
          { $type: 'blog.pckt.block.text', plaintext: 'b' },
          { $type: 'blog.pckt.block.heading', plaintext: 'c' },
        ],
      },
    })

    expect(types).toEqual([
      { path: 'content.items[].$type', nsid: 'blog.pckt.block.text' },
      { path: 'content.items[].$type', nsid: 'blog.pckt.block.heading' },
    ])
  })

  test('skips non-NSID markers like blob', () => {
    const types = extractTypes({
      cover: { $type: 'blob', ref: { $link: 'bafy' }, mimeType: 'image/png' },
    })

    expect(types).toEqual([])
  })
})

describe('nsidAuthority', () => {
  test('reverses all but the last segment', () => {
    expect(nsidAuthority('blog.pckt.content')).toBe('pckt.blog')
    expect(nsidAuthority('site.standard.graph.subscription')).toBe('graph.standard.site')
  })

  test('rejects too-short NSIDs', () => {
    expect(() => nsidAuthority('foo.bar')).toThrow('invalid NSID')
  })
})

describe('resolveLexicon', () => {
  const LEXICON = { lexicon: 1, id: 'blog.pckt.content', defs: { main: { type: 'record' } } }

  test('DNS TXT → DID doc → PDS getRecord', async () => {
    const fetched: string[] = []
    const schema = await resolveLexicon('blog.pckt.content', {
      lookupTxt: async (host) => {
        expect(host).toBe('_lexicon.pckt.blog')
        return [['did=did:plc:lexowner']]
      },
      fetchJson: async (url) => {
        fetched.push(url)
        if (url.includes('plc.directory')) {
          return {
            service: [
              { id: '#pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' },
            ],
          }
        }
        return { value: LEXICON }
      },
    })

    expect(schema).toEqual(LEXICON)
    expect(fetched[0]).toBe('https://plc.directory/did:plc:lexowner')
    expect(fetched[1]).toContain('https://pds.example/xrpc/com.atproto.repo.getRecord')
    expect(fetched[1]).toContain('rkey=blog.pckt.content')
  })

  test('throws when no TXT record exists', async () => {
    expect(
      resolveLexicon('org.wordpress.html', {
        lookupTxt: async () => [],
        fetchJson: async () => ({}),
      }),
    ).rejects.toThrow('no _lexicon TXT record')
  })
})

describe('deriveTextFields', () => {
  test('collects string properties from defs including nested arrays', () => {
    const fields = deriveTextFields({
      lexicon: 1,
      id: 'blog.pckt.content',
      defs: {
        main: {
          type: 'record',
          record: {
            type: 'object',
            properties: {
              items: { type: 'array', items: { type: 'object', properties: { plaintext: { type: 'string' } } } },
            },
          },
        },
        block: { type: 'object', properties: { caption: { type: 'string' } } },
      },
    })

    expect(fields).toEqual(['items[].plaintext', '#block.caption'])
  })

  test('returns empty for schemas without defs', () => {
    expect(deriveTextFields({ lexicon: 1 })).toEqual([])
  })
})
