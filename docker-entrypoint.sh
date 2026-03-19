#!/bin/sh
set -e

echo "Running database migrations..."
node src/db/migrate.js

echo "Migrations completed. Starting server..."
exec node src/server.js