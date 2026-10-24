---
title: Connect a project
description: Connect a GitHub repository cloned on a runner, and register the GitHub App.
---

A project is a GitHub repository cloned on a paired runner. Nautelle never
reads the repository itself: the runner does, on its machine.

## Connect the repository

1. Clone the repository on the runner machine, inside a folder the runner is
   allowed to work in (`--allow-root` when you [paired it](../pair-a-runner/)).
2. In Nautelle, open **Projects** and choose **Connect project**.
3. Pick the runner and enter the absolute path of the clone, for example
   `/home/you/dev/my-app`, then **Inspect**.
4. Nautelle shows what the runner found: the repository, its base branch, and
   whether it has a `CLAUDE.md`, an `AGENTS.md` and an orchestrator
   configuration. Nothing is stored yet. Choose **Connect**.

The path must be the main checkout, not a linked worktree or a subdirectory,
and its `origin` must be on GitHub. The project's Board is ready at once.

## Register the GitHub App

Nautelle follows issues, pull requests and checks on GitHub. It works without
an App by polling each project every 60 seconds; the App makes it immediate
and lets GitHub notify Nautelle through a webhook.

1. Open **Admin › Integrations › GitHub App** and choose **Register on
   GitHub**. Leave the organization empty to create the App under your own
   account.
2. GitHub asks you to confirm the App, then sends you back to Nautelle, which
   stores its credentials sealed under the encryption key.
3. Install the App on the repositories you connected.

The App asks for read access only: metadata, issues, pull requests, checks,
statuses and contents. Pushing and opening pull requests is done by the
runner, with the GitHub credentials of its own machine.

### The webhook needs a public address

GitHub delivers events to `<PUBLIC_URL>/hooks/github`, which defaults to
`NAUTELLE_URL` followed by `/api`. With a Cloudflare tunnel or your own domain
this works as is. On a plain `http://` install GitHub cannot reach the server,
so `install.sh` leaves `PUBLIC_URL` empty: the App is registered with its
webhook inactive and projects keep polling every 60 seconds. To use the
webhook later, give Nautelle a public HTTPS address first, then register the
App.

If you prefer to create the App by hand, **Enter credentials by hand** takes
its App ID, slug, private key and webhook secret. The App page shows its
health: an inactive webhook, a repository the App is not installed on, or
deliveries failing their signature check.

## Next

- Read [Board and cards](../../concepts/board/) and create your first card.
- To run the fleet on a project, its repository needs the Code Sentinel
  orchestrator configuration; see [Fleet](../../concepts/fleet/).
