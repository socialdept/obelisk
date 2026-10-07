-- The CID each event recorded. Before this, emitters joined records and
-- reported the record's current CID for every event, so a stale event carried a
-- newer version's CID and body. Rows written before this migration stay null and
-- fall back to the record's CID.
ALTER TABLE events ADD COLUMN cid varchar(255);
