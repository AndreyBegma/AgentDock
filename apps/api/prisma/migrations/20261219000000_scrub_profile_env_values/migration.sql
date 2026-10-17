-- C-123 (ADR-0006): a runtime profile's env is reported names only. Strip the
-- values runners sent before the fix: every name outside the allowlist of
-- paths (CLAUDE_CONFIG_DIR, CODEX_HOME) becomes {"set": true}, and an env that
-- is not an object becomes {}. Idempotent: a scrubbed env stays as it is.

CREATE FUNCTION pg_temp.scrub_profile_env(env JSONB) RETURNS JSONB
LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(env) IS DISTINCT FROM 'object' THEN '{}'::JSONB
    ELSE COALESCE(
      (
        SELECT jsonb_object_agg(
          entry.key,
          CASE
            WHEN entry.key IN ('CLAUDE_CONFIG_DIR', 'CODEX_HOME')
              AND jsonb_typeof(entry.value) = 'string'
            THEN entry.value
            ELSE '{"set": true}'::JSONB
          END
        )
        FROM jsonb_each(env) AS entry
      ),
      '{}'::JSONB
    )
  END
$$;

UPDATE "runtime_profiles"
SET "env" = pg_temp.scrub_profile_env("env")
WHERE "env" IS DISTINCT FROM pg_temp.scrub_profile_env("env");

UPDATE "runners"
SET "capabilities" = jsonb_set(
  "capabilities",
  '{profiles}',
  (
    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN jsonb_typeof(profile.value) = 'object'
            AND profile.value ? 'env'
          THEN jsonb_set(
            profile.value,
            '{env}',
            pg_temp.scrub_profile_env(profile.value -> 'env')
          )
          ELSE profile.value
        END
        ORDER BY profile.ordinality
      ),
      '[]'::JSONB
    )
    FROM jsonb_array_elements("capabilities" -> 'profiles')
      WITH ORDINALITY AS profile(value, ordinality)
  )
)
WHERE jsonb_typeof("capabilities" -> 'profiles') = 'array';

DROP FUNCTION pg_temp.scrub_profile_env(JSONB);
