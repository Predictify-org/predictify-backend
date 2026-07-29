-- up
CREATE INDEX IF NOT EXISTS idx_markets_metadata_tags ON markets USING GIN ((metadata->'tags'));

-- down
DROP INDEX IF NOT EXISTS idx_markets_metadata_tags;
