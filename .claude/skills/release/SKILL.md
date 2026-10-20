---
name: release
description: Cut an AgentDock product release — collect the pull requests merged into develop since the last vX.Y.Z tag, classify them, choose the version, write the changelog entry and the release note, land them on develop, promote develop to main and tag the release
---

# Release

You are the release editor and the release engineer for AgentDock.

The person says "cut a release" (or runs `/release`) and you take it from
there: work out what shipped since the last release, write it down for the
people who use AgentDock, land the version on `develop`, promote `develop` to
`main`, and tag it. The process is recorded in
[ADR-0071](../../../docs/adr/0071-the-product-is-released-by-version-with-a-changelog-and-release-notes.md);
read it if anything here seems to contradict the code.

You are a writer as much as an engineer. The changelog is read on the What's
new page by the people who run agent fleets with AgentDock, not by the people
who build it.

## What a release consists of

| Piece | Where | Written by |
|---|---|---|
| The changelog entry | `packages/shared/src/changelog.ts`, top of `CHANGELOG` | this skill |
| The version | `APP_VERSION`, derived from the first entry — there is no second place | nobody |
| The release note | `docs/releases/vX.Y.Z.md` | this skill |
| The index row | `docs/releases/README.md`, top of the table | this skill |
| The release branch | `release/vX.Y.Z` → `develop` | this skill |
| The promotion | `develop` → `main` | this skill |
| The tag | `vX.Y.Z` on `main`'s merge commit | this skill, after the merge |

Repository: `AndreyBegma/AgentDock`. Run every command from the repository
root.

**The runner is not part of a product release.** It has its own version in
`apps/runner/package.json`, its own `runner-vX.Y.Z` tags (protected, signed,
ADR-0049) and its own notes in `apps/runner/CHANGELOG.md`. Never bump, tag or
edit any of them here. A product release only *names* a runner release that
shipped in its window (Step 2).

## Argument

`/release` — release everything merged since the last tag.
`/release dry` — do Steps 0 to 5 and show the result; change nothing.

---

## Step 0 — The plan, before anything happens

Run this first, always, and show the result before you touch anything.

```bash
git fetch origin --tags --quiet
LAST=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)
echo "last release tag: ${LAST:-none}"
gh api repos/AndreyBegma/AgentDock/compare/main...develop --jq '"develop is \(.ahead_by) commits ahead of main"'
gh pr list --repo AndreyBegma/AgentDock --state open --base main --json number,title
gh pr list --repo AndreyBegma/AgentDock --state open --head 'release/' --json number,title,headRefName
```

Report, in this order:

1. **The last release tag** and the version in `CHANGELOG[0]`. They must
   agree. If `CHANGELOG[0]` is newer than the last tag, a release was landed
   on `develop` but never promoted or tagged: **stop** and offer to finish
   that release (Step 7 onward) instead of starting a new one.
2. **How far `develop` is ahead of `main`.** Zero means there is nothing to
   promote: stop.
3. **Open release or promotion pull requests.** One already open means a
   release is in flight: stop and name it.
4. **Migrations in the window.** A deploy of `main` applies them:
   ```bash
   gh api repos/AndreyBegma/AgentDock/compare/main...develop \
     --jq '[.files[].filename | select(startswith("apps/api/prisma/migrations/"))] | unique'
   ```
5. **New environment variables in the window**, from the committed examples:
   ```bash
   gh api repos/AndreyBegma/AgentDock/compare/main...develop \
     --jq '.files[] | select(.filename | test("\\.env\\.example$")) | .patch' \
     | grep -oE '^\+[A-Z][A-Z0-9_]*=' | tr -d '+=' | sort -u
   ```

Points 4 and 5 do not stop the release; they go into the release pull
request's body under **Before deploying**, so whoever deploys `main` sees
them.

Then continue unless one of the stops above applied.

---

## Step 1 — Collect the pull requests since the last tag

The window is every pull request merged into `develop` after the last tag's
commit landed on `develop`. Take its date from the tagged commit:

```bash
SINCE=$(git log -1 --format=%cI "$LAST")
gh pr list --repo AndreyBegma/AgentDock --state merged --base develop \
  --search "merged:>$SINCE" --limit 200 \
  --json number,title,mergedAt,url,body,files \
  --jq 'sort_by(.mergedAt)[] | "#\(.number)\t\(.title)\t\(.url)"'
```

With no tag yet (only the very first release, `v0.14.0`), the window started at
the last promotion to `main`.

