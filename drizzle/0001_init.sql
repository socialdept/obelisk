CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE records (
    id           bigserial PRIMARY KEY,
    did          varchar(255) NOT NULL,
    collection   varchar(255) NOT NULL,
    rkey         varchar(255) NOT NULL,
    uri          text GENERATED ALWAYS AS ('at://' || did || '/' || collection || '/' || rkey) STORED,
    cid          varchar(255),
    rev          varchar(255),
    record       jsonb NOT NULL DEFAULT '{}',
    searchable   tsvector GENERATED ALWAYS AS (
                     setweight(to_tsvector('english', coalesce(record->>'title', record->>'name', '')), 'A') ||
                     setweight(to_tsvector('english', coalesce(record->>'description', '')), 'B') ||
                     setweight(to_tsvector('english', coalesce(record->>'textContent', '')), 'C')
                 ) STORED,
    embed_status varchar(20) NOT NULL DEFAULT 'skipped'
                 CHECK (embed_status IN ('pending', 'done', 'skipped', 'failed')),
    embed_attempts int NOT NULL DEFAULT 0,
    indexed_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz,
    UNIQUE (did, collection, rkey)
);

CREATE INDEX records_collection_idx ON records (collection);
CREATE INDEX records_uri_idx ON records (uri);
CREATE INDEX records_searchable_gin ON records USING gin (searchable);
CREATE INDEX records_embed_pending_idx ON records (id) WHERE embed_status = 'pending';

CREATE TABLE record_embeddings (
    id          bigserial PRIMARY KEY,
    record_id   bigint NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    chunk_index int NOT NULL,
    chunk_text  text NOT NULL,
    embedding   vector(768) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (record_id, chunk_index)
);

CREATE INDEX record_embeddings_hnsw ON record_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE record_links (
    id                bigserial PRIMARY KEY,
    record_id         bigint NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    path              varchar(500) NOT NULL,
    target_uri        text NOT NULL,
    target_did        varchar(255),
    target_collection varchar(255),
    target_rkey       varchar(255),
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (record_id, path, target_uri)
);

CREATE INDEX record_links_target_uri_idx ON record_links (target_uri);
CREATE INDEX record_links_target_did_idx ON record_links (target_did);

CREATE TABLE constellation_cache (
    id         bigserial PRIMARY KEY,
    cache_key  varchar(64) NOT NULL UNIQUE,
    endpoint   varchar(100) NOT NULL,
    target     text NOT NULL,
    collection varchar(255),
    path       varchar(500),
    response   jsonb NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
    id           bigserial PRIMARY KEY,
    name         varchar(255) NOT NULL,
    token_hash   varchar(64) NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
);
