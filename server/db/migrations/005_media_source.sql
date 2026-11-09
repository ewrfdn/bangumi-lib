-- v5: optional metadata source and its reference URL.
ALTER TABLE media ADD COLUMN data_source TEXT;
ALTER TABLE media ADD COLUMN data_source_url TEXT;
