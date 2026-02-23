#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required"
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
GDRIVE_REMOTE_NAME="${GDRIVE_REMOTE_NAME:-gdrive}"
GDRIVE_SUBDIR="${GDRIVE_SUBDIR:-ledger-server}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"
TIMESTAMP="$(date -u +'%Y%m%d_%H%M%S')"
DB_NAME="${DB_NAME:-ledger}"
BACKUP_FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.dump"
CHECKSUM_FILE="${BACKUP_FILE}.sha256"
RCLONE_CONFIG_FILE="${RCLONE_CONFIG_FILE:-$(mktemp)}"

mkdir -p "${BACKUP_DIR}"

if [[ -n "${RCLONE_CONFIG_BASE64:-}" ]]; then
  echo "${RCLONE_CONFIG_BASE64}" | base64 --decode > "${RCLONE_CONFIG_FILE}"
elif [[ -n "${RCLONE_CONFIG_CONTENT:-}" ]]; then
  printf '%s' "${RCLONE_CONFIG_CONTENT}" > "${RCLONE_CONFIG_FILE}"
elif [[ -n "${GDRIVE_SERVICE_ACCOUNT_FILE:-}" && -n "${GDRIVE_FOLDER_ID:-}" ]]; then
  cat > "${RCLONE_CONFIG_FILE}" <<EOF
[${GDRIVE_REMOTE_NAME}]
type = drive
scope = drive.file
service_account_file = ${GDRIVE_SERVICE_ACCOUNT_FILE}
root_folder_id = ${GDRIVE_FOLDER_ID}
EOF
else
  echo "Provide either RCLONE_CONFIG_BASE64 / RCLONE_CONFIG_CONTENT, or GDRIVE_SERVICE_ACCOUNT_FILE + GDRIVE_FOLDER_ID."
  exit 1
fi

cleanup() {
  if [[ "${RCLONE_CONFIG_FILE}" == /tmp/* ]]; then
    rm -f "${RCLONE_CONFIG_FILE}"
  fi
}
trap cleanup EXIT

echo "Starting PostgreSQL backup..."
"${PG_DUMP_BIN}" --version
"${PG_DUMP_BIN}" \
  --dbname="${DATABASE_URL}" \
  --format=custom \
  --file="${BACKUP_FILE}" \
  --no-owner \
  --no-privileges

sha256sum "${BACKUP_FILE}" > "${CHECKSUM_FILE}"

echo "Uploading backup to Google Drive..."
rclone --config "${RCLONE_CONFIG_FILE}" copyto \
  "${BACKUP_FILE}" \
  "${GDRIVE_REMOTE_NAME}:${GDRIVE_SUBDIR}/$(basename "${BACKUP_FILE}")"

rclone --config "${RCLONE_CONFIG_FILE}" copyto \
  "${CHECKSUM_FILE}" \
  "${GDRIVE_REMOTE_NAME}:${GDRIVE_SUBDIR}/$(basename "${CHECKSUM_FILE}")"

echo "Applying retention policy (${RETENTION_DAYS} days)..."
rclone --config "${RCLONE_CONFIG_FILE}" delete \
  "${GDRIVE_REMOTE_NAME}:${GDRIVE_SUBDIR}" \
  --min-age "${RETENTION_DAYS}d"
rclone --config "${RCLONE_CONFIG_FILE}" rmdirs \
  "${GDRIVE_REMOTE_NAME}:${GDRIVE_SUBDIR}" || true

echo "Backup complete: ${BACKUP_FILE}"
