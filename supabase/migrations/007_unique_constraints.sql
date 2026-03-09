-- Required for upsert operations in import scripts
CREATE UNIQUE INDEX IF NOT EXISTS idx_officials_bioguide ON officials(bioguide_id) WHERE bioguide_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_law_sources_source_url ON law_sources(source_url) WHERE source_url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agencies_slug ON agencies(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_offices_slug_jurisdiction ON offices(slug, jurisdiction_id);
