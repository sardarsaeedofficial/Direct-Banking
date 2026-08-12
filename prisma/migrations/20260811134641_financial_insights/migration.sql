-- CreateEnum
CREATE TYPE "RuleField" AS ENUM ('MERCHANT', 'NORMALIZED_MERCHANT', 'DESCRIPTION', 'RECIPIENT', 'SENDER', 'DD_COMPANY');

-- CreateEnum
CREATE TYPE "RuleOperator" AS ENUM ('CONTAINS', 'EQUALS', 'STARTS_WITH');

-- AlterTable
ALTER TABLE "Budget" ADD COLUMN     "alert100" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "alert50" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "alert75" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "alert90" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "endDate" TIMESTAMP(3),
ADD COLUMN     "lastAlertPct" INTEGER,
ADD COLUMN     "lastAlertPeriodKey" TEXT,
ADD COLUMN     "rolloverEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "code" TEXT,
ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Europe/London';

-- CreateTable
CREATE TABLE "CategoryRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "field" "RuleField" NOT NULL,
    "operator" "RuleOperator" NOT NULL DEFAULT 'CONTAINS',
    "value" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "subcategoryId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CategoryRule_userId_enabled_priority_idx" ON "CategoryRule"("userId", "enabled", "priority");

-- CreateIndex
CREATE INDEX "Budget_userId_categoryId_idx" ON "Budget"("userId", "categoryId");

-- CreateIndex
CREATE INDEX "Category_userId_code_idx" ON "Category"("userId", "code");

-- CreateIndex
CREATE INDEX "Transaction_userId_categoryId_bookedAt_idx" ON "Transaction"("userId", "categoryId", "bookedAt");

-- CreateIndex
CREATE INDEX "Transaction_userId_merchantId_bookedAt_idx" ON "Transaction"("userId", "merchantId", "bookedAt");

-- AddForeignKey
ALTER TABLE "CategoryRule" ADD CONSTRAINT "CategoryRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryRule" ADD CONSTRAINT "CategoryRule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill stable codes + isSystem for categories already seeded for existing users
-- (matches the previous default category set by name). Purely additive; only touches
-- rows whose code is still NULL, so user-created categories are never affected.
UPDATE "Category" SET "code" = 'HOUSING',       "isSystem" = true WHERE "code" IS NULL AND "name" = 'Housing';
UPDATE "Category" SET "code" = 'UTILITIES',     "isSystem" = true WHERE "code" IS NULL AND "name" = 'Utilities';
UPDATE "Category" SET "code" = 'GROCERIES',     "isSystem" = true WHERE "code" IS NULL AND "name" = 'Groceries';
UPDATE "Category" SET "code" = 'TRANSPORT',     "isSystem" = true WHERE "code" IS NULL AND "name" = 'Transport';
UPDATE "Category" SET "code" = 'SUBSCRIPTIONS', "isSystem" = true WHERE "code" IS NULL AND "name" = 'Subscriptions';
UPDATE "Category" SET "code" = 'INSURANCE',     "isSystem" = true WHERE "code" IS NULL AND "name" = 'Insurance';
UPDATE "Category" SET "code" = 'EATING_OUT',    "isSystem" = true WHERE "code" IS NULL AND "name" = 'Eating out';
UPDATE "Category" SET "code" = 'INCOME',        "isSystem" = true WHERE "code" IS NULL AND "name" = 'Income';
UPDATE "Category" SET "code" = 'SAVINGS',       "isSystem" = true WHERE "code" IS NULL AND "name" = 'Savings';
UPDATE "Category" SET "code" = 'OTHER',         "isSystem" = true WHERE "code" IS NULL AND "name" = 'Other';
