---
title: Configuration
description: Where an install keeps its settings, and how to change them.
---

An install keeps its settings in two files next to the compose file, plus the
keys the API generates for itself.

| File | Holds | Written by |
|---|---|---|
| `nautelle/.env` | The address, the exposure mode, the image version and the database and Redis passwords | `install.sh`; edit it by hand to change a setting |
| `nautelle/api.env` | Anything else the API reads: the Telegram bot, DeepL, speech to text, retention, limits | You; optional, one `KEY=value` per line |
| `secrets.json` in the `data` volume | `APP_ENCRYPTION_KEY`, `AUDIT_HMAC_KEY`, `LLM_SECRETS_KEY` | The API, on its first start |

After a change, apply it:

```sh
cd nautelle
docker compose up -d
```

Compose recreates only the services whose settings changed.

[Environment variables](../environment/) lists every variable with its
default; it is generated from the `.env.example` files in the repository, so it
always matches the release.

## The address

`NAUTELLE_URL` is the one setting that matters: the address people open,
without a trailing slash. The others derive from it, and each can be set in
`.env` to override it:

| Variable | Derived value | Used for |
|---|---|---|
| `API_URL` | `NAUTELLE_URL/api` | the address runners pair with |
| `WEB_URL` | `NAUTELLE_URL` | CORS and the WebSocket origin check |
| `APP_URL` | `NAUTELLE_URL` | links in Telegram messages and the Telegram Mini App |
| `PUBLIC_URL` | `NAUTELLE_URL/api` | the GitHub App webhook; empty turns it off |

To move an install to another address, run `install.sh --url <new address>`
again (or change `NAUTELLE_URL` and apply), then pair the runners again with
the new `/api` address.

## The generated keys

The API seals stored secrets — two-factor sign-in, the Telegram bot token, AI
provider keys, GitHub App and webhook secrets — and signs the audit log with
keys it generates on its first start into `secrets.json`. A key set in
`api.env` wins over the generated one. Never change or drop a key once data is
sealed with it, and [back it up](../../operations/backup/) with the database:
the database cannot be read without it.

## Most asked-for settings

- **The Telegram bot**: set up under **Admin › Integrations › Telegram**; it
  needs the encryption key, which every install has.
- **Translation with DeepL**: `DEEPL_API_KEY` in `api.env`.
- **Voice input in Telegram**: `SPEECH_TO_TEXT_URL`, `SPEECH_TO_TEXT_API_KEY`.
- **AI providers** for the assistant features: **Admin › AI providers**.
- **A headless first admin**: `install.sh --admin-email … --admin-password …`
  ([First run](../../getting-started/first-run/)).
