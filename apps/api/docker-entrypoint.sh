#!/bin/sh
# Deploying is "replace the containers": there is no migration step in the
# pipeline. The API migrates and seeds before it listens, and refuses to start
# when either fails. The seed is idempotent (settings upsert, prices only when
# no version exists).
#
# The seed runs compiled (dist/prisma/seed.js), not through `prisma db seed`:
# that calls ts-node, a dev dependency the image does not carry.
set -eu

prisma migrate deploy
node dist/prisma/seed.js

exec "$@"
