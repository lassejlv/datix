-- Keep provider aggregates separate from collection, billing, abuse and visitor records.
ALTER TABLE environments ADD COLUMN import_revision bigint NOT NULL DEFAULT 0;

CREATE TABLE analytics_imports (
    id uuid PRIMARY KEY,
    environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('plausible','ga4')),
    source_timezone text NOT NULL,
    fingerprint text NOT NULL,
    summary jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(environment_id,fingerprint),
    UNIQUE(environment_id,id)
);
CREATE INDEX analytics_imports_environment_idx ON analytics_imports(environment_id,created_at);

CREATE TABLE imported_daily_stats (
    environment_id uuid NOT NULL,
    day date NOT NULL,
    import_id uuid NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
    pageviews bigint NOT NULL CHECK (pageviews >= 0),
    visitors bigint NOT NULL CHECK (visitors >= 0),
    custom_events bigint NOT NULL CHECK (custom_events >= 0),
    PRIMARY KEY(environment_id,day),
    FOREIGN KEY(environment_id,import_id) REFERENCES analytics_imports(environment_id,id) ON DELETE CASCADE
);
CREATE INDEX imported_daily_stats_import_idx ON imported_daily_stats(import_id);
CREATE INDEX imported_daily_stats_retention_idx ON imported_daily_stats(day);

CREATE TABLE imported_breakdowns (
    environment_id uuid NOT NULL,
    day date NOT NULL,
    dimension text NOT NULL CHECK (dimension IN ('path','referrer','country','device','event')),
    value text NOT NULL,
    count bigint NOT NULL CHECK (count >= 0),
    PRIMARY KEY(environment_id,day,dimension,value),
    FOREIGN KEY(environment_id,day) REFERENCES imported_daily_stats(environment_id,day) ON DELETE CASCADE
);
CREATE INDEX imported_breakdowns_retention_idx ON imported_breakdowns(day);

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='analytics_runtime') THEN
        GRANT SELECT,INSERT,UPDATE,DELETE ON analytics_imports,imported_daily_stats,imported_breakdowns TO analytics_runtime;
    END IF;
END $$;
