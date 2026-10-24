# C-374: Open-source polish: release infrastructure — multi-arch signed images, GitHub Releases, update notice

Runs after C-365 (it publishes the first ghcr images). Make releases look and behave like a mature OSS project.

- **Images:** `linux/amd64` + `linux/arm64` (buildx in the trusted release pipeline only; ADR-0053), tags `X.Y.Z`, `X.Y`, `X`, `latest`; OCI labels (source, version, revision, licenses); SBOM (syft) and provenance attached; images signed with cosign keyless or a key stored as a Woodpecker secret — say which in a short ADR.
- **GitHub Releases:** on `vX.Y.Z` the pipeline creates the release with the changelog section of that version (from `CHANGELOG.md`, which the `release` skill already writes), the install snippet, the image digests and the runner version that matches.
- **Update notice:** the API checks the latest GitHub release at most once a day (opt-out env `NAUTELLE_UPDATE_CHECK=false`, documented), and admins see "Nautelle X.Y.Z is available — release notes" in the web app (glass-ui). Current version shown in the app footer/about.
- **Versioning doc:** SemVer policy, what counts as breaking (env, compose, runner protocol window ADR-0073), supported upgrade paths.
Tests for the update-check cache and opt-out.
