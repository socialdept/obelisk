import { describe, expect, test } from 'bun:test'
import { createExtractionResolver } from '../src/lexicon/collection'
import type { LexiconRegistry } from '../src/lexicon/registry'

const DOCUMENT_LEXICON = {
  lexicon: 1,
  id: 'site.standard.document',
  defs: {
    main: {
      type: 'record',
      record: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          textContent: { type: 'string' },
          path: { type: 'string' },
          site: { type: 'string', format: 'at-uri' },
          publishedAt: { type: 'string', format: 'datetime' },
          content: { type: 'union', refs: [], closed: false },
          coverImage: { type: 'blob' },
          contributors: { type: 'array', items: { type: 'ref', ref: '#contributor' } },
        },
      },
    },
  },
}

function fakeRegistry(schemas: Record<string, unknown>): LexiconRegistry {
  return {
    get: async (nsid: string) => ({
      nsid,
      schema: schemas[nsid] ?? null,
      error: schemas[nsid] ? null : 'not published',
      resolvedAt: new Date(),
    }),
  } as unknown as LexiconRegistry
}

describe('createExtractionResolver', () => {
  test('derives title, prose, and rich fields from the collection lexicon', async () => {
    const resolve = createExtractionResolver(fakeRegistry({ 'site.standard.document': DOCUMENT_LEXICON }), {})
    const extraction = await resolve('site.standard.document')

    expect(extraction.titleFields).toEqual(['title'])
    // path is NON_PROSE; site/publishedAt are strings but prose-ish filtering keeps them out only via NON_PROSE — site/publishedAt included?
    expect(extraction.textFields).toContain('description')
    expect(extraction.textFields).toContain('textContent')
    expect(extraction.textFields).not.toContain('path')
    expect(extraction.richContentFields).toContain('content')
    expect(extraction.richContentFields).toContain('contributors')
    expect(extraction.richContentFields).not.toContain('coverImage')
  })

  test('config overrides beat derivation per part', async () => {
    const resolve = createExtractionResolver(fakeRegistry({ 'site.standard.document': DOCUMENT_LEXICON }), {
      'site.standard.document': { textFields: ['textContent'] },
    })
    const extraction = await resolve('site.standard.document')

    expect(extraction.textFields).toEqual(['textContent'])
    expect(extraction.titleFields).toEqual(['title'])
  })

  test('unresolvable lexicon falls back to config alone', async () => {
    const resolve = createExtractionResolver(fakeRegistry({}), {
      'com.example.thing': { titleFields: ['heading'], textFields: ['body'] },
    })
    const extraction = await resolve('com.example.thing')

    expect(extraction.titleFields).toEqual(['heading'])
    expect(extraction.textFields).toEqual(['body'])
    expect(extraction.richContentFields).toEqual([])
  })

  test('unresolvable lexicon with no config yields nothing (worker will skip)', async () => {
    const resolve = createExtractionResolver(fakeRegistry({}), {})
    const extraction = await resolve('com.example.mystery')

    expect(extraction).toEqual({ titleFields: [], textFields: [], richContentFields: [] })
  })
})
