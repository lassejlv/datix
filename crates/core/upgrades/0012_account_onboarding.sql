CREATE TABLE account_onboarding (
    owner_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    completed_at timestamptz NOT NULL DEFAULT now()
);

-- Existing workspaces have already passed the initial website setup.
INSERT INTO account_onboarding (owner_id)
SELECT DISTINCT owner_id FROM sites;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_runtime') THEN
        GRANT SELECT, INSERT ON account_onboarding TO analytics_runtime;
    END IF;
END
$$;
