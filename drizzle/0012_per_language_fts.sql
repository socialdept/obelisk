-- Per-language FTS (LAB-43). A generated column can't branch config per row via
-- config, but it CAN call an IMMUTABLE function — so map a stored `lang` to a
-- Postgres text-search config and tokenize each row accordingly.
--
-- Fallbacks: NULL/unset → english (preserves existing English-only behavior and
-- tests); a detected-but-unsupported code → `simple` (never mis-stems).
CREATE FUNCTION fts_regconfig(lang text) RETURNS regconfig
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (CASE lower(coalesce(lang, 'en'))
    WHEN 'en' THEN 'english'    WHEN 'english'    THEN 'english'
    WHEN 'es' THEN 'spanish'    WHEN 'spanish'    THEN 'spanish'
    WHEN 'fr' THEN 'french'     WHEN 'french'     THEN 'french'
    WHEN 'de' THEN 'german'     WHEN 'german'     THEN 'german'
    WHEN 'pt' THEN 'portuguese' WHEN 'portuguese' THEN 'portuguese'
    WHEN 'it' THEN 'italian'    WHEN 'italian'    THEN 'italian'
    WHEN 'nl' THEN 'dutch'      WHEN 'dutch'      THEN 'dutch'
    WHEN 'ru' THEN 'russian'    WHEN 'russian'    THEN 'russian'
    WHEN 'sv' THEN 'swedish'    WHEN 'da' THEN 'danish'  WHEN 'no' THEN 'norwegian'
    WHEN 'fi' THEN 'finnish'    WHEN 'tr' THEN 'turkish'
    ELSE 'simple' END)::regconfig
$$;

ALTER TABLE records ADD COLUMN lang varchar(20);

DROP INDEX records_searchable_gin;
ALTER TABLE records DROP COLUMN searchable;
ALTER TABLE records ADD COLUMN searchable tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector(fts_regconfig(lang), coalesce(extracted_title, '')), 'A') ||
    setweight(to_tsvector(fts_regconfig(lang), left(coalesce(extracted_text, ''), 200000)), 'C')
) STORED;
CREATE INDEX records_searchable_gin ON records USING gin (searchable);
