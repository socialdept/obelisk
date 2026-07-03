import { describe, expect, test } from 'bun:test'
import { chunkText } from '../src/embed/chunk'
import { extractFields } from '../src/embed/extract'

describe('extractFields', () => {
  test('joins named fields in order with blank lines', () => {
    const text = extractFields(
      { title: 'My Title', description: 'A description.', textContent: 'Body text.' },
      ['title', 'description', 'textContent'],
    )

    expect(text).toBe('My Title\n\nA description.\n\nBody text.')
  })

  test('skips missing and non-string fields', () => {
    const text = extractFields({ title: 'Only Title', description: 42 }, ['title', 'description'])
    expect(text).toBe('Only Title')
  })

  test('returns empty string when no fields given', () => {
    expect(extractFields({ publication: 'at://x/y/1' }, [])).toBe('')
  })
})

describe('chunkText', () => {
  const options = { chunkChars: 100, chunkOverlap: 20 }

  test('short text is a single chunk', () => {
    expect(chunkText('hello world', options)).toEqual(['hello world'])
  })

  test('empty text produces no chunks', () => {
    expect(chunkText('   ', options)).toEqual([])
  })

  test('long text splits into multiple chunks within the limit', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} here.`).join(' ')
    const chunks = chunkText(text, options)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100)
  })

  test('consecutive chunks share overlapping context', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} here.`).join(' ')
    const chunks = chunkText(text, options)

    const tailWords = chunks[0]!.slice(-15)
    expect(chunks[1]!.includes(tailWords.split(' ').pop()!)).toBe(true)
  })

  test('prefers paragraph boundaries', () => {
    const para = 'First paragraph content that is fairly long and even a bit longer here.'
    const text = `${para}\n\nSecond paragraph starts now and also continues for a while longer.`
    const chunks = chunkText(text, options)

    expect(chunks[0]).toBe(para)
  })

  test('covers all content — last chunk includes the end of the text', () => {
    const text = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ')
    const chunks = chunkText(text, options)

    expect(chunks.at(-1)!.endsWith('word49')).toBe(true)
  })
})
