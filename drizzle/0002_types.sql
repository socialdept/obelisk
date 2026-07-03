CREATE TABLE record_types (
    id         bigserial PRIMARY KEY,
    record_id  bigint NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    path       varchar(500) NOT NULL,
    nsid       varchar(255) NOT NULL,
    UNIQUE (record_id, path, nsid)
);

CREATE INDEX record_types_nsid_idx ON record_types (nsid);
CREATE INDEX record_types_path_nsid_idx ON record_types (path, nsid);

CREATE TABLE lexicon_schemas (
    id          bigserial PRIMARY KEY,
    nsid        varchar(255) NOT NULL UNIQUE,
    schema      jsonb,
    error       text,
    resolved_at timestamptz NOT NULL DEFAULT now()
);
