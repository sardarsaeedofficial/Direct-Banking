-- CreateEnum
CREATE TYPE "StatementFileType" AS ENUM ('CSV', 'OFX', 'QIF', 'PDF');

-- CreateEnum
CREATE TYPE "StatementStatus" AS ENUM ('UPLOADED', 'PARSED', 'REVIEW_REQUIRED', 'IMPORTED', 'PARTIALLY_IMPORTED', 'FAILED');

-- CreateEnum
CREATE TYPE "StatementCandidateStatus" AS ENUM ('NEW', 'DUPLICATE', 'REVIEW', 'MATCHED', 'IMPORTED', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "ReconDecisionKind" AS ENUM ('KEEP_SEPARATE');

-- CreateEnum
CREATE TYPE "CorrectionAction" AS ENUM ('CATEGORY_CHANGE', 'MERCHANT_CHANGE', 'MARK_DIRECT_DEBIT', 'UNMARK_DIRECT_DEBIT', 'RECURRING_CLASSIFICATION', 'INTERNAL_TRANSFER_PAIR', 'INTERNAL_TRANSFER_UNPAIR', 'DUPLICATE_MERGE', 'DUPLICATE_KEEP_SEPARATE');

-- AlterTable
ALTER TABLE "TransactionEvidence" ADD COLUMN     "rowFingerprint" TEXT,
ADD COLUMN     "rowIndex" INTEGER,
ADD COLUMN     "statementImportId" TEXT;

-- CreateTable
CREATE TABLE "StatementImport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "fileType" "StatementFileType" NOT NULL,
    "fileHash" TEXT NOT NULL,
    "institution" TEXT,
    "status" "StatementStatus" NOT NULL DEFAULT 'UPLOADED',
    "transactionCount" INTEGER NOT NULL DEFAULT 0,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "StatementImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementCandidate" (
    "id" TEXT NOT NULL,
    "statementImportId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "bookedAt" TIMESTAMP(3) NOT NULL,
    "timeText" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "direction" "TxnDirection" NOT NULL,
    "description" TEXT NOT NULL,
    "merchantName" TEXT,
    "senderName" TEXT,
    "recipientName" TEXT,
    "reference" TEXT,
    "balanceAfterMinor" BIGINT,
    "fingerprint" TEXT NOT NULL,
    "reconStatus" "StatementCandidateStatus" NOT NULL DEFAULT 'NEW',
    "matchedTransactionId" TEXT,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transactionAId" TEXT NOT NULL,
    "transactionBId" TEXT NOT NULL,
    "decision" "ReconDecisionKind" NOT NULL DEFAULT 'KEEP_SEPARATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionCorrection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transactionId" TEXT,
    "action" "CorrectionAction" NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StatementImport_userId_idx" ON "StatementImport"("userId");

-- CreateIndex
CREATE INDEX "StatementImport_userId_accountId_idx" ON "StatementImport"("userId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "StatementImport_userId_accountId_fileHash_key" ON "StatementImport"("userId", "accountId", "fileHash");

-- CreateIndex
CREATE INDEX "StatementCandidate_statementImportId_idx" ON "StatementCandidate"("statementImportId");

-- CreateIndex
CREATE INDEX "StatementCandidate_statementImportId_fingerprint_idx" ON "StatementCandidate"("statementImportId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "StatementCandidate_statementImportId_rowIndex_key" ON "StatementCandidate"("statementImportId", "rowIndex");

-- CreateIndex
CREATE INDEX "ReconciliationDecision_userId_idx" ON "ReconciliationDecision"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationDecision_userId_transactionAId_transactionBId_key" ON "ReconciliationDecision"("userId", "transactionAId", "transactionBId");

-- CreateIndex
CREATE INDEX "TransactionCorrection_userId_createdAt_idx" ON "TransactionCorrection"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TransactionCorrection_transactionId_idx" ON "TransactionCorrection"("transactionId");

-- CreateIndex
CREATE INDEX "TransactionEvidence_statementImportId_idx" ON "TransactionEvidence"("statementImportId");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionEvidence_statementImportId_rowFingerprint_key" ON "TransactionEvidence"("statementImportId", "rowFingerprint");

-- AddForeignKey
ALTER TABLE "TransactionEvidence" ADD CONSTRAINT "TransactionEvidence_statementImportId_fkey" FOREIGN KEY ("statementImportId") REFERENCES "StatementImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementImport" ADD CONSTRAINT "StatementImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementImport" ADD CONSTRAINT "StatementImport_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementCandidate" ADD CONSTRAINT "StatementCandidate_statementImportId_fkey" FOREIGN KEY ("statementImportId") REFERENCES "StatementImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationDecision" ADD CONSTRAINT "ReconciliationDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionCorrection" ADD CONSTRAINT "TransactionCorrection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

