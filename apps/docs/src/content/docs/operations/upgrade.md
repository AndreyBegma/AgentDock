---
title: Upgrade
description: Move an install to a newer release, or pin one.
---

```sh
cd nautelle
docker compose pull
docker compose up -d
```

The API applies new database migrations when it starts, so an upgrade is the
two commands above. Read the
[release notes](https://github.com/AndreyBegma/Nautelle/tree/main/docs/releases)
first: a release that needs anything more says so there.

Running `install.sh` again also upgrades. It fetches the current compose file,
keeps `.env` and every password, and pulls the images:

```sh
curl -fsSL https://raw.githubusercontent.com/AndreyBegma/Nautelle/main/deploy/compose/install.sh | sh
```

## Pin a release

An install follows `latest` by default. To stay on a release, set it in
`nautelle/.env` and apply it:

```sh
NAUTELLE_VERSION=0.15.0
```

```sh
docker compose up -d
```

`install.sh --version 0.15.0` writes the same line. Moving back to an older
release is not supported once a newer one has migrated the database: restore
the [backup](../backup/) you took before the upgrade instead.

## Before you upgrade

Take a [backup](../backup/). A migration cannot be undone by starting the
older images again.

## Runners

A runner is upgraded on its own machine, separately from the server. When a
runner is behind the latest release, the web app says so on every page and
**Admin › Runners** marks it **Update available**. On the runner's machine:

```sh
npm i -g nautelle-runner@<version>
systemctl --user restart nautelle-runner                   # Linux (install-service)
launchctl kickstart -k gui/$(id -u)/com.nautelle.runner    # macOS (install-service)
```

With Homebrew: `brew upgrade nautelle-runner && brew services restart nautelle-runner`.
What changed is in the
[runner changelog](https://github.com/AndreyBegma/Nautelle/blob/main/apps/runner/CHANGELOG.md).
