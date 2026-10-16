# C-48: Decide the open questions left as defaults

## What to do
These specs shipped with an open question answered by a default. Confirm or change each:
- #322 Q1: no per-project switch for the haiku model assessment; the budget hard stop is the brake. Add `assessEnabled`?
- #322 A1: `fable` can be selected but is never recommended.
- #324 Q1: DeepL target is `EN-US`.
- #337 Q1: an intake that turns out to be several tasks says so in Open questions rather than becoming a plan.
- #337 Q2: no "design first" suggestion on generated cards.
- #353: writes are never retried automatically after an API restart.

## Acceptance criteria
- [ ] Each question is confirmed, or turned into a card that changes it.

## Out of scope
- Implementing the changes here.
