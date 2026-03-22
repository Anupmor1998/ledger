# Ledger Server

Backend API for a textile/commission ledger workflow. This service handles authentication, user-scoped masters, order management, WhatsApp message generation, report export, and user preferences such as theme and selected financial year.

## What This Project Does

The API supports a trading/brokerage workflow where a user can:

- sign up, log in, reset password
- manage customers, manufacturers, and quality masters
- create and track orders with financial-year-based numbering
- update processed quantity and order status
- generate WhatsApp-ready customer/manufacturer messages
- export Excel reports
- manage personal preferences and WhatsApp groups

All business data is user-scoped, so one user cannot access another user's records.

## Tech Stack

- Node.js
- Express
- PostgreSQL
- Prisma ORM
- JWT authentication
- bcryptjs
- ExcelJS

## Main Features

- JWT auth with signup, login, forgot password, reset password
- MVC-ish folder structure with separate routes/controllers
- Prisma + PostgreSQL schema with user-scoped relations
- financial-year-aware order listing and reporting
- automatic order number generation per user and financial year
- order progress tracking with processed quantity / processed meter
- WhatsApp message generation for customer and manufacturer
- report export in Excel format
- local production-data sync script for safer development
- local backup script for Windows-based backup workflow

## API Modules

- `auth`
- `users`
- `customers`
- `manufacturers`
- `qualities`
- `orders`
- `reports`

Base prefix:

```txt
/api
```

## Project Structure

```txt
src/
  app.js
  server.js
  config/
  controllers/
  middlewares/
  routes/
  utils/
prisma/
  schema.prisma
  migrations/
scripts/
```

## Environment Variables

Typical variables used in this project:

```env
DATABASE_URL=
PROD_DATABASE_URL=
LOCAL_DATABASE_URL=
MIGRATE_DATABASE_URL=
JWT_SECRET=
JWT_EXPIRES_IN=1d
CORS_ORIGINS=http://localhost:5173
PORT=8000
```

Optional local backup variables:

```env
PG_DUMP_BIN=
BACKUP_RETENTION_DAYS=30
BACKUP_DB_NAME=ledger
```

## Local Development

Install dependencies:

```bash
npm install
```

Generate Prisma client:

```bash
npm run prisma:generate
```

Run migrations locally:

```bash
npm run prisma:migrate -- --name your_change_name
```

Start dev server:

```bash
npm run dev
```

## Useful Scripts

```bash
npm run dev
npm run start
npm run prisma:generate
npm run prisma:migrate -- --name your_change_name
npm run prisma:deploy
npm run prisma:push
npm run prisma:studio
npm run db:sync-local
npm run db:backup-local
```

## Data Safety Workflow

This repo includes helper scripts to avoid working directly on production data:

- `db:sync-local`
  - copies production data into local PostgreSQL
- `db:backup-local`
  - creates compressed database backups in the repo-level `backup/` folder

Recommended flow:

1. sync production data into local
2. run and test migrations locally
3. verify app behavior locally
4. deploy committed migrations to production with `prisma:deploy`

## Production Notes

For production deploys, use committed migrations only:

```bash
npm run prisma:deploy
```

Do not use `prisma migrate dev` or `prisma db push` as the normal production schema workflow.

## Why This Project Is Interesting

From an interview/review perspective, this project shows:

- relational modeling with Prisma
- user-scoped multi-tenant style data isolation
- business-specific order numbering by financial year
- careful handling of derived values like meter and commission
- integration-style features like WhatsApp message generation and Excel reporting
- practical developer tooling for safer local development and backups

## Frontend Pair

This API is used by the React client in the sibling app:

- `../ledger-client`
