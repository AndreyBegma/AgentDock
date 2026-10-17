# ADR-0061: A design revise sends only the frames it changes

Status: accepted · Date: 2026-10-18 ·
Issue: [#628](https://github.com/AndreyBegma/AgentDock/issues/628) ·
Amends [ADR-0041](0041-a-design-revision-holds-named-frames.md) §5 and
[ADR-0025](0025-a-design-has-one-owner-a-plan-task-or-a-board-card.md)

## Context

A design turn — a plan task's, a board card's or a stack's — ran in its
owner's design session and resumed it on every turn. A revise therefore read
back every turn the design had had: each variant's HTML, each earlier
revision's HTML, and the UI profile's kit and snippets once per turn. Revises
are paced by people leaving comments, so the prompt cache had long expired by
then and all of it was billed as fresh input. ADR-0041 §5 also made a revise
redraw every frame of the variant, so the frames no comment touched were
written out again.

Images the person attached to a New work intake reached the model at the size
they were uploaded, although Claude scales every image down to about 1568 px
on its longest edge and 1.15 megapixels before it counts its tokens.

## Decision

1. **A revise runs in a session of its own.** Its `plan.turn` starts a new
   session (`--session-id`, never `--resume`). The owner's design session
   (`designSessionId`, a task's `sessionId`) is left as it was; Generate turns
   keep resuming it, so the variants of one batch still see each other.
2. **A revise's prompt carries the previous revision itself**: the frames an
   open comment left on this variant points at, in full, and one line per
   other frame — its size, its `<title>` and its first headings. When no
   comment of the variant points at a frame, every frame is sent in full. A
   prompt over the `plan.turn` cap summarizes every frame, after the
   snippets and a stack's reference HTML.
3. **A design turn may keep frames.** The plan block's optional `kept` names
   frames of `frames` left exactly as the previous revision drew them; they
   have no design block, and the API copies their HTML from that revision
   when it validates the turn. A kept name the previous revision lacks, or one
   `frames` does not list, fails the turn (`frame_mismatch`). The shape
   stays the same under every contract version. ADR-0041 §5 now reads:
   Revise acts on the whole revision — every frame is in the new revision —
   but draws only those it changes.
4. **What stays the same from turn to turn of a design comes first** in its
   prompt — instructions, contract, owner, reference design, UI profile,
   skills — and the turn's action, variant, previous revision and comments
   last.
5. **A plan or design turn reads attached images at the model's size.** The
   runner scales a PNG, JPEG or WebP it syncs into a plan worktree to at most
   1568 px on the longest edge and 1.15 megapixels, re-encodes it in its own
   format (so the file name still says its type), and re-encodes it more
   compactly when it is still over 1 MiB. A GIF or a file that does not
   decode is left as it is. A card's worktree keeps the originals: its
   worker may commit one.

## Consequences

- A revise loses the code its owner's session had read; its prompt holds
  what it needs to redraw, and it may read the code again.
- A frame given only as a summary can still be redrawn, from the summary and
  the profile, when a comment asks for it.
- The runner keeps `.agentdock/attachments-model.json` beside a plan
  worktree's attachments, so a scaled image is not downloaded on every turn.
- Every design launch already goes through the one Token saver wiring helper
  (#445): design turns as `plan.turn`, profile builds as `uiprofile.build`.