`git log --first-parent` subjects on `develop` read "Merge pull request #N
from …", which says nothing; always work from the pull request titles and
bodies. For any pull request whose title does not make the user-visible effect
obvious, read its body, its card's spec under `docs/specs/`, and if needed its
diff (`gh pr diff <N>`). Never invent an effect you have not confirmed.

Skip release pull requests (`release/v*`) and promotions (`develop` → `main`)
themselves.

---

## Step 2 — Look for a runner release in the window

```bash
git tag --list 'runner-v*' --sort=-v:refname \
  --format='%(refname:short) %(creatordate:iso-strict)' | head -5
```

A `runner-v*` tag created after `$SINCE` is a runner release in this window.
Read its section in `apps/runner/CHANGELOG.md` and, if it carries something a
person notices (an upgrade note above all), mention it in one changelog item
("The runner 0.14.0 …") and in the note's **Runner** section.

A product change that only works once the runner ships its side — the
runner's part sits under "Unreleased" in `apps/runner/CHANGELOG.md` — is
**held**: classify it as held for the next runner release, leave it out of
the items, and list it in the release that names that runner release.

---

## Step 3 — Classify

Each pull request is exactly one of:

- **new** — something a person can now do that they could not before.
- **improved** — a better version of something that already worked: faster,
  clearer, fewer steps, a better layout.
- **fixed** — something that was broken for a person and now is not.
- **excluded** — everything else. Not negotiable:
  - CI, pipelines, Woodpecker, Docker, deployment, staging;
  - dependency bumps, lockfiles, build and tooling configuration;
  - refactors with no visible effect;
  - tests, test infrastructure, flaky-test fixes;
  - documentation only: specs, ADRs, guides, design mockups, research;
  - skills, Claude and Code Sentinel configuration;
  - security hardening with no user-visible change (a visible one — a new
    prompt, a refusal a person now sees — is classified like any change).
- **held** — user-visible, but waiting on an unreleased runner (Step 2).

When in doubt, ask whether an operator using the web app, the Telegram bot or
the runner CLI would notice. If not, exclude it.

Write the classification down; it goes into the note and the pull request
body, which is where a wrong call gets caught.

---

## Step 4 — Choose the version

Read the current version from `CHANGELOG[0].version`. The product is on 0.x:

- At least one **new** item → **MINOR + 1**, PATCH 0 (`0.14.3` → `0.15.0`).
  An **improved** item a person would call a feature counts as new here.
- Only **fixed** (and **improved** polish) items → **PATCH + 1**
  (`0.14.0` → `0.14.1`).
- Nothing survived Step 3 → **no release**. Tell the person and stop. Do not
  open an empty pull request; a quiet window is a correct outcome.

Moving to `1.0.0` is the person's decision and is never made by this skill.

---

## Step 5 — Write the entry and the note

### The changelog entry

Three to eight items. Fewer is better than padding. Each item:

- is one sentence, starting with a capital and ending with a full stop, with
  no semicolon stapling two changes together;
- says what a person can now do, not what was implemented.
  Good: "A card waits to run until every card it depends on has a ready pull
  request." Bad: "Added isDependencySatisfied to the board service.";
- carries no pull request numbers, card ids (`C-12`), file, component or
  endpoint names, and no internal vocabulary (DTO, guard, gateway, sink);
- merges several pull requests into one line when they are one thing to a
  person — five redesigned pages are one line, not five.

Order: `new`, then `improved`, then `fixed`. The shared test
(`packages/shared/src/changelog.spec.ts`) enforces the count, the order, the
sentence shape, the version order and the absence of ids.

Insert the entry at the **top** of `CHANGELOG`, dated today (`YYYY-MM-DD`).
Never edit an older entry, not even a typo: a released entry is history, and
the next release can say it better.

### The release note

`docs/releases/vX.Y.Z.md`, in this shape (see `docs/releases/v0.14.0.md`):

```markdown
# AgentDock vX.Y.Z

Released YYYY-MM-DD · Runner: <the runner version current at release, and
whether it changed in this window> · Changelog entry: `packages/shared/src/changelog.ts`

## Summary

<One paragraph: the theme of the release in plain words, and anything a person
must do (an upgrade, a new setting).>

## What changed

### New
### Improved
### Fixed

<The items, exactly as in the changelog. Omit an empty heading.>

## Merged pull requests

| PR | Title | Classified as |
|---|---|---|
| [#N](https://github.com/AndreyBegma/AgentDock/pull/N) | <title> | new / improved / fixed / excluded (<why>) / held for the next runner release |

## Runner

<The runner release of the window with a link to its GitHub release, or "No
runner release shipped in this window.", and any held change.>
```

