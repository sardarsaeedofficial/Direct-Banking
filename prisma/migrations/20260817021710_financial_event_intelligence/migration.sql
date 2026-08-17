-- CreateEnum
CREATE TYPE "FinEventKind" AS ENUM ('CARD_PURCHASE', 'BANK_TRANSFER', 'DIRECT_DEBIT', 'CREDIT_CARD_REPAYMENT', 'STANDING_ORDER', 'SUBSCRIPTION', 'RECURRING_CARD', 'CASH_WITHDRAWAL', 'FEE', 'REFUND', 'REVERSAL', 'BALANCE_INFORMATION', 'NON_FINANCIAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FinEventLifecycle" AS ENUM ('UPCOMING', 'PENDING', 'COMPLETED', 'DECLINED', 'FAILED', 'REVERSED', 'CANCELLED', 'REFUNDED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MoneyEffect" AS ENUM ('NONE', 'DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "LedgerImpact" AS ENUM ('NONE', 'POSTED', 'PENDING_VISIBLE', 'CORRECTED');

-- CreateEnum
CREATE TYPE "PaymentRail" AS ENUM ('DIRECT_DEBIT', 'CARD', 'TRANSFER', 'STANDING_ORDER', 'CASH', 'OTHER');

-- CreateEnum
CREATE TYPE "FinEventConfidenceLevel" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- AlterEnum
ALTER TYPE "CorrectionAction" ADD VALUE 'LIFECYCLE_RECLASSIFY';

-- AlterEnum
ALTER TYPE "TxnType" ADD VALUE 'CREDIT_CARD_REPAYMENT';

-- CreateTable
CREATE TABLE "FinancialEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT,
    "directDebitMandateId" TEXT,
    "recurringPaymentId" TEXT,
    "linkedTransactionId" TEXT,
    "notificationImportId" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourcePackage" TEXT,
    "sourceFingerprint" TEXT NOT NULL,
    "eventKind" "FinEventKind" NOT NULL,
    "lifecycle" "FinEventLifecycle" NOT NULL,
    "paymentRail" "PaymentRail",
    "amountMinor" INTEGER,
    "currency" TEXT,
    "expectedDirection" "TxnDirection",
    "moneyEffect" "MoneyEffect" NOT NULL,
    "ledgerImpact" "LedgerImpact" NOT NULL,
    "expectedAt" TIMESTAMP(3),
    "occurredAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "merchantName" TEXT,
    "senderName" TEXT,
    "recipientName" TEXT,
    "reference" TEXT,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "confidenceLevel" "FinEventConfidenceLevel" NOT NULL,
    "reasonCode" TEXT,
    "semanticVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinancialEvent_userId_lifecycle_idx" ON "FinancialEvent"("userId", "lifecycle");

-- CreateIndex
CREATE INDEX "FinancialEvent_userId_eventKind_idx" ON "FinancialEvent"("userId", "eventKind");

-- CreateIndex
CREATE INDEX "FinancialEvent_accountId_idx" ON "FinancialEvent"("accountId");

-- CreateIndex
CREATE INDEX "FinancialEvent_directDebitMandateId_idx" ON "FinancialEvent"("directDebitMandateId");

-- CreateIndex
CREATE INDEX "FinancialEvent_linkedTransactionId_idx" ON "FinancialEvent"("linkedTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialEvent_userId_sourceFingerprint_key" ON "FinancialEvent"("userId", "sourceFingerprint");

-- AddForeignKey
ALTER TABLE "FinancialEvent" ADD CONSTRAINT "FinancialEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
