# Versioning and upgrades

Nautelle has two release lines in one repository: the product (`vX.Y.Z`: the
`nautelle-api` and `nautelle-web` images, the compose file and `install.sh`)
and the runner (`runner-vX.Y.Z`: the `nautelle-runner` npm package and
Homebrew formula). Both follow [Semantic Versioning](https://semver.org/).
How a release is cut is in [ADR-0071](../adr/0071-the-product-is-released-by-version-with-a-changelog-and-release-notes.md)
and the `release` skill; how it is built and published is in
[ADR-0090](../adr/0090-release-images-are-multi-arch-signed-with-a-cosign-key-and-published-as-a-github-release.md).

## The version number

- **MAJOR** changes when an upgrade can break a working install: something an
  operator relies on is removed or changes meaning (see below).
- **MINOR** changes when a release adds something a person can do.
- **PATCH** changes when a release only fixes or polishes.

Both lines are on `0.x`. While the major is 0, SemVer lets any minor break,
and Nautelle uses that sparingly: a breaking change ships in a minor release,
never in a patch release, and its release note says so in the summary with
the steps to take. Moving to `1.0.0` is a person's decision; from then on a
breaking change needs a new major.

## What counts as breaking

A change is breaking when an operator who upgrades without reading the notes
ends up with an install that fails, loses data, or silently behaves
differently. In particular:

- **Environment.** Removing or renaming an environment variable the API, the
  web app or the compose file reads (`deploy/compose/.env.example`,
  `apps/api/.env.example`), changing its default in a way that changes
  behaviour, or making an optional one required. Adding an optional variable
  with a default that keeps today's behaviour is not breaking.
- **Compose file.** Renaming or removing a service, a volume, a profile
  (`local`, `tunnel`, `tls`) or a published port; changing where data lives
  inside a volume; raising the Docker Compose version the file needs. An
  install keeps the compose file it fetched, so such a change also needs
  `install.sh` to be run again, which the note must say.
- **Data.** A migration that drops or rewrites data an older release wrote,
  or anything that makes `secrets.json` unusable. Migrations only go forward;
  a downgrade is not supported.
- **Runner protocol.** A change an existing runner cannot follow: a new
  required field in a message, a removed command, a new `protocolVersion`.
  The protocol grows additively (new optional fields, new commands that a
  feature checks before it uses them, [runner protocol](../architecture/runner-protocol.md)),
  so a runner keeps working against a newer API. A rename or a removal goes
  through a compatibility window instead, as the rename to Nautelle did:
  [ADR-0073](../adr/0073-the-runner-and-its-protocol-are-renamed-nautelle-with-a-compatibility-window.md)
  kept the old names working through runner 0.14 and 0.15 and drops them in
  0.16.0. The release that closes a window is the breaking one.
- **Images.** Removing a tag scheme (`:X.Y.Z`, `:X.Y`, `:X`, `:latest`), a
  platform (`linux/amd64`, `linux/arm64`) or the signing key without a
  rotation note.

Not breaking: the web app's pages and their layout, the API routes only the
web app calls (they ship together in one release), log lines, and the shape
of anything under `.agentdock/` in a worktree.

## Supported upgrade paths

- **Product.** Any `0.x` release upgrades to any later one in one step:
  `docker compose pull && docker compose up -d`, or `install.sh` again. The API
  applies every migration in between when it starts. When a release in
  between is marked breaking, follow the steps in its note before the
  upgrade; the steps of several skipped breaking releases apply in order.
- **Pinning.** `NAUTELLE_VERSION` in `.env` takes any published tag: `X.Y.Z`
  stays on one release, `X.Y` takes its patch releases only, and `latest`
  follows every release. While the major is 0, `X` (`0`) is the same as
  `latest`.
- **Runner.** A runner upgrades in place (`brew upgrade`, `npm i -g`) across
  any number of releases inside a compatibility window. A runner older than a
  window that has ended is set up again by hand: a runner on 0.13 or older that
  skips to 0.16 or later pairs and installs its service again.
- **Runner and API together.** Upgrade the product first: an API accepts
  runners older than itself, and the admin's runner list shows which ones a
  newer runner release exists for.
- **Downgrades** are not supported. Restore the backup taken before the
  upgrade instead ([install guide](install.md#backup)).

## Knowing a new release exists

The API checks the repository's latest product release at most once a day and
shows admins a notice in the web app with a link to its release notes; the
running version is on Account › About. `NAUTELLE_UPDATE_CHECK=false` in
`api.env` turns the check off ([install guide](install.md#settings)).
