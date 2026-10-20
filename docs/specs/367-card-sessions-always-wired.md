# Every card session carries Nautelle hooks and finish_card

Issue: [#367](https://github.com/AndreyBegma/Nautelle/issues/367)

## Summary

A card session reports to the Board only through the agentdock plugin's
hooks, and finishes only through its `finish_card` tool. Both exist only when
the person has run `agentdock-runner setup claude --profile <key>` for **that
card's** profile. On 2026-10-15:

- C-14 ran on `claude-andriybehma`, which had no plugin, so the Board showed
  "No hook events…" and kept the card Running long after the worker
  answered DONE;
- the owner had set up `claude-blacktoorroot`, a different profile, and saw
  nothing change.

The product owner asked that this always work, with no setup, and that a card
say plainly when something it needs is missing.

## Decisions

- **D1 — The runner injects the plugin's wiring at launch.** For a card
  round (`card.run`), the runner writes a per-round
  `<roundDir>/agentdock-settings.json` holding the same `hooks` block as
  `plugins/agentdock/hooks/hooks.json`. The commands call the runner's
  **absolute** binary path instead of relying on `PATH`. It also writes
  `<roundDir>/agentdock-mcp.json` with the `agentdock` MCP server (`<runner
  binary> mcp`). The launch adds `--settings <file> --mcp-config <file>`.
  The same applies to design turns and the card intake turns of #337, if
  they launch interactive sessions.
- **D2 — No double wiring.** When the round's profile already reports the
  agentdock plugin (the per-profile report of #281 / #297), the runner adds
  neither flag. The plugin already provides both, and hooks would otherwise
  fire twice. The report is read at launch.
- **D3 — What the card says.** The "No hook events" hint (#281 D6) is
  replaced by the actual cause, from the round's launch facts that the runner
  sends with `card_run.started`:
  - `wiring: 'plugin' | 'injected' | 'none'`;
  - and, if `none`, the reason: `runner_outdated`, `settings_write_failed`
    or `claude_too_old`.

  The hint appears only when hooks are expected but none arrived within 2
  minutes of the start. It then names the reason ("The runner is 0.9.2; this
  needs ≥ X. Update the runner", or "Claude Code 2.1.x does not accept
  --settings"), never "set up the plugin".
- **D4 — Terminal and fleet cards** are not launched by the runner, so they
  keep the plugin requirement. Their hint keeps the setup commands, but
  names the profile the session actually runs in, from the session's hook
  facts or its `CLAUDE_CONFIG_DIR`, not "<key>".

## Acceptance criteria

- [ ] A `card.run` on a profile with no agentdock plugin launches with
  `--settings` and `--mcp-config` that point at files in the round directory.
  The settings hold every hook of `hooks.json`, with the runner's absolute
  path. (Unit test over `cardLaunchSpec`.)
- [ ] The same launch on a profile that reports the plugin carries neither
  flag.
- [ ] In a live run on a profile without the plugin:
  - hook events reach the API (the card shows activity);
  - `finish_card` ends the round;
  - the "No hook events" hint does not appear.
- [ ] With injected wiring that failed (stubbed write error), the card shows
  the D3 reason, not the setup commands.
- [ ] A terminal card's hint names its real profile.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i367-runner | D1, D2, launch facts | apps/runner/src/cards/**, apps/runner/src/hooks/**, apps/runner/src/planner/** (launch only), packages/shared/src/protocol/events/cards.ts | — | yes | opus |
| i367-web | D3, D4 hint | apps/web/src/lib/board/format.ts, apps/web/src/components/board/card-sheet.tsx, apps/api/src/board/board-mapper.ts | i367-runner | no | sonnet |

## Risks

- **Medium — `--settings` merges with the profile's own hooks.** Claude Code
  adds hooks from `--settings` to the user's own. A person's own hooks still
  run; only the Nautelle ones are added. Covered by D2 for the double case.
- **Low — a stale runner path in an old round directory after an upgrade.**
  The file is written per round, so a new round uses the new path.

Depends on #281 (closed) · overlaps #359 D2, which this replaces; #359 keeps
the rest.
