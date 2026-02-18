-- Add theme preference to users
ALTER TABLE "User"
ADD COLUMN "theme" TEXT NOT NULL DEFAULT 'light';
