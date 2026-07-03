import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  vector,
} from 'drizzle-orm/pg-core'

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
})

export const records = pgTable(
  'records',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    did: varchar('did', { length: 255 }).notNull(),
    collection: varchar('collection', { length: 255 }).notNull(),
    rkey: varchar('rkey', { length: 255 }).notNull(),
    uri: text('uri')
      .generatedAlwaysAs(sql`'at://' || did || '/' || collection || '/' || rkey`)
      .notNull(),
    cid: varchar('cid', { length: 255 }),
    rev: varchar('rev', { length: 255 }),
    record: jsonb('record').notNull().default({}),
    searchable: tsvector('searchable').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(record->>'title', record->>'name', '')), 'A') || setweight(to_tsvector('english', coalesce(record->>'description', '')), 'B') || setweight(to_tsvector('english', coalesce(record->>'textContent', '')), 'C')`,
    ),
    embedStatus: varchar('embed_status', { length: 20 }).notNull().default('skipped'),
    embedAttempts: integer('embed_attempts').notNull().default(0),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('records_did_collection_rkey_key').on(table.did, table.collection, table.rkey),
    index('records_collection_idx').on(table.collection),
    index('records_uri_idx').on(table.uri),
  ],
)

export const recordEmbeddings = pgTable(
  'record_embeddings',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    recordId: bigint('record_id', { mode: 'number' })
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    chunkText: text('chunk_text').notNull(),
    embedding: vector('embedding', { dimensions: 768 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('record_embeddings_record_chunk_key').on(table.recordId, table.chunkIndex)],
)

export const recordLinks = pgTable(
  'record_links',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    recordId: bigint('record_id', { mode: 'number' })
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    path: varchar('path', { length: 500 }).notNull(),
    targetUri: text('target_uri').notNull(),
    targetDid: varchar('target_did', { length: 255 }),
    targetCollection: varchar('target_collection', { length: 255 }),
    targetRkey: varchar('target_rkey', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('record_links_record_path_target_key').on(table.recordId, table.path, table.targetUri),
    index('record_links_target_uri_idx').on(table.targetUri),
    index('record_links_target_did_idx').on(table.targetDid),
  ],
)

export const recordTypes = pgTable(
  'record_types',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    recordId: bigint('record_id', { mode: 'number' })
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    path: varchar('path', { length: 500 }).notNull(),
    nsid: varchar('nsid', { length: 255 }).notNull(),
  },
  (table) => [
    uniqueIndex('record_types_record_path_nsid_key').on(table.recordId, table.path, table.nsid),
    index('record_types_nsid_idx').on(table.nsid),
    index('record_types_path_nsid_idx').on(table.path, table.nsid),
  ],
)

export const lexiconSchemas = pgTable('lexicon_schemas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  nsid: varchar('nsid', { length: 255 }).notNull().unique(),
  schema: jsonb('schema'),
  error: text('error'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }).notNull().defaultNow(),
})

export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    recordId: bigint('record_id', { mode: 'number' })
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    did: varchar('did', { length: 255 }).notNull(),
    collection: varchar('collection', { length: 255 }).notNull(),
    rkey: varchar('rkey', { length: 255 }).notNull(),
    action: varchar('action', { length: 20 }).notNull(),
    rev: varchar('rev', { length: 255 }),
    live: boolean('live').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('events_collection_id_idx').on(table.collection, table.id),
    index('events_did_id_idx').on(table.did, table.id),
  ],
)

export const constellationCache = pgTable('constellation_cache', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  cacheKey: varchar('cache_key', { length: 64 }).notNull().unique(),
  endpoint: varchar('endpoint', { length: 100 }).notNull(),
  target: text('target').notNull(),
  collection: varchar('collection', { length: 255 }),
  path: varchar('path', { length: 500 }),
  response: jsonb('response').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
})

export const audiences = pgTable('audiences', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull().unique(),
  definition: jsonb('definition').notNull().$type<AudienceDefinition>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type AudienceDefinition =
  | { kind: 'backlink'; target: string; collection?: string; path?: string }
  | { kind: 'collection'; collection: string; matchers?: Record<string, string> }
  | { kind: 'static'; dids: string[] }

export type AudienceRow = typeof audiences.$inferSelect

export const webhookSubscriptions = pgTable('webhook_subscriptions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull().unique(),
  url: text('url').notNull(),
  secret: varchar('secret', { length: 64 }).notNull(),
  collections: jsonb('collections').notNull().default([]).$type<string[]>(),
  actions: jsonb('actions').notNull().default([]).$type<string[]>(),
  recordMatchers: jsonb('record_matchers').notNull().default({}).$type<Record<string, string>>(),
  includeRecord: boolean('include_record').notNull().default(true),
  maxEvents: integer('max_events').notNull().default(200),
  maxWaitMs: integer('max_wait_ms').notNull().default(5000),
  cursor: bigint('cursor', { mode: 'number' }).notNull().default(0),
  audience: varchar('audience', { length: 255 }),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  failureCount: integer('failure_count').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect

export const apiTokens = pgTable('api_tokens', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
})

export type RecordRow = typeof records.$inferSelect
export type RecordLinkRow = typeof recordLinks.$inferSelect
