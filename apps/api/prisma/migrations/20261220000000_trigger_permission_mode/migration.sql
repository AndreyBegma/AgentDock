-- C-132 (D-13): a trigger's skill action names its own permission mode; a run
-- never takes the project's default, which may be `bypassPermissions`. Give
-- every stored skill action that has none the non-bypass default, `manual`
-- (the runner's `--permission-mode default`). Idempotent: an action that
-- already names a mode stays as it is.

UPDATE "inbound_triggers"
SET "action" = "action" || '{"permissionMode": "manual"}'::JSONB
WHERE "action" ->> 'kind' = 'skill'
  AND NOT ("action" ? 'permissionMode');
