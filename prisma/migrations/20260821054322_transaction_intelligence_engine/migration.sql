-- CreateEnum
CREATE TYPE "AnalyticsRole" AS ENUM ('SPENDING', 'INCOME', 'INTERNAL_TRANSFER', 'LIABILITY_REPAYMENT', 'REFUND', 'IGNORE', 'REVIEW');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CorrectionAction" ADD VALUE 'CONFIRM_COUNTERPARTY_ACCOUNT';
ALTER TYPE "CorrectionAction" ADD VALUE 'RECLASSIFY_EVENT_KIND';

-- AlterTable
ALTER TABLE "FinancialEvent" ADD COLUMN     "analyticsRole" "AnalyticsRole",
ADD COLUMN     "classificationReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "fromAccountId" TEXT,
ADD COLUMN     "toAccountId" TEXT;

-- CreateTable
CREATE TABLE "CounterpartyAccountMapping" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "counterpartyKey" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "confirmedBy" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CounterpartyAccountMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CounterpartyAccountMapping_userId_idx" ON "CounterpartyAccountMapping"("userId");

-- CreateIndex
CREATE INDEX "CounterpartyAccountMapping_accountId_idx" ON "CounterpartyAccountMapping"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "CounterpartyAccountMapping_userId_counterpartyKey_key" ON "CounterpartyAccountMapping"("userId", "counterpartyKey");

-- CreateIndex
CREATE INDEX "FinancialEvent_userId_analyticsRole_idx" ON "FinancialEvent"("userId", "analyticsRole");

-- AddForeignKey
ALTER TABLE "CounterpartyAccountMapping" ADD CONSTRAINT "CounterpartyAccountMapping_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CounterpartyAccountMapping" ADD CONSTRAINT "CounterpartyAccountMapping_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
