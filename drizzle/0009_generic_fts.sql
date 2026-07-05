ALTER TABLE records ADD COLUMN extracted_title text;

DROP INDEX records_searchable_gin;
ALTER TABLE records DROP COLUMN searchable;
ALTER TABLE records ADD COLUMN searchable tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(extracted_title, '')), 'A') ||
    setweight(to_tsvector('english', left(coalesce(extracted_text, ''), 200000)), 'C')
) STORED;

CREATE INDEX records_searchable_gin ON records USING gin (searchable);
