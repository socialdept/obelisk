-- One GIN index serves containment (@>) for EVERY record JSON path (LAB-11), so
-- `where { "content.$type": { eq: … } }` is an index scan instead of a seq scan
-- over the jsonb. jsonb_path_ops is the compact operator class — it supports
-- exactly the `@>` we translate equality/in filters into.
CREATE INDEX records_record_gin ON records USING gin (record jsonb_path_ops);
