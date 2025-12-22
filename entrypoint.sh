#!/bin/sh
set -e

echo "Fixing permissions on /app/data..."
chown -R node:node /app/data

exec "$@"
