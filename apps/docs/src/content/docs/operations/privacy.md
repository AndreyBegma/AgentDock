---
title: Telemetry and privacy
description: What Nautelle sends where. In short, no telemetry, and nothing leaves your hosts unless you set it up.
---

**Nautelle collects no telemetry.** There is no analytics, no error reporting
service and no usage ping in the server, the web app or the runner. Nothing is
sent to the Nautelle project.

Your data stays in your PostgreSQL database and your `data` volume. The
connections that leave your hosts are listed below; most of them exist only
once you configure the feature.

## The server

| Destination | When | What |
|---|---|---|
| `registry.npmjs.org` | Once an hour | Reads the latest released `nautelle-runner` version, to tell you when a runner is behind. Sends nothing about your install. |
| GitHub (`api.github.com`) | Once a day | Reads the latest Nautelle release, to tell administrators when a newer one is out. Sends nothing about your install. Set `NAUTELLE_UPDATE_CHECK=false` in `api.env` to turn it off. |
| GitHub (`api.github.com`) | Once a GitHub App is registered | Reads issues, pull requests and checks of the connected repositories. GitHub delivers webhooks to your server. |
| Telegram (`api.telegram.org`) | Once a Telegram bot is set up | The messages the bot sends and receives. |
| An AI provider (Anthropic, OpenAI, xAI, OpenRouter) | Once an administrator adds a provider key | The text of the assistant features you use: board search, triage hints, digests and summaries. |
| DeepL | Only with `DEEPL_API_KEY` | Free text people save, to translate it to English. |
| A speech-to-text service | Only with `SPEECH_TO_TEXT_URL` | Voice messages sent to the Telegram bot; never stored. |
| Your webhook URLs | Once you add an outbound webhook | Signed event payloads. |
| Let's Encrypt / Cloudflare | In domain or tunnel mode | Certificate requests, or the tunnel connection. |

## The runner

| Destination | When | What |
|---|---|---|
| Your Nautelle server | Always | Session metadata, usage, events and the results of commands. Prompt and tool text only for projects where you turned session content on. |
| GitHub | When an agent works | `git` and `gh` with the machine's own credentials: fetches, pushes, pull requests. |
| `registry.npmjs.org` | When you type a runner command at a terminal | Checks for a newer runner. Silent in the daemon and in CI; `NAUTELLE_NO_UPDATE_CHECK=1` turns it off. |
| `skills.sh` and GitHub | When you install a skill | The skill catalog and the skill's repository. |

The runner receives Claude Code's OpenTelemetry on `127.0.0.1` only and keeps
just the usage figures; prompts are never forwarded. Claude Code and Codex talk
to their own vendors with their own credentials, which never leave the runner
machine.

## The documentation

This site is static and served by GitHub Pages. It sets no cookies and loads
no analytics; GitHub's own
[privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
covers the hosting.
