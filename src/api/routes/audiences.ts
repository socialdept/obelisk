import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { findAudience, isMember, listMembers, validateDefinition } from '../../audiences/definition'
import type { Db } from '../../db/client'
import { audiences, type AudienceDefinition } from '../../db/schema'

export function audiencesRoutes(db: Db): Hono {
  const app = new Hono()

  app.get('/', async (c) => {
    const rows = await db.select().from(audiences)
    return c.json({ audiences: rows })
  })

  app.post('/', async (c) => {
    const input = (await c.req.json()) as { name?: string; definition?: AudienceDefinition }
    if (!input.name || !input.definition) return c.json({ error: 'name and definition are required' }, 400)

    const invalid = validateDefinition(input.definition)
    if (invalid) return c.json({ error: invalid }, 400)

    const inserted = await db
      .insert(audiences)
      .values({ name: input.name, definition: input.definition })
      .returning()
      .catch(() => null)
    if (!inserted) return c.json({ error: 'name already exists' }, 409)

    return c.json({ audience: inserted[0] }, 201)
  })

  app.get('/:name', async (c) => {
    const audience = await findAudience(db, c.req.param('name'))
    if (!audience) return c.json({ error: 'not found' }, 404)
    return c.json({ audience })
  })

  app.patch('/:name', async (c) => {
    const audience = await findAudience(db, c.req.param('name'))
    if (!audience) return c.json({ error: 'not found' }, 404)

    const input = (await c.req.json()) as { definition?: AudienceDefinition }
    if (!input.definition) return c.json({ error: 'definition is required' }, 400)

    const invalid = validateDefinition(input.definition)
    if (invalid) return c.json({ error: invalid }, 400)

    const updated = await db
      .update(audiences)
      .set({ definition: input.definition })
      .where(eq(audiences.id, audience.id))
      .returning()
    return c.json({ audience: updated[0] })
  })

  app.delete('/:name', async (c) => {
    const audience = await findAudience(db, c.req.param('name'))
    if (!audience) return c.json({ error: 'not found' }, 404)

    await db.delete(audiences).where(eq(audiences.id, audience.id))
    return c.json({ deleted: true })
  })

  app.get('/:name/members', async (c) => {
    const audience = await findAudience(db, c.req.param('name'))
    if (!audience) return c.json({ error: 'not found' }, 404)

    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 1000)
    const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0)
    const members = await listMembers(db, audience.definition, limit, offset)

    return c.json({ name: audience.name, members, limit, offset })
  })

  app.get('/:name/members/:did', async (c) => {
    const audience = await findAudience(db, c.req.param('name'))
    if (!audience) return c.json({ error: 'not found' }, 404)

    const member = await isMember(db, audience.definition, c.req.param('did'))
    return c.json({ name: audience.name, did: c.req.param('did'), member })
  })

  return app
}
