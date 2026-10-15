# The card's hooks hint knows whether the plugin is set up

## Summary

The #281 D6 hint on a board card ("No hook events from this card's session:
the agentdock plugin is not set up for its runtime profile…") is shown whenever
an active round's session has sent no hook event within `CARD_HOOKS_GRACE_MS`.
It does not look at whether the plugin is actually installed. A person who runs
`agentdock-runner setup claude --profile <key>` keeps seeing the same hint, and
it keeps telling them to run setup. Two things cause this:

1. Claude Code loads plugins when a session starts, so a session that started
   before the setup never sends hooks until it is restarted. The hint is right
   that there are no hooks, but wrong about why.
2. The API learns a profile's plugin state only from `hello`
   (`apps/api/src/runners/runner-ingest.service.ts:61`). After a setup it still
   believes the plugin is missing until the runner reconnects.

This spec makes the runner report the plugin state continuously. The card then
tells "not set up" from "set up, restart this session" from "unknown".

## Scope

### In scope

- The runner reports each Claude profile's `agentdock` state on every heartbeat.
- The API keeps `runners.capabilities` current from those reports.
- The board card view carries why hooks are missing and for which profile.
- The card sheet and the card face tooltip show one of three texts.
- `agentdock-runner setup claude` prints a line about when the change shows up.

### Out of scope

- A **Restart session** action (Q2): the person stops the card and runs it again
  with the existing buttons.
- The Settings › Sessions checklist (#281). It reads the same
  `runners.capabilities` and simply gets fresher data.
- Codex profiles: they have no `agentdock` field.

## Decisions

- **D1: three states, by the round's profile** (person, Q1). The profile is the
  round's `Run.profileKey` [Confirmed: `apps/api/src/board/board-rounds.service.ts`
  writes it on the run]. Its state is `profileAgentdockOf(runner.capabilities)[key]`
  [Confirmed: `packages/shared/src/setup/agentdock-report.ts:45`, already used by
  `apps/api/src/terminal-setup/terminal-setup.service.ts:117`].
  - `no_plugin`: the profile is reported with `agentdock.plugin === null`.
  - `session_predates`: the profile is reported with a plugin version.
  - `unknown`: the run has no `profileKey`, the runner reports no such profile,
    or the profile has no `agentdock` field (an older runner, ADR-0006 mirror).
- **D2: the texts** (person, Q1, Q4). They live in `apps/web/src/lib/board/format.ts`,
  and the sheet and the face tooltip both use them.
  - `no_plugin`: "No hook events from this card's session: the agentdock plugin
    is not set up for the profile `<key>`, so the card moves only when the
    session ends or you mark it finished." It is followed by the command
    `agentdock-runner setup claude --profile <key>` with the key filled in, the
    line "then restart its sessions", and the existing link to Settings ›
    Sessions. The `agentdock-runner profiles` step is dropped, because the key
    is known.
  - `session_predates`: "The agentdock plugin is set up for `<key>`, but this
    session sent no hook events — it started before the setup. Stop the card
    and run it again to get live status." No setup commands are shown.
  - `unknown`: today's `hooksHint` and `HOOKS_COMMANDS`, unchanged.
- **D3: no restart action** (person, Q2). The text is the whole change.
- **D4: the runner reports on every heartbeat** (person, Q5 and transport).
  - `heartbeat` gains an optional field `profiles`: a record from a Claude
    profile id to `profileAgentdockSchema` (`{ plugin, telemetry }`).
  - The daemon fills it on every heartbeat, every `HEARTBEAT_INTERVAL_MS`
    (15 s), by calling `readProfileAgentdock` for each Claude profile. That call
    reads two JSON files and runs no binary [Confirmed:
    `apps/runner/src/detect/capabilities.ts:151`].
  - It is sent every time, not only on change, so a lost heartbeat heals on the
    next one and the daemon keeps no "last sent" state.
  - Any way of installing or removing the plugin is picked up: `setup`,
    `claude plugin install` or `uninstall`, or a hand-edited `settings.json`.
- **D5: older peers are unaffected.** `heartbeatMessageSchema` is a plain
  `z.object`, so an older API strips the unknown field [Confirmed:
  `packages/shared/src/protocol/messages.ts:44`]. An older runner sends no
  `profiles`, and the API then keeps what `hello` stored.
- **D6: the API merges, and writes only on change.**
  `RunnerIngestService.heartbeat` merges the reported `agentdock` into
  `runners.capabilities.profiles[i].agentdock` by profile id. A reported id
  that is not among the stored profiles is ignored, since `hello` owns the
  profile list. The JSON is written only when a value differs, and that write
  happens in the same update as `lastSeenAt`.
- **D7: setup does not talk to the daemon** (person, Q6 superseded by D4).
  After a successful profile setup, `agentdock-runner setup claude` prints:
  "A running agentdock-runner reports this within 15 seconds. Sessions started
  before now need a restart to load the plugin." The exit code is unchanged.
- **D8: no new ADR.** This extends an existing message within protocol v1. It is
  recorded in `docs/architecture/runner-protocol.md` § `heartbeat`. ADR-0001
  holds: the runner reads the profile directories, and the control plane only
  stores what is reported.

## API

`packages/shared/src/board/contracts.ts`, on the round brief (line 52) and the
round detail (line 191), next to `hooksMissing`:

