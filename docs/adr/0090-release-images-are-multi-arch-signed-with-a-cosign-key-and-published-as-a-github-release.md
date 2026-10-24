# ADR-0090: Release images are multi-arch, signed with a cosign key, and published as a GitHub Release

Status: accepted · Date: 2026-10-24 ·
Card: C-374 ·
Spec: [`docs/specs/card-374-open-source-polish-release-infrastructur.md`](../specs/card-374-open-source-polish-release-infrastructur.md) ·
Amends [ADR-0088](0088-nautelle-installs-from-published-images-with-one-compose-file.md) §1 and its consequence that arm64 hosts cannot run the images ·
Keeps: [ADR-0053](0053-pull-request-pipelines-are-untrusted.md), [ADR-0071](0071-the-product-is-released-by-version-with-a-changelog-and-release-notes.md)

## Context

ADR-0088 published the two product images for amd64 only, as `:X.Y.Z` and
`:latest`, built on the CI host's own daemon. Nothing told an operator what
the images contain, where they were built, or that they came from this
project at all, and the GitHub Release of a version was created by hand from
the release skill. A Raspberry Pi or an Apple-silicon server could not run
Nautelle, an operator could not pin a minor line, and an install never learned
that a newer release existed.

Signing has two shapes. Keyless signing (Sigstore Fulcio) issues a short-lived
certificate for an OIDC identity of the build, which GitHub Actions, GitLab CI
and Buildkite can present. Woodpecker has no OIDC token that Fulcio accepts,
so a keyless signature from this pipeline would need a person's browser login
on every release, which a tag pipeline cannot do.

## Decision

1. **Both architectures.** The tag pipeline builds `linux/amd64` and
   `linux/arm64` with `docker buildx` on a `docker-container` builder
   (`moby/buildkit`, digest-pinned) and QEMU emulation registered by
   `tonistiigi/binfmt` (digest-pinned). This happens in the trusted release
   pipeline only, which already mounts the Docker socket (ADR-0053); the
   binfmt registration is a privileged container that changes the CI host's
   kernel `binfmt_misc` table, which the host keeps. Pull request pipelines
   build nothing for arm64.
2. **Tags.** A release `X.Y.Z` pushes `:X.Y.Z`, `:X.Y`, `:X` and `:latest`; a
   pre-release `X.Y.Z-tag` pushes `:X.Y.Z-tag` only. While the major is 0,
   `:0` follows every 0.x release, as SemVer allows breaking changes in any
   minor there ([versioning](../guides/versioning.md)).
3. **Labels, SBOM and provenance.** Every image carries the OCI labels
   `source`, `version`, `revision`, `created`, `title` and `licenses` (`MIT`),
   and the build attaches an SPDX SBOM (`docker/buildkit-syft-scanner`,
   digest-pinned) and SLSA provenance (`mode=max`) as attestations in the
   image index.
4. **Signed with a key held in Woodpecker.** cosign (pinned binary, checksum
   verified) signs each image by digest with the key in the
   `cosign_private_key` and `cosign_password` secrets, restricted to the tag
   event like `ghcr_token`. The public key is committed as
   `deploy/images/cosign.pub`; the release stops before building when the
   secret's key does not match it, so a rotated secret cannot silently produce
   signatures nobody can verify. Rotating the key is a commit of the new
   public key plus the new secret; images signed before stay verifiable with
   the old key from git history.
5. **The pipeline creates the GitHub Release.** After the images are pushed,
   the same workflow creates the `vX.Y.Z` release with
   `github_release_token` (tag event only). Its body is composed by
   `scripts/release-notes.ts` from the release note the release skill already
   commits (`docs/releases/vX.Y.Z.md`, ADR-0071: its summary and its
   "What changed" section), the install command, the digest of each image, the
   cosign verify command and the runner version in the tree. The product
   release is marked latest; a runner release (`runner-vX.Y.Z`) is created
   with `--latest=false`, so the repository's latest release is always the
   product, with the install command on it. Nothing downloads the runner
   from the latest release: it installs from npm or Homebrew. A re-run edits the release instead of failing.
6. **The API looks for a newer release.** Once a day at most it reads the
   repository's releases from the GitHub API, takes the newest non-draft,
   non-pre-release `vX.Y.Z` (runner releases share the repository) and keeps
   it, with the time of the attempt, in the `settings` row
   `updates.latestRelease`. Every attempt counts, a failed one too, and the
   row survives a restart, so a crash loop does not hammer GitHub.
   `NAUTELLE_UPDATE_CHECK=false` turns the check off: nothing is fetched and
   no notice is shown. Admins see the notice in the web app; nobody else
   does.

## Consequences

- arm64 hosts run the published images. An arm64 build under QEMU is slow;
  a release takes several times longer than the amd64-only build did.
- The first signed release needs a one-time setup by a person: generate the
  key pair, add the two secrets and commit `cosign.pub` (deploy/README.md).
  Until then a tag pipeline fails before it builds anything.
- An operator verifies an image with
  `cosign verify --key cosign.pub ghcr.io/andreybegma/nautelle-api@sha256:…`
  and reads its SBOM with `docker buildx imagetools inspect --format
  '{{ json .SBOM }}'`.
- The release skill no longer creates the GitHub Release; it stops at the
  tag.
- An install with the update check on makes one outbound request to
  `api.github.com` a day; it sends no data about the install beyond the
  request itself.