Every pull request of the window is in the table, excluded ones included.

Then add the release to the top of the table in `docs/releases/README.md`:
`| [vX.Y.Z](vX.Y.Z.md) | YYYY-MM-DD | <one-line summary> |`.

In `dry` mode, show the entry, the note and the classification here and stop.

---

## Step 6 — Check

```bash
bun run --cwd packages/shared test
bun run check
```

Both must pass. A failing `changelog.spec.ts` means the entry breaks a rule
above: fix the entry, not the test.

---

## Step 7 — Land the release on `develop`

Never commit to `develop` directly.

```bash
git checkout develop && git pull --ff-only origin develop
git checkout -b release/vX.Y.Z
git add packages/shared/src/changelog.ts docs/releases/
git commit -m "Release vX.Y.Z

<One line naming the release's theme.>"
git push -u origin release/vX.Y.Z
gh pr create --repo AndreyBegma/AgentDock --base develop --head release/vX.Y.Z \
  --title "Release vX.Y.Z" --body-file <body>
```

The body holds the entry as a person will read it, the classification table
and the version reasoning ("MINOR: two new items"), so a reviewer can check
that nothing user-facing was dropped and nothing internal leaked in. No
Claude attribution trailer or footer, in the commit or the body.

Wait for its checks:

```bash
gh pr checks <N> --repo AndreyBegma/AgentDock --watch
```

Green: merge it (`gh pr merge <N> --merge`). Red: **stop**, report the
failing check, and open no promotion. A promotion *is* `develop`; a release
entry that has not landed on `develop` cannot be in it.

---

## Step 8 — Promote `develop` to `main`

```bash
gh pr create --repo AndreyBegma/AgentDock --base main --head develop \
  --title "Release vX.Y.Z" --body-file <body>
```

No new branch: the promotion is `develop` itself. The body is the entry as a
person reads it, a link to `docs/releases/vX.Y.Z.md`, and a **Before
deploying** section with the migrations and environment variables of Step 0
(or "No migrations and no new environment variables.").

Wait for its checks with `gh pr checks <N> --watch`. A push to `main` runs the
full suite. Green: merge it with a merge commit (`gh pr merge <N> --merge`),
as every promotion so far. Red: **stop** and report; the release branch has
already landed on `develop`, so say that the release is landed but not
promoted, and that Step 0's first stop will offer to finish it.

---

## Step 9 — Tag

After the promotion merged, tag `main`'s merge commit:

```bash
git fetch origin main --quiet
SHA=$(gh pr view <N> --repo AndreyBegma/AgentDock --json mergeCommit --jq .mergeCommit.oid)
git tag -a vX.Y.Z "$SHA" -m "AgentDock vX.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --repo AndreyBegma/AgentDock --verify-tag \
  --title "AgentDock vX.Y.Z" --notes-file docs/releases/vX.Y.Z.md --latest=false
```

`--latest=false` keeps the runner's release as the repository's latest, which
is what a person downloading the runner from the releases page expects. A
`vX.Y.Z` tag triggers no pipeline (the release pipeline matches `runner-v*`
only).

Never move or delete a pushed tag. A wrong release is followed by a new
PATCH release.

---

## If anything fails part-way

Stop. Do not retry silently and do not "get the rest in". Report what landed,
in this shape:

```
landed:      release/vX.Y.Z into develop (#N, merged)
not landed:  develop → main (#M open, checks red)
not tagged:  vX.Y.Z
```

Then give the exact commands that finish it by hand. Never describe a partial
release as a release.

## Report

Tell the person:

- the new version and the window it covers (from the last tag's date to now);
- the entry as they will read it on What's new;
- what was excluded and held, and why, in one line each;
- the migrations and environment variables the deploy of `main` needs;
- every pull request URL and which are merged, and the tag;
- anything that made you unsure.

## Never

- Release a window with nothing user-visible.
- Edit, reorder or remove a released changelog entry or release note.
- Change the version anywhere but by adding an entry.
- Commit to `develop` or `main` directly, or force-push either.
- Open the promotion before the release branch merged into `develop`.
- Bump, tag or edit the runner's version or `apps/runner/CHANGELOG.md`.
- Move, delete or re-push a `vX.Y.Z` tag.
- Put implementation detail, ids or pull request numbers in a changelog item.
