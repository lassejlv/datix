CREATE TABLE overview_annotations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    day date NOT NULL,
    label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX overview_annotations_environment_day_idx ON overview_annotations(environment_id,day);
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='analytics_runtime') THEN
        GRANT SELECT,INSERT,UPDATE,DELETE ON overview_annotations TO analytics_runtime;
    END IF;
END $$;
