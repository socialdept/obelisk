ALTER TABLE records ADD COLUMN extracted_text text;

DROP INDEX records_searchable_gin;
ALTER TABLE records DROP COLUMN searchable;
ALTER TABLE records ADD COLUMN searchable tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(record->>'title', record->>'name', '')), 'A') ||
    setweight(to_tsvector('english', coalesce(record->>'description', '')), 'B') ||
    setweight(to_tsvector('english', coalesce(record->>'textContent', '')), 'C') ||
    setweight(to_tsvector('english', left(coalesce(extracted_text, ''), 200000)), 'C')
) STORED;

CREATE INDEX records_searchable_gin ON records USING gin (searchable);
