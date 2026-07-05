import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { loadEnv } from '../src/config'

// loadEnv reads process.env — snapshot the keys it touches and restore each time.
const KEYS = [
  'DATABASE_URL',
  'TAB_WS_URL',
  'OLLAMA_URL',
  'PORT',
  'OBELISK_HOST',
  'OBELISK_DEV_MODE',
  'OBELISK_ALLOW_INSECURE',
  'OBELISK_RATE_LIMIT_PER_MIN',
]
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  process.env.DATABASE_URL = 'postgres://obelisk:obelisk@localhost:5432/obelisk'
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('loadEnv', () => {
  test('throws when DATABASE_URL is missing or blank', () => {
    delete process.env.DATABASE_URL
    expect(() => loadEnv()).toThrow(/DATABASE_URL is required/)
    process.env.DATABASE_URL = '   '
    expect(() => loadEnv()).toThrow(/DATABASE_URL is required/)
  })

  test('sane defaults', () => {
    const env = loadEnv()
    expect(env.host).toBe('0.0.0.0')
    expect(env.port).toBe(6060)
    expect(env.limits.rateLimitPerMin).toBe(120)
    expect(env.dbStatementTimeoutMs).toBe(30_000)
  })

  test('rejects a non-integer numeric env', () => {
    process.env.OBELISK_RATE_LIMIT_PER_MIN = 'lots'
    expect(() => loadEnv()).toThrow(/non-negative integer/)
  })

  test('rejects a malformed URL env', () => {
    process.env.OLLAMA_URL = 'not a url'
    expect(() => loadEnv()).toThrow(/must be a valid URL/)
  })

  describe('dev-mode bind guard', () => {
    test('refuses dev-mode on a non-loopback bind', () => {
      process.env.OBELISK_DEV_MODE = 'true'
      process.env.OBELISK_HOST = '0.0.0.0'
      expect(() => loadEnv()).toThrow(/OBELISK_DEV_MODE is on/)
    })

    test('allows dev-mode on loopback', () => {
      process.env.OBELISK_DEV_MODE = 'true'
      process.env.OBELISK_HOST = '127.0.0.1'
      expect(loadEnv().devMode).toBe(true)
    })

    test('allows dev-mode on a public bind when explicitly acknowledged', () => {
      process.env.OBELISK_DEV_MODE = 'true'
      process.env.OBELISK_HOST = '0.0.0.0'
      process.env.OBELISK_ALLOW_INSECURE = 'true'
      expect(loadEnv().devMode).toBe(true)
    })
  })
})
