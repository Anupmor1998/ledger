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

2) `RCLONE_CONFIG_BASE64`
- Base64 value of your `rclone` config file for Google Drive OAuth (personal account).
- This avoids service-account quota limitations for personal Drive.

How to create `RCLONE_CONFIG_BASE64`
1) Install rclone locally and run:
   `rclone config`
2) Create remote named `gdrive` with type `drive`.
3) Complete OAuth login in browser.
4) Find config file path using:
   `rclone config file`
5) Encode config file:
   Linux: `base64 -w 0 ~/.config/rclone/rclone.conf`
   macOS: `base64 ~/.config/rclone/rclone.conf | tr -d '\n'`
6) Save encoded output into GitHub secret `RCLONE_CONFIG_BASE64`.

Google setup checklist (OAuth path)
1) Create Google Drive folder for backups.
2) Configure `rclone` with your Google account.
3) Put encoded rclone config into `RCLONE_CONFIG_BASE64`.
4) Keep `DATABASE_URL_BACKUP` updated.

Manual run
- GitHub -> Actions -> "Daily DB Backup To Google Drive" -> Run workflow.

Notes
- This is independent of Render web service uptime/sleep.
- Works the same if you move Render to paid plan later.
- You can adjust `RETENTION_DAYS` in workflow env.
