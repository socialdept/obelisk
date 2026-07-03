import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/client'
import { webhookSubscriptions, type WebhookSubscription } from '../../db/schema'
import { currentEventHead, signBody, type FetchFn } from '../../webhooks/worker'

interface SubscriptionInput {
  name?: string
  url?: string
  collections?: string[]
  actions?: string[]
  record_matchers?: Record<string, string>
  audience?: string | null
  include_record?: boolean
  max_events?: number
  max_wait_ms?: number
  from_cursor?: number | 'start'
  status?: 'active' | 'paused'
  cursor?: number
}

export function webhooksRoutes(db: Db, fetchFn: FetchFn = fetch): Hono {
  const app = new Hono()

  app.get('/', async (c) => {
    const subs = await db.select().from(webhookSubscriptions)
    return c.json({ webhooks: subs.map(serialize) })
  })

  app.post('/', async (c) => {
    const input = (await c.req.json()) as SubscriptionInput
    if (!input.name || !input.url) return c.json({ error: 'name and url are required' }, 400)

    const secret = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')
    const cursor = input.from_cursor === 'start' ? 0 : (input.from_cursor ?? (await currentEventHead(db)))

    const inserted = await db
      .insert(webhookSubscriptions)
      .values({
        name: input.name,
        url: input.url,
        secret,
        collections: input.collections ?? [],
        actions: input.actions ?? [],
        recordMatchers: input.record_matchers ?? {},
        audience: input.audience ?? null,
        includeRecord: input.include_record ?? true,
        maxEvents: input.max_events ?? 200,
        maxWaitMs: input.max_wait_ms ?? 5000,
        cursor,
      })
      .returning()
      .catch(() => null)
    if (!inserted) return c.json({ error: 'name already exists' }, 409)

    // Secret is returned on creation only — store it for signature verification.
    return c.json({ webhook: { ...serialize(inserted[0]!), secret } }, 201)
  })

  app.get('/:id', async (c) => {
    const sub = await findSub(db, c.req.param('id'))
    if (!sub) return c.json({ error: 'not found' }, 404)
    return c.json({ webhook: serialize(sub) })
  })

  app.patch('/:id', async (c) => {
    const sub = await findSub(db, c.req.param('id'))
    if (!sub) return c.json({ error: 'not found' }, 404)

    const input = (await c.req.json()) as SubscriptionInput
    const updates: Partial<typeof webhookSubscriptions.$inferInsert> = {}
    if (input.url !== undefined) updates.url = input.url
    if (input.collections !== undefined) updates.collections = input.collections
    if (input.actions !== undefined) updates.actions = input.actions
    if (input.record_matchers !== undefined) updates.recordMatchers = input.record_matchers
    if (input.audience !== undefined) updates.audience = input.audience
    if (input.include_record !== undefined) updates.includeRecord = input.include_record
    if (input.max_events !== undefined) updates.maxEvents = input.max_events
    if (input.max_wait_ms !== undefined) updates.maxWaitMs = input.max_wait_ms
    if (input.cursor !== undefined) updates.cursor = input.cursor
    if (input.status !== undefined) {
      updates.status = input.status
      // Reactivation clears backoff so delivery resumes immediately.
      updates.failureCount = 0
      updates.nextAttemptAt = new Date()
    }

    const updated = await db
      .update(webhookSubscriptions)
      .set(updates)
      .where(eq(webhookSubscriptions.id, sub.id))
      .returning()
    return c.json({ webhook: serialize(updated[0]!) })
  })

  app.delete('/:id', async (c) => {
    const sub = await findSub(db, c.req.param('id'))
    if (!sub) return c.json({ error: 'not found' }, 404)

    await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, sub.id))
    return c.json({ deleted: true })
  })

  app.post('/:id/test', async (c) => {
    const sub = await findSub(db, c.req.param('id'))
    if (!sub) return c.json({ error: 'not found' }, 404)

    const body = JSON.stringify({
      subscription: sub.name,
      cursor: String(sub.cursor),
      test: true,
      events: [
        {
          cursor: String(sub.cursor),
          uri: 'at://did:plc:test/site.standard.document/test',
          did: 'did:plc:test',
          collection: 'site.standard.document',
          rkey: 'test',
          action: 'create',
          rev: '3test',
          live: true,
          createdAt: new Date().toISOString(),
          record: { $type: 'site.standard.document', title: 'Reservoir test event' },
        },
      ],
    })

    try {
      const response = await fetchFn(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Reservoir-Subscription': sub.name,
          'X-Reservoir-Cursor': String(sub.cursor),
          'X-Reservoir-Signature': signBody(sub.secret, body),
        },
        body,
      })
      return c.json({ delivered: response.ok, status: response.status })
    } catch (err) {
      return c.json({ delivered: false, error: err instanceof Error ? err.message : String(err) }, 502)
    }
  })

  return app
}

async function findSub(db: Db, idParam: string): Promise<WebhookSubscription | undefined> {
  const id = Number(idParam)
  if (!Number.isInteger(id)) return undefined
  const rows = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id))
  return rows[0]
}

function serialize(sub: WebhookSubscription) {
  return {
    id: sub.id,
    name: sub.name,
    url: sub.url,
    collections: sub.collections,
    actions: sub.actions,
    recordMatchers: sub.recordMatchers,
    audience: sub.audience,
    includeRecord: sub.includeRecord,
    maxEvents: sub.maxEvents,
    maxWaitMs: sub.maxWaitMs,
    cursor: String(sub.cursor),
    status: sub.status,
    failureCount: sub.failureCount,
    lastDeliveryAt: sub.lastDeliveryAt,
    createdAt: sub.createdAt,
  }
}
