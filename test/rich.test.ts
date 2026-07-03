import { describe, expect, test } from 'bun:test'
import { extractRichText, stripHtml, textKeysFromFieldPaths, DEFAULT_TEXT_KEYS } from '../src/embed/rich'

describe('extractRichText', () => {
  test('flat markdown content (site.standard.content.markdown)', async () => {
    const text = await extractRichText({
      content: { $type: 'site.standard.content.markdown', markdown: '## Doing\n- Messing with atproto' },
    })
    expect(text).toBe('## Doing\n- Messing with atproto')
  })

  test('block array content (is.logue / pckt style)', async () => {
    const text = await extractRichText({
      content: {
        $type: 'is.logue.content',
        items: [
          { $type: 'is.logue.block.text', plaintext: 'First paragraph.' },
          { $type: 'is.logue.block.text', plaintext: 'Second paragraph.' },
        ],
      },
    })
    expect(text).toBe('First paragraph.\n\nSecond paragraph.')
  })

  test('deeply nested blocks (leaflet style) reach plaintext', async () => {
    const text = await extractRichText({
      content: {
        $type: 'pub.leaflet.content',
        pages: [
          {
            $type: 'pub.leaflet.pages.linearDocument',
            blocks: [
              { $type: 'pub.leaflet.pages.linearDocument#block', block: { $type: 'pub.leaflet.blocks.text', plaintext: 'Deep text.' } },
              { $type: 'pub.leaflet.pages.linearDocument#block', block: { $type: 'pub.leaflet.blocks.image', image: { ref: { $link: 'bafy' } }, alt: 'A photo' } },
            ],
          },
        ],
      },
    })
    expect(text).toBe('Deep text.\n\nA photo')
  })

  test('html content is tag-stripped (org.wordpress.html)', async () => {
    const text = await extractRichText({
      content: { html: '<div><p>Hello <b>world</b></p><script>evil()</script></div>' },
    })
    expect(text).toBe('Hello world')
  })

  test('lexicon-derived keys override defaults', async () => {
    const record = {
      content: { $type: 'com.example.content', body: 'Custom field prose', plaintext: 'ignored when derived says body' },
    }
    const text = await extractRichText(record, async () => new Set(['body']))
    expect(text).toBe('Custom field prose')
  })

  test('resolver failure falls back to defaults', async () => {
    const text = await extractRichText(
      { content: { $type: 'com.example.content', plaintext: 'fallback works' } },
      async () => {
        throw new Error('dns exploded')
      },
    )
    expect(text).toBe('fallback works')
  })

  test('non-prose keys never extracted, absent content yields empty', async () => {
    expect(await extractRichText({ content: { url: 'https://x.test', src: 'y', id: 'z' } })).toBe('')
    expect(await extractRichText({ title: 'no content field' })).toBe('')
  })
})

describe('stripHtml', () => {
  test('strips tags, scripts, entities; collapses whitespace', () => {
    expect(stripHtml('<p>a&nbsp;&amp;\n<style>x{}</style> b</p>')).toBe('a & b')
  })
})

describe('textKeysFromFieldPaths', () => {
  test('takes leaf names, drops array markers and non-prose keys', () => {
    const keys = textKeysFromFieldPaths(['items[].plaintext', 'content[].facets[].features[].did', 'attrs.alt', '#block.caption'])
    expect(keys).toEqual(new Set(['plaintext', 'alt', 'caption']))
  })

  test('defaults cover the observed platforms', () => {
    for (const key of ['plaintext', 'markdown', 'html', 'text']) expect(DEFAULT_TEXT_KEYS.has(key)).toBe(true)
  })
})
