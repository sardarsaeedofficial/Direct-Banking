-- CreateEnum
CREATE TYPE "DdStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DdFrequency" AS ENUM ('WEEKLY', 'FORTNIGHTLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'VARIABLE');

-- CreateEnum
CREATE TYPE "DdExpectationMode" AS ENUM ('FIXED', 'RANGE', 'LEARNED');

-- CreateEnum
CREATE TYPE "DdAnomaly" AS ENUM ('NORMAL', 'ABOVE_EXPECTED', 'BELOW_EXPECTED', 'UNEXPECTED_DATE', 'FIRST_PAYMENT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RecurringKind" AS ENUM ('DIRECT_DEBIT', 'STANDING_ORDER', 'SUBSCRIPTION', 'RECURRING_CARD');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "ddAnomaly" "DdAnomaly",
ADD COLUMN     "directDebitMandateId" TEXT,
ADD COLUMN     "recurringConfidence" DOUBLE PRECISION,
ADD COLUMN     "recurringKind" "RecurringKind",
ADD COLUMN     "recurringPaymentGroupId" TEXT;

-- CreateTable
CREATE TABLE "DirectDebitMandate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "normalizedCompanyName" TEXT NOT NULL,
    "merchantAlias" TEXT,
    "mandateReference" TEXT,
    "providerMandateId" TEXT,
    "status" "DdStatus" NOT NULL DEFAULT 'ACTIVE',
    "kind" "RecurringKind" NOT NULL DEFAULT 'DIRECT_DEBIT',
    "frequency" "DdFrequency" NOT NULL DEFAULT 'MONTHLY',
    "expectationMode" "DdExpectationMode" NOT NULL DEFAULT 'LEARNED',
    "expectedAmountMinor" INTEGER,
    "expectedMinMinor" INTEGER,
    "expectedMaxMinor" INTEGER,
    "userExpectedAmountMinor" INTEGER,
    "userExpectedMinMinor" INTEGER,
    "userExpectedMaxMinor" INTEGER,
    "userConfiguredExpectedAmount" BOOLEAN NOT NULL DEFAULT false,
    "learnFromHistory" BOOLEAN NOT NULL DEFAULT true,
    "expectedDayOfMonth" INTEGER,
    "expectedNextDate" TIMESTAMP(3),
    "userExpectedDate" TIMESTAMP(3),
    "expectedTime" TEXT,
    "alertDaysBefore" INTEGER NOT NULL DEFAULT 3,
    "amountTolerancePercent" INTEGER NOT NULL DEFAULT 15,
    "amountToleranceMinor" INTEGER,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPaidAt" TIMESTAMP(3),
    "lastAmountMinor" INTEGER,
    "nextExpectedAt" TIMESTAMP(3),
    "paymentCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DirectDebitMandate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DirectDebitMandate_userId_status_idx" ON "DirectDebitMandate"("userId", "status");

-- CreateIndex
CREATE INDEX "DirectDebitMandate_userId_nextExpectedAt_idx" ON "DirectDebitMandate"("userId", "nextExpectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DirectDebitMandate_userId_accountId_normalizedCompanyName_key" ON "DirectDebitMandate"("userId", "accountId", "normalizedCompanyName");

-- CreateIndex
CREATE INDEX "Transaction_directDebitMandateId_idx" ON "Transaction"("directDebitMandateId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_directDebitMandateId_fkey" FOREIGN KEY ("directDebitMandateId") REFERENCES "DirectDebitMandate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectDebitMandate" ADD CONSTRAINT "DirectDebitMandate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DirectDebitMandate" ADD CONSTRAINT "DirectDebitMandate_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
