#!/usr/bin/env bash
# Create a new versioned migration file: migrations/V<UTC YYYYMMDDHHMMSS>__<description>.sql
# Usage: new_migration.sh <snake_case_description>   (run from repo root)
set -euo pipefail

desc="${1:-}"
if [[ ! "$desc" =~ ^[a-z0-9]+(_[a-z0-9]+)*$ ]]; then
  echo "usage: $0 <snake_case_description>" >&2
  exit 1
fi

mkdir -p migrations
version="$(date -u +%Y%m%d%H%M%S)"
file="migrations/V${version}__${desc}.sql"

if compgen -G "migrations/V*__${desc}.sql" > /dev/null; then
  echo "A migration named '${desc}' already exists:" >&2
  ls migrations/V*__"${desc}".sql >&2
  exit 1
fi

cat > "$file" <<EOF
-- ${file}
-- Created: $(date -u +%Y-%m-%dT%H:%M:%SZ)
-- Purpose: ${desc//_/ }
-- Never edit this file after it ships; append a new migration instead.

-- DDL here

-- Last statement: bump schema_version to the next integer.
-- UPDATE app_settings SET value = '<n>' WHERE key = 'schema_version';
EOF

echo "$file"
