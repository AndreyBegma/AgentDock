# Codex transcript fixtures

Empty on purpose (spec 12 D7). Codex was not installed on the reference
machine, so its transcript format is unknown and nothing is parsed yet: the
adapter reports each session with `parsed: false`.

To fill it in (M4): add a sanitized `rollout-*.jsonl` here, with every piece of
content replaced by a `SENTINEL_` string, as in `../../claude/fixtures/`. Then
write the parser and un-skip the tests in `../codex.spec.ts`.
