# C-386: Publish the images to Docker Hub too, and an all-in-one image for a one-line try-out

## Why
Self-hosters, Portainer, Unraid, CasaOS and TrueNAS look for images on Docker Hub first. Today Nautelle publishes only to ghcr.io (ADR-0088/0091). A quick look should also be one command, like Woodpecker's.

## What
1. **Mirror on Docker Hub.** On every release tag (`release-images.yml`, trusted, tag only), push the same multi-arch images to `docker.io/nautelle/api` and `docker.io/nautelle/web`, with the same tags (`X.Y.Z`, `X.Y`, `X`, `latest`). Copy the manifests from ghcr (`docker buildx imagetools create` or `cosign copy`) instead of building twice, so the digests stay identical. Sign the Docker Hub digests with the same cosign key, and attach the SBOM and provenance there too.
   - Secrets (already in Woodpecker, tag event only): `dockerhub_username` (`abegma`, who is a member of the `nautelle` org) and `dockerhub_token`. Log in with a throwaway `DOCKER_CONFIG`, as the ghcr login does.
   - Namespace from a variable, `DOCKERHUB_NAMESPACE`, default `nautelle`. A missing org or a refused push fails the step loudly; it never skips silently.
   - Push the repository description from `README.md` to both Docker Hub repos with the Hub API (`PATCH /v2/repositories/<ns>/<repo>/`: `full_description`, and a one-line `description`).
2. **ghcr stays the default** in `install.sh`, compose and the Helm chart: no pull rate limits there. The docs install page shows the Docker Hub names as an alternative, `NAUTELLE_REGISTRY=docker.io/nautelle`, and the Helm `image.registry` value does the same.
3. **All-in-one image `nautelle/nautelle`** (and `ghcr.io/andreybegma/nautelle`): API, web and Caddy in one container under a small init (s6-overlay or tini with a supervisor script), listening on `:8000`.
   - **Demo mode:** with no `DATABASE_URL` / `REDIS_URL`, it starts an embedded PostgreSQL 16 and Redis inside, with data under `/data`. It prints a clear "demo mode, not for production" line and the `/setup` link, so `docker run -p 8000:8000 -v nautelle:/data nautelle/nautelle` gives a working Nautelle.
   - **External mode:** with `DATABASE_URL` / `REDIS_URL` set, it runs without them.
   - Same signing and SBOM as the other images. Record it in a short ADR (next free number from origin/develop).
4. **Docs:** README quick start gets the one-line `docker run` try-out above the `install.sh` line. The docs install page gets a "Try it in one container" section and a Docker Hub section.
5. **Check:** `scripts/check-images.ts` and `check-ci.ts` keep passing. Rehearse with a manual run with `[image-release]` on a branch other than develop: it builds and pushes nothing.

## Done when
After the next release tag:
- `docker pull nautelle/api:X.Y.Z` and `nautelle/web:X.Y.Z` work, and `cosign verify --key deploy/images/cosign.pub nautelle/api:X.Y.Z` passes;
- on a clean machine, `docker run -p 8000:8000 nautelle/nautelle` serves the setup page within a minute of the pull.
