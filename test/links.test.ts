import { describe, expect, test } from 'bun:test'
import { extractLinks } from '../src/ingest/links'

describe('extractLinks', () => {
  test('extracts and parses at:// URIs', () => {
    const links = extractLinks({
      publication: 'at://did:plc:abc123/site.standard.publication/pub-1',
    })

    expect(links).toEqual([
      {
        path: 'publication',
        targetUri: 'at://did:plc:abc123/site.standard.publication/pub-1',
        targetDid: 'did:plc:abc123',
        targetCollection: 'site.standard.publication',
        targetRkey: 'pub-1',
      },
    ])
  })

  test('extracts bare DIDs (plc and web)', () => {
    const links = extractLinks({ author: 'did:plc:xyz789', site: 'did:web:example.com' })

    expect(links).toHaveLength(2)
    expect(links[0]).toMatchObject({ path: 'author', targetDid: 'did:plc:xyz789', targetCollection: null })
    expect(links[1]).toMatchObject({ path: 'site', targetDid: 'did:web:example.com' })
  })

  test('builds array paths with [] notation', () => {
    const links = extractLinks({
      contributors: [{ did: 'did:plc:one' }, { did: 'did:plc:two' }],
    })

    expect(links.map((l) => l.path)).toEqual(['contributors[].did', 'contributors[].did'])
    expect(links.map((l) => l.targetDid)).toEqual(['did:plc:one', 'did:plc:two'])
  })

  test('walks nested objects', () => {
    const links = extractLinks({
      bskyPostRef: { uri: 'at://did:plc:abc/app.bsky.feed.post/3kabc' },
    })

    expect(links[0]).toMatchObject({ path: 'bskyPostRef.uri', targetCollection: 'app.bsky.feed.post' })
  })

  test('skips $type keys and blob objects', () => {
    const links = extractLinks({
      $type: 'site.standard.document',
      cover: { $type: 'blob', ref: { $link: 'bafyabc' }, mimeType: 'image/png' },
    })

    expect(links).toEqual([])
  })

  test('ignores plain strings, https urls, and malformed at-uris', () => {
    const links = extractLinks({
      title: 'not a link',
      url: 'https://example.com',
      broken: 'at://not-a-did/coll',
    })

    expect(links).toEqual([])
  })

  test('dedupes identical path+target pairs', () => {
    const links = extractLinks({
      tags: ['did:plc:same', 'did:plc:same'],
    })

    expect(links).toHaveLength(1)
  })
})
