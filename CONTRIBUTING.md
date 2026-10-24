# Contributing to Nautelle

Thank you for helping. This page is the short version; the engineering source of
truth is [`docs/`](docs/README.md) and the conventions every contributor and
agent follows are in [`CLAUDE.md`](CLAUDE.md) and
[`docs/guides/agent-rules.md`](docs/guides/agent-rules.md).

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). To report
a vulnerability, do not open an issue: follow [`SECURITY.md`](SECURITY.md).

## Set up

You need [Bun](https://bun.sh) 1.4.0 or newer, Node.js 24 or newer and Docker.

```sh
git clone https://github.com/AndreyBegma/Nautelle && cd Nautelle
bun install
cp apps/web/.env.example apps/web/.env
bun run db:setup       # PostgreSQL and Redis from docker/docker-compose.yml, migrations, seed
bun run admin:create   # the first admin
bun run start:dev      # API http://localhost:8180, web http://localhost:3517
```

`bun run db:setup` writes `docker/.env` and `apps/api/.env` with generated
passwords. Both files are git-ignored. Use Bun only; never `npm install` or
`yarn`.

## Before you open a pull request

| Command | When |
|---|---|
| `bun run check` | Always. Biome lint, format and import order, plus the repository's own checks (CI, images, pins, brand, ADR and migration numbering). It writes nothing. |
| `bun run test` | Always. Jest in `apps/api`, `bun test` in the runner and shared packages. |
| `bun run --cwd apps/api test:e2e --testPathPatterns <file>` | When you touched code an e2e suite covers. Run only that suite; CI runs the rest. |
| `bun run check:secrets` | When you added anything that looks like a key, token or password. |

A bug fix comes with the test that would have caught it. TypeScript is strict
and `any` is not allowed. A new environment variable goes into the matching
`.env.example` in the same change.

## Branches and pull requests

- Branch from `develop` and open the pull request **into `develop`**. `main` is
  for releases ([ADR-0071](docs/adr/0071-the-product-is-released-by-version-with-a-changelog-and-release-notes.md)).
- Keep a pull request to one change. Say what changed and why; link the issue.
- Fill in the pull request template, including how you checked the change.
- Paths that decide what CI, deploys and plugins run (`.woodpecker/`, `deploy/`,
  `plugins/`, `docker/`, `.github/`) need a review from a code owner
  ([`CODEOWNERS`](.github/CODEOWNERS), [ADR-0077](docs/adr/0077-runner-pushes-follow-a-branch-policy-and-protected-paths-need-a-person.md)).
  Such a pull request is never merged automatically.

## Commits

Write the subject in the imperative, in English, short, with an optional scope
prefix: `fix(api): wait for GitHub to show the pushed head`,
`docs(adr): ADR-0086, a card PR is read only once GitHub shows the pushed head`.
Reference the issue or card in the subject or body (`#895`). Commit as you go;
do not rewrite history that is already pushed.

## Decisions: ADRs and specs

- **Architectural change → a new ADR in the same pull request.** Copy the shape
  of a recent file in [`docs/adr/`](docs/adr/README.md), take the next number
  **from `origin/develop`**, not from your branch (`bun run check` fails on a
  duplicate number), and never rewrite an accepted ADR; supersede it with a new
  one. Read the ADRs that touch the area first. Two that every change must
  respect: the control plane never reads a project's filesystem
  ([ADR-0001](docs/adr/0001-control-plane-and-per-machine-runner.md)) and the
  runner accepts typed commands only
  ([ADR-0010](docs/adr/0010-typed-command-allowlist-on-the-runner.md)).
- **A feature starts as a spec** in [`docs/specs/`](docs/specs/) with
  acceptance criteria, then an issue. For anything bigger than a small fix,
  open an issue or a spec pull request and agree on the shape before you write
  the code.
- Everything in the repository, code, comments, docs and commits, is in English.

## Conventions worth knowing

- **UI uses glass-ui only** ([ADR-0011](docs/adr/0011-glass-ui-is-the-component-library.md),
  [`docs/ui/glass-ui.md`](docs/ui/glass-ui.md)). A component that is missing is
  added to glass-ui, not written inside the app.
- **Prisma is imported only by `apps/api`**, through `PrismaService`. The web
  app talks to the API over HTTP. Schema changes go through
  `bun run db:migrate` with a descriptive name; never edit an applied migration.
- **Shared types and pure helpers** go in `packages/shared`, which stays
  framework-free.
- **API input** is always a DTO with `class-validator` decorators; the global
  `ValidationPipe` rejects unknown fields.
- **Biome** is the only linter and formatter: single quotes, trailing commas,
  two spaces.

## How agent-written pull requests are reviewed

Much of Nautelle is built by its own card workers, so pull requests from an
agent are common and are held to the same bar as yours.

- A card worker opens a draft pull request, fixes red CI itself (up to three
  rounds) and marks it ready when it finishes
  ([ADR-0035](docs/adr/0035-a-card-ships-itself.md)).
- The pull request passes its configured review steps before the card counts as
  finished ([ADR-0084](docs/adr/0084-a-card-passes-its-review-steps-before-finished.md)).
- Auto-merge needs every check to have passed
  ([ADR-0080](docs/adr/0080-auto-merge-needs-every-check-passed.md)); a person
  decides everything that touches protected paths.
- A person reads the diff against the spec's acceptance criteria. An agent's
  pull request description lists each criterion as checked, with how, or
  unchecked, with why.
- Agent commits carry no `Co-Authored-By` trailer or generated-by footer.

If you use an AI tool for your own pull request, you are the author: read what
it wrote, run the checks yourself and be able to explain every line.

## Questions

Ask in [Discussions](https://github.com/AndreyBegma/Nautelle/discussions) or
read the [wiki](https://github.com/AndreyBegma/Nautelle/wiki). See
[`SUPPORT.md`](SUPPORT.md).
