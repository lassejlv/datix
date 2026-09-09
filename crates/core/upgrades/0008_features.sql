-- Optional environment features. Browser vitals are the only feature enabled by default.
ALTER TABLE environments ADD COLUMN feature_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE conversion_goals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    match_type text NOT NULL CHECK (match_type IN ('event','page')),
    match_value text NOT NULL CHECK (char_length(match_value) BETWEEN 1 AND 2048),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(environment_id,match_type,match_value)
);
CREATE INDEX conversion_goals_environment_idx ON conversion_goals(environment_id);
CREATE TABLE goal_conversions (
    goal_id uuid NOT NULL REFERENCES conversion_goals(id) ON DELETE CASCADE,
    environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    event_id uuid NOT NULL,
    received_at timestamptz NOT NULL,
    day date NOT NULL,
    visitor text NOT NULL,
    path text NOT NULL,
    PRIMARY KEY(goal_id,event_id)
);
CREATE INDEX goal_conversions_report_idx ON goal_conversions(environment_id,received_at,goal_id);
CREATE INDEX goal_conversions_retention_idx ON goal_conversions(received_at);

CREATE TABLE diagnostic_events (
    environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    id uuid NOT NULL,
    page_id uuid NOT NULL,
    received_at timestamptz NOT NULL,
    kind text NOT NULL CHECK (kind IN ('error','vital')),
    path text NOT NULL,
    device text NOT NULL,
    visitor text NOT NULL,
    fingerprint text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY(environment_id,id)
);
CREATE INDEX diagnostic_events_report_idx ON diagnostic_events(environment_id,kind,received_at);
CREATE INDEX diagnostic_events_fingerprint_idx ON diagnostic_events(environment_id,fingerprint,received_at);
CREATE INDEX diagnostic_events_retention_idx ON diagnostic_events(received_at);
CREATE TABLE error_resolutions (
    environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    fingerprint text NOT NULL,
    resolved_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(environment_id,fingerprint)
);

CREATE TABLE pulse_monitors (
    environment_id uuid PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
    url text NOT NULL,
    webhook_url text,
    config_version uuid NOT NULL DEFAULT gen_random_uuid(),
    state text NOT NULL DEFAULT 'unknown' CHECK (state IN ('unknown','up','down')),
    failures integer NOT NULL DEFAULT 0,
    checked_at timestamptz,
    next_check_at timestamptz NOT NULL DEFAULT now(),
    last_status integer,
    last_latency_ms integer,
    last_error text,
    changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pulse_monitors_due_idx ON pulse_monitors(next_check_at);
CREATE TABLE pulse_checks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    checked_at timestamptz NOT NULL DEFAULT now(),
    available boolean NOT NULL,
    status_code integer,
    latency_ms integer NOT NULL,
    error text
);
CREATE INDEX pulse_checks_report_idx ON pulse_checks(environment_id,checked_at);
CREATE INDEX pulse_checks_retention_idx ON pulse_checks(checked_at);
CREATE TABLE pulse_alerts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    config_version uuid NOT NULL,
    state text NOT NULL CHECK (state IN ('up','down')),
    created_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    last_error text
);
CREATE INDEX pulse_alerts_due_idx ON pulse_alerts(available_at) WHERE delivered_at IS NULL;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='analytics_runtime') THEN
        GRANT SELECT,INSERT,UPDATE,DELETE ON conversion_goals,goal_conversions,diagnostic_events,error_resolutions,pulse_monitors,pulse_checks,pulse_alerts TO analytics_runtime;
    END IF;
END $$;
