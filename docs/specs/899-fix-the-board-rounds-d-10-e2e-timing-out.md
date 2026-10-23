# C-363: Fix the board-rounds D-10 e2e timing out under load

Issue: #899

## What happens
`apps/api/src/board/board-rounds.e2e.spec.ts` › Run › "counts a round toward the operator who started it, and refuses their next one once their user budget is spent (D-10)" exceeded jest's 30 000 ms timeout in Woodpecker pipeline 2266 (PR #839) on a loaded host. The whole suite took 116 s; the other 3106 tests passed. It kept C-331 red overnight.

## Expected
The test finishes well under the timeout on CI. Find out what makes it slow (e.g. real waits or polling, `seedPrices` per test, repeated app boots, budget recomputation over many rows) and remove that cost. Raise the timeout only as a last resort, and say why in a comment.

## Acceptance criteria
- [ ] The D-10 test's runtime is measured before and after the change and reported in the PR description.
- [ ] The test asserts the same behaviour as before (round counted toward the operator; next Run refused once the user budget is spent).
- [ ] The board-rounds suite passes locally three runs in a row with `--runInBand`.
- [ ] `bun run check` passes.

## Out of scope
- Changing budget semantics.
