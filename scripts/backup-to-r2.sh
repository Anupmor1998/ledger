#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------------------
# PostgreSQL Backup to Cloudflare R2 with 30-Day Retention
# ------------------------------------------------------------------------------

# Validate required environment variables
for var in DATABASE_URL R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_NAME; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: Missing required environment variable: ${var}"
    exit 1
  fi
done

# Configuration & defaults
BACKUP_DIR="${BACKUP_DIR:-./backups}"
R2_SUBDIR="${R2_SUBDIR:-ledger-server}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"
DB_NAME="${DB_NAME:-ledger}"
TIMESTAMP="$(date -u +'%Y%m%d_%H%M%S')"

# File names
RAW_SQL_FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.sql"
ZIP_FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.zip"
CHECKSUM_FILE="${ZIP_FILE}.sha256"

# Cloudflare R2 S3 Endpoint configuration
R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
export AWS_DEFAULT_REGION="auto"

# Determine remote destination prefix
DEST_PREFIX=""
if [[ -n "${R2_SUBDIR}" ]]; then
  DEST_PREFIX="${R2_SUBDIR%/}/"
fi

mkdir -p "${BACKUP_DIR}"

echo "============================================================"
echo " Starting Database Backup Process"
echo " Time (UTC)    : $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo " Target Bucket : s3://${R2_BUCKET_NAME}/${DEST_PREFIX}"
echo " Retention     : ${RETENTION_DAYS} days"
echo "============================================================"

# Step 1: Dump database using pg_dump
echo "--> 1. Running pg_dump..."
"${PG_DUMP_BIN}" --version

"${PG_DUMP_BIN}" \
  --dbname="${DATABASE_URL}" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --file="${RAW_SQL_FILE}"

RAW_SIZE="$(du -h "${RAW_SQL_FILE}" | cut -f1)"
echo "    Raw SQL dump created: ${RAW_SQL_FILE} (${RAW_SIZE})"

# Step 2: Compress SQL into ZIP archive
echo "--> 2. Compressing SQL dump to ZIP archive..."
zip -9 -j "${ZIP_FILE}" "${RAW_SQL_FILE}"

# Remove raw uncompressed SQL file to free disk space immediately
rm -f "${RAW_SQL_FILE}"

ZIP_SIZE="$(du -h "${ZIP_FILE}" | cut -f1)"
echo "    Compressed archive created: ${ZIP_FILE} (${ZIP_SIZE})"

# Step 3: Compute SHA-256 Checksum
echo "--> 3. Computing SHA-256 checksum..."
(cd "${BACKUP_DIR}" && sha256sum "$(basename "${ZIP_FILE}")" > "$(basename "${CHECKSUM_FILE}")")
echo "    Checksum: $(cat "${CHECKSUM_FILE}")"

# Step 4: Upload backup archive and checksum to Cloudflare R2
echo "--> 4. Uploading to Cloudflare R2..."
aws s3 cp "${ZIP_FILE}" "s3://${R2_BUCKET_NAME}/${DEST_PREFIX}$(basename "${ZIP_FILE}")" \
  --endpoint-url "${R2_ENDPOINT}"

aws s3 cp "${CHECKSUM_FILE}" "s3://${R2_BUCKET_NAME}/${DEST_PREFIX}$(basename "${CHECKSUM_FILE}")" \
  --endpoint-url "${R2_ENDPOINT}"

echo "    Upload successful: s3://${R2_BUCKET_NAME}/${DEST_PREFIX}$(basename "${ZIP_FILE}")"

# Step 5: Enforce 30-Day Retention Policy (Delete backups older than RETENTION_DAYS)
echo "--> 5. Checking and applying retention policy (${RETENTION_DAYS} days)..."

python3 - <<EOF
import os, sys, json, subprocess
from datetime import datetime, timezone, timedelta

bucket = os.environ['R2_BUCKET_NAME']
prefix = os.environ.get('R2_SUBDIR', '').strip('/')
if prefix:
    prefix += '/'
endpoint = f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
retention_days = int(os.environ.get('RETENTION_DAYS', '30'))
cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)

print(f"    Checking objects in s3://{bucket}/{prefix} modified before {cutoff.strftime('%Y-%m-%d %H:%M:%S UTC')}...")

list_cmd = [
    'aws', 's3api', 'list-objects-v2',
    '--bucket', bucket,
    '--prefix', prefix,
    '--endpoint-url', endpoint,
    '--output', 'json'
]
res = subprocess.run(list_cmd, capture_output=True, text=True)
if res.returncode != 0:
    print(f"    Warning: Failed to list objects for retention check: {res.stderr.strip()}")
    sys.exit(0)

try:
    data = json.loads(res.stdout) if res.stdout.strip() else {}
except Exception as e:
    print(f"    Warning: Could not parse list-objects response: {e}")
    data = {}

contents = data.get('Contents', [])
if not contents:
    print("    No existing objects found in prefix.")
    sys.exit(0)

deleted_count = 0
for item in contents:
    key = item.get('Key')
    last_mod_str = item.get('LastModified')
    if not key or not last_mod_str:
        continue

    # Parse ISO 8601 timestamp
    last_mod = datetime.fromisoformat(last_mod_str.replace('Z', '+00:00'))

    if last_mod < cutoff:
        print(f"    Deleting expired backup: {key} (LastModified: {last_mod_str})")
        del_cmd = [
            'aws', 's3', 'rm',
            f"s3://{bucket}/{key}",
            '--endpoint-url', endpoint
        ]
        del_res = subprocess.run(del_cmd, capture_output=True, text=True)
        if del_res.returncode == 0:
            deleted_count += 1
        else:
            print(f"    Error deleting {key}: {del_res.stderr.strip()}")

print(f"    Retention check complete. Deleted {deleted_count} expired object(s).")
EOF

echo "============================================================"
echo " Backup finished successfully!"
echo " Backup file : ${ZIP_FILE} (${ZIP_SIZE})"
echo "============================================================"