```ts
/** #348 D1: why hooks are missing; null when `hooksMissing` is false. */
hooksCause: 'no_plugin' | 'session_predates' | 'unknown' | null;
/** #348 D1: the round's profile key, when known. */
hooksProfile: string | null;
```

`hooksMissing` keeps its meaning (#281 D6), so a client that reads only it
behaves as before.

`packages/shared/src/protocol/messages.ts`, `heartbeatMessageSchema`:

```ts
/** #348 D4: each Claude profile's agentdock state, read this heartbeat. */
profiles: z.record(z.string().min(1), profileAgentdockSchema).optional(),
```

## UI

- `apps/web/src/components/board/card-sheet.tsx:163` and `:460`: choose the
  text and the commands by `hooksCause`.
- `apps/web/src/components/board/card-face.tsx:110`: the tooltip shows the
  same text.

## Acceptance criteria

- [ ] Runner: every heartbeat carries `profiles` with one entry per Claude
  profile. A plugin installed into a profile's `installed_plugins.json` shows
  in the next heartbeat with its version, and a removed one shows as `null`
  (unit test with a temporary `CLAUDE_CONFIG_DIR` and a fake clock).
- [ ] Runner: a Codex profile is never in `profiles`.
- [ ] API: a heartbeat with a changed `profiles` updates
  `runners.capabilities.profiles[].agentdock`. An identical one writes nothing
  beyond `lastSeenAt`, and an unknown profile id is ignored (e2e).
- [ ] API: a heartbeat without `profiles` leaves the stored capabilities
  untouched (e2e).
- [ ] API: a card in an active round past the grace with no hooked session gets
  `hooksCause = 'no_plugin'` when the round's profile reports
  `plugin: null`, `'session_predates'` when it reports a version, and
  `'unknown'` when the run has no `profileKey` or the profile has no
  `agentdock`. `hooksProfile` is the run's `profileKey` (mapper unit tests).
- [ ] API authorization: the board card view of project A never carries the
  `hooksProfile` of a card in project B. The existing board membership e2e is
  extended to assert the field.
- [ ] Web: each `hooksCause` renders its D2 text in the sheet and the face
  tooltip. `no_plugin` shows the setup command with the key filled in and no
  `<key>` placeholder, and `session_predates` shows no command (`format.test.ts`
  and component tests).
- [ ] CLI: `agentdock-runner setup claude --profile <key>` prints the D7 line on
  success (setup unit test).
- [ ] `docs/architecture/runner-protocol.md` § `heartbeat` documents `profiles`
  with an example.
- [ ] Manual: a card runs on a profile without the plugin and shows `no_plugin`.
  After `setup claude --profile <key>`, within about 15 s and with no runner
  restart, it shows `session_predates`. After Stop and Run, the hint is gone.

## Parallel plan

| Slot | Owns | Touches | Depends on | Lead | Model |
|---|---|---|---|---|---|
| i348-contract | heartbeat field, board view fields, protocol doc, compile stubs | packages/shared/src/protocol/messages.ts, packages/shared/src/protocol/messages.spec.ts, packages/shared/src/board/contracts.ts, docs/architecture/runner-protocol.md, apps/api/src/board/board-mapper.ts | — | yes | sonnet |
| i348-runner | the heartbeat report and the setup line | apps/runner/src/daemon.ts, apps/runner/src/detect/**, apps/runner/src/setup/** | i348-contract | no | sonnet |
| i348-api | the merge on heartbeat and `hooksCause` | apps/api/src/runners/runner-ingest.service.ts, apps/api/src/runners/runner.gateway.ts, apps/api/src/runners/*.e2e.spec.ts, apps/api/src/board/board-mapper.ts, apps/api/src/board/board.service.ts, apps/api/src/board/*.spec.ts | i348-contract | no | sonnet |
| i348-web | the three texts | apps/web/src/lib/board/format.ts, apps/web/src/lib/board/format.test.ts, apps/web/src/components/board/card-sheet.tsx, apps/web/src/components/board/card-face.tsx | i348-contract | no | sonnet |

The contract slot sets `hooksCause: null, hooksProfile: null` in the mapper so
the API compiles. The api slot replaces that in the next wave, so the two never
write the mapper at the same time.

## Contention

| Resource | Owner | Everyone else |
|---|---|---|
| packages/shared/src/protocol/messages.ts | i348-contract | do not open it |
| packages/shared/src/board/contracts.ts | i348-contract | do not open it |
| apps/api/src/board/board-mapper.ts | i348-contract (stub), then i348-api | web and runner never open it |

No schema change and no migration: `runners.capabilities` is already JSON.

## Risks

- **Medium:** a DB write per heartbeat if the merge compares carelessly, for
  example JSON key order. Mitigation: compare the parsed `agentdock` values per
  profile, write only on a real difference, and assert this in the e2e test.
- **Low:** `installed_plugins.json` read mid-write by Claude. `readAgentdockPlugin`
  already answers null on a parse failure, so one heartbeat may flip to
  `no_plugin` for 15 s. Accepted: the next heartbeat corrects it.
- **Low:** `session_predates` is also shown when the plugin is installed but
  hooks fail for another reason, such as the daemon's local socket being down.
  The text still points at the action most likely to help (a restart).

## Open questions

None. Q1–Q6 and the transport were answered by the person.

Depends on #281
