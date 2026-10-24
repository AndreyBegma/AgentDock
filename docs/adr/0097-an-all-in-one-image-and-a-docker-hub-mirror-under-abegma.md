# ADR-0097: An all-in-one image and a Docker Hub mirror under abegma

Status: accepted · Date: 2026-10-24 ·
Spec: [`docs/specs/card-386-publish-the-images-to-docker-hub-too-and.md`](../specs/card-386-publish-the-images-to-docker-hub-too-and.md) ·
Relates to: [ADR-0088](0088-nautelle-installs-from-published-images-with-one-compose-file.md), [ADR-0091](0091-release-images-are-multi-arch-signed-with-a-cosign-key-and-published-as-a-github-release.md), [ADR-0092](0092-nautelle-runs-on-kubernetes-from-a-helm-chart-published-with-each-release.md) ·
Card: C-386

## Context

The release images live on ghcr.io only (ADR-0088, ADR-0091). Docker Hub is
where most people look for an image and the registry `docker run` assumes
without a host. Trying Nautelle also takes the install script, Compose, two
images, PostgreSQL and Redis; there is no single container to look at it.

A Docker Hub organization needs a paid plan, so the images go under the
personal account `abegma` until there is one.

## Decision

1. **Docker Hub is a mirror of ghcr.io.** On a `vX.Y.Z` tag, after the images
   are pushed and signed on ghcr.io, `release-images.sh` copies each index to
   Docker Hub with `docker buildx imagetools create` under the same tags
   (`X.Y.Z`, `X.Y`, `X`, `latest`). The copy moves the same manifests, so the
   digest, the SBOM and the provenance are identical; the script checks the
   digest on Docker Hub and fails if it differs, then signs that digest there
   with the same cosign key. A refused login or push fails the release.
   `cosign copy` was the alternative; buildx is already in the step and copies
   the attestation manifests with the index.
2. **The names are variables.** `deploy/images/dockerhub.env` holds
   `DOCKERHUB_NAMESPACE=abegma` and `DOCKERHUB_REPO_PREFIX=nautelle-`, read by
   both `release-images.sh` and `scripts/dockerhub.ts`, so the images are
   `docker.io/abegma/nautelle-api`, `docker.io/abegma/nautelle-web` and
   `docker.io/abegma/nautelle`. Moving to an organization changes those two
   lines (`nautelle` and an empty prefix).
3. **The repositories are created public before the first push.** The
   `dockerhub-repos` step runs `scripts/dockerhub.ts` with the tag-only
   secrets `dockerhub_username` (`abegma`) and `dockerhub_token`: it signs in
   to the Hub API, creates a missing repository with `is_private: false`,
   refuses one that is private, and sets the one-line `description` and the
   `full_description` from `README.md` with absolute links. A push would
   otherwise create the repository with the account's default visibility.
4. **ghcr.io stays the default.** `install.sh`, Compose and the Helm chart pull
   from `ghcr.io/andreybegma`. `NAUTELLE_REGISTRY=docker.io/abegma` (or
   `install.sh --registry`) and the chart's `image.registry` switch to Docker
   Hub.
5. **An all-in-one image, `nautelle`.** `deploy/all-in-one/Dockerfile` builds
   on the pinned PostgreSQL 16 image and copies the API and web from the
   images just pushed, by digest, plus pinned Node, Redis and Caddy binaries.
   tini runs a start script that starts the API, the web and Caddy on `:8000`
   and stops the container when any of them exits; s6 was rejected as more
   machinery than three processes need. Without `DATABASE_URL` and
   `REDIS_URL` it is demo mode: an embedded PostgreSQL and Redis with their
   data under `/data`, a "demo mode, not for production" line and the
   `/setup` link in the log. With both set it uses them and starts neither;
   with one set it embeds only the other, and the demo line still shows. It is
   signed, attested and mirrored
   like the other two, and a release fails if its build does not become
   healthy in `deploy/all-in-one/check-image.sh`.

## Consequences

- `docker run -p 8000:8000 -v nautelle:/data abegma/nautelle` is the quick
  start in the README; install.sh stays the way to run it for real.
- `cosign verify` with `deploy/images/cosign.pub` works on both registries.
- The release needs two more tag-only secrets and the `nautelle` ghcr package
  set to public once.
- A manual `[image-release]` run builds the three images, checks the
  all-in-one one on the host, and pushes nothing; the Hub step only reads the
  settings.
- Rejected:
  - **Building again for Docker Hub.** Different digests on each registry and
    twice the build time.
  - **Docker Hub as the default.** Its anonymous pull limit would hit installs
    first; ghcr.io stays where the chart and the runner already live.
  - **A Docker Hub organization now.** It needs a paid plan; the variables of
    §2 keep the move cheap.
