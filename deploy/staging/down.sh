#!/bin/sh
# Stops staging. Never `-v` (the database lives in the volumes) and never
# `--remove-orphans`: other stacks share this Docker daemon.
set -eu
cd "$(dirname "$0")"
docker compose down
