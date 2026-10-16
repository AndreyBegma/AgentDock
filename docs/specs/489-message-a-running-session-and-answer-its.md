# C-207: Message a running session and answer its questions from the card, terminal, Telegram and Fleet

Issue: #489

## What
Let a person send a message to a running agent session without taking control of its terminal, and answer an agent's question selector with one click. Today the only ways are "Take control" (admin, raw keystrokes) or a new feedback round.

## Decisions (the person, 2026-10-16)
| # | Decision |
|---|---|
| M1 | **Who:** operator and admin, the same as card feedback. It is text to the agent, never raw keystrokes. Control characters and escape sequences are stripped, length is capped, and every message is audited. |
| M2 | **Where:** the card sheet and the full card page while a round runs; a line under the read-only terminal attach view, so a person can write without Take control; **Telegram** (the agent's question arrives with option buttons, and a reply to the message is sent as text); **fleet slots** on the Fleet page. |
| M3 | **Busy agent:** the message is **queued** in Claude Code itself, the way typing during a turn queues it. The agent reads it at its next step, and the work is never interrupted. |
| M4 | **Question selectors:** the runner reads the question and its options from the pane (the detector from C-194 / #473). The UI shows them as buttons plus an "Other…" field. A click sends the exact selector keys for that option (cursor moves plus Enter, or a typed "Other" answer), never free keystrokes. |
| M5 | **Fleet:** this amends **ADR-0005** (the fleet is observe-only), so a **new ADR** goes in the same PR. A message to a `cs-*` slot is delivered to its pane **and** recorded as a `slot.message_sent` event with `by: person` in the orchestrator's event log, so the orchestrator stays the one who knows what each worker was told. |

## Design notes
- A typed runner command (ADR-0010), e.g. `session.message` with { target: card round | fleet slot, text } or { target, answer: optionIndex | otherText }. It is capability-gated. Delivery uses the existing exact-target tmux paths: `send-keys -l` for the text, then a separate Enter.
- Steward's `session.nudge` is the same mechanism with fixed text, so reuse one delivery path.
- The card view and the fleet slot view expose `pendingQuestion` (text plus options) while a selector is up.
- Telegram: the question notification carries inline buttons, one per option. A reply to the message goes as `session.message`. Telegram linking must be confirmed first (D-16 / security card WI-45).

## Acceptance criteria
- [ ] An operator sends text from the card sheet to a busy card session. It is queued and the agent acts on it next turn. A viewer gets 403.
- [ ] The terminal attach view in read-only mode has a message line that works without Take control.
- [ ] A card whose session shows a question selector displays the options. Clicking option 2 selects option 2 in the pane (runner test with a real pane fixture), and "Other" sends typed text.
- [ ] Telegram: the question arrives with option buttons, and a button press answers it. A text reply is delivered as a message.
- [ ] A fleet slot message reaches the `cs-*` pane and appears in the orchestrator's `events.jsonl` as `slot.message_sent` with `by: person`. There is a new ADR amending ADR-0005.
- [ ] Control characters and escape sequences in a message are stripped (test), the length is capped, and every message has an audit row.
