---
title: Backup and restore
description: Back up the database and the data volume together, and restore them on a new host.
---

A backup is two things taken together: the PostgreSQL database and the `data`
volume.

- **The database** holds everything you see in Nautelle: projects, cards,
  sessions, usage, the audit log, and the stored secrets in sealed form.
- **The `data` volume** (`/data` in the API container) holds `secrets.json`,
  the keys the API generated on its first start (`APP_ENCRYPTION_KEY`,
  `AUDIT_HMAC_KEY`, `LLM_SECRETS_KEY`), and the board card attachments.

`secrets.json` is as important as the database: without it, a restored
database cannot unseal its secrets (two-factor sign-in, the Telegram bot
token, AI provider keys, GitHub App and webhook secrets) and the audit chain
no longer verifies. Keep `nautelle/.env` too, for the database and Redis
passwords, and `nautelle/api.env` if you have one.

## Back up

```sh
cd nautelle
docker compose exec -T postgres pg_dump -U nautelle nautelle > nautelle.sql
docker compose exec -T api tar -cf - -C /data . > data.tar
cp .env env-backup
```

Store `data.tar` apart from the dump, and as safely: whoever holds both can
read every stored secret. Either alone is useless to them, and to you.

Redis holds only job queues and is not part of the backup; a restored install
starts with empty queues, and schedules are recreated from the database.

## Restore on a new host

1. Write the files without starting anything:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/AndreyBegma/Nautelle/main/deploy/compose/install.sh | sh -s -- --no-start
   cd nautelle
   ```

2. Put the saved `.env` (and `api.env`) in place of the new one.
3. Restore the database and the data volume **before the API starts**:

   ```sh
   docker compose up -d postgres
   docker compose exec -T postgres psql -U nautelle nautelle < nautelle.sql
   docker compose run --rm --no-deps -T --entrypoint tar api -xf - -C /data < data.tar
   docker compose up -d
   ```

The API must not start before `secrets.json` is back: it would generate new
keys that do not fit the restored database. If that happened, stop the stack,
restore `data.tar` again over the new file, and start it.

## Volume-level backups

The volumes are `nautelle_pgdata`, `nautelle_data`, `nautelle_redis` and, in
domain mode, `nautelle_caddy-data`. Back them up with your own tooling while
the stack is stopped (`docker compose stop`); a copy of `pgdata` taken while
PostgreSQL runs is not consistent.

## Runners

A runner keeps its own state on its machine: its token and policy in
`~/.config/nautelle/runner.json`, and the event spool. Nothing there needs a
backup — a lost runner is paired again — but the worktrees of running cards
live in your repositories on that machine.
