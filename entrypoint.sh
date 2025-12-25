#!/bin/sh
set -e

# Ensure /data directory exists and has proper permissions
if [ ! -d "/data" ]; then
    echo "Creating /data directory..."
    mkdir -p /data
fi

# Set ownership to node user (1000:1000)
echo "Setting /data permissions for node user..."
chown -R 1000:1000 /data
chmod -R 755 /data

# Switch to node user and execute the command
echo "Starting application as node user..."
exec su-exec node "$@"
