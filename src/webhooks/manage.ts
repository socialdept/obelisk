import { eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { webhookSubscriptions, type WebhookSubscription } from '../db/schema'
import { currentEventHead, signBody, type FetchFn } from './worker'

export interface WebhookInput {
  name?: string
  url?: string
  collections?: string[]
  actions?: string[]
  record_matchers?: Record<string, string>
  audience?: string | null
  feed?: string | null
  include_record?: boolean
  max_events?: number
  max_wait_ms?: number
  from_cursor?: number | 'start'
  status?: 'active' | 'paused'
  cursor?: number
  id?: number
}

/** Uniform result: `{ error }` carries an atproto error name + HTTP status for the XRPC layer. */
export type ManageResult<T> = { data: T } | { error: string; message: string; status: 400 | 404 | 409 }

export function serializeWebhook(sub: WebhookSubscription) {
  return {
    id: sub.id,
    name: sub.name,
    url: sub.url,
    collections: sub.collections,
    actions: sub.actions,
    recordMatchers: sub.recordMatchers,
    audience: sub.audience,
    feed: sub.feed,
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

export async function listWebhooks(db: Db) {
  const subs = await db.select().from(webhookSubscriptions)
  return subs.map(serializeWebhook)
}

export async function getWebhook(db: Db, id: number): Promise<ManageResult<object>> {
  const sub = await findSub(db, id)
  if (!sub) return notFound()
  return { data: { webhook: serializeWebhook(sub) } }
}

export async function createWebhook(db: Db, input: WebhookInput): Promise<ManageResult<object>> {
  if (!input.name || !input.url) return invalid('name and url are required')

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
      feed: input.feed ?? null,
      includeRecord: input.include_record ?? true,
      maxEvents: input.max_events ?? 200,
      maxWaitMs: input.max_wait_ms ?? 5000,
      cursor,
    })
    .returning()
    .catch(() => null)
  if (!inserted) return conflict('name already exists')

  // Secret is returned on creation only — store it for signature verification.
  return { data: { webhook: { ...serializeWebhook(inserted[0]!), secret } } }
}

export async function updateWebhook(db: Db, input: WebhookInput): Promise<ManageResult<object>> {
  if (input.id === undefined) return invalid('id is required')
  const sub = await findSub(db, input.id)
  if (!sub) return notFound()

  const updates: Partial<typeof webhookSubscriptions.$inferInsert> = {}
  if (input.url !== undefined) updates.url = input.url
  if (input.collections !== undefined) updates.collections = input.collections
  if (input.actions !== undefined) updates.actions = input.actions
  if (input.record_matchers !== undefined) updates.recordMatchers = input.record_matchers
  if (input.audience !== undefined) updates.audience = input.audience
  if (input.feed !== undefined) updates.feed = input.feed
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
  return { data: { webhook: serializeWebhook(updated[0]!) } }
}

export async function deleteWebhook(db: Db, id: number | undefined): Promise<ManageResult<{ deleted: true }>> {
  if (id === undefined) return invalid('id is required')
  const sub = await findSub(db, id)
  if (!sub) return notFound()

  await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, sub.id))
  return { data: { deleted: true } }
}

export async function testWebhook(
  db: Db,
  id: number | undefined,
  fetchFn: FetchFn = fetch,
): Promise<ManageResult<{ delivered: boolean; status?: number; error?: string }>> {
  if (id === undefined) return invalid('id is required')
  const sub = await findSub(db, id)
  if (!sub) return notFound()

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
        record: { $type: 'site.standard.document', title: 'Obelisk test event' },
      },
    ],
  })

  try {
    const response = await fetchFn(sub.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Obelisk-Subscription': sub.name,
        'X-Obelisk-Cursor': String(sub.cursor),
        'X-Obelisk-Signature': signBody(sub.secret, body),
      },
      body,
    })
    return { data: { delivered: response.ok, status: response.status } }
  } catch (err) {
    return { data: { delivered: false, error: err instanceof Error ? err.message : String(err) } }
  }
}

async function findSub(db: Db, id: number): Promise<WebhookSubscription | undefined> {
  if (!Number.isInteger(id)) return undefined
  const rows = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id))
  return rows[0]
}

const invalid = (message: string) => ({ error: 'InvalidRequest', message, status: 400 as const })
const notFound = () => ({ error: 'NotFound', message: 'subscription not found', status: 404 as const })
const conflict = (message: string) => ({ error: 'AlreadyExists', message, status: 409 as const })
