import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { apiTokens } from '../db/schema'

export function hashToken(token: string): string {
  return new Bun.CryptoHasher('sha256').update(token).digest('hex')
}

export function bearerAuth(db: Db) {
  return createMiddleware(async (c, next) => {
    const header = c.req.header('Authorization')
    if (!header?.startsWith('Bearer ')) {
      return c.json({ error: 'missing bearer token' }, 401)
    }

    const tokenHash = hashToken(header.slice('Bearer '.length).trim())
    const rows = await db.select({ id: apiTokens.id }).from(apiTokens).where(eq(apiTokens.tokenHash, tokenHash))
    const token = rows[0]
    if (!token) return c.json({ error: 'invalid token' }, 401)

    // Fire-and-forget usage stamp; not worth blocking the request.
    db.update(apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiTokens.id, token.id))
      .catch(() => {})

    await next()
  })
}
