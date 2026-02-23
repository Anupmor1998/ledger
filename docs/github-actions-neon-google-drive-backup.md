GitHub Actions Daily Backup (Neon PostgreSQL -> Google Drive)

What this setup does
- Runs daily at 11:30 PM IST (18:00 UTC).
- Uses `pg_dump` to back up Neon PostgreSQL.
- Uploads backup + checksum file to Google Drive.
- Deletes backups older than 30 days.

Files added
- `.github/workflows/db-backup.yml`
- `scripts/backup-to-gdrive.sh`

Required GitHub secrets
1) `DATABASE_URL_BACKUP`
- Neon connection string used for backup.

2) `GDRIVE_SERVICE_ACCOUNT_JSON`
- Full JSON content of Google Cloud service account key.

3) `GDRIVE_FOLDER_ID`
- Google Drive folder ID where backups should be uploaded.
- This is not the full share URL. It is the folder ID part.

How to get Google Drive folder ID
- From a folder URL like:
  `https://drive.google.com/drive/folders/1AbCdEfGh...xyz`
- Folder ID is:
  `1AbCdEfGh...xyz`

Google setup checklist
1) Create a Google Cloud project.
2) Enable Google Drive API.
3) Create a service account.
4) Create/download service account JSON key.
5) Share your target Drive folder with the service account email (Editor access).
6) Save the JSON and folder ID into GitHub Secrets.

Manual run
- GitHub -> Actions -> "Daily DB Backup To Google Drive" -> Run workflow.

Notes
- This is independent of Render web service uptime/sleep.
- Works the same if you move Render to paid plan later.
- You can adjust `RETENTION_DAYS` in workflow env.
