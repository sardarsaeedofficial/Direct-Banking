-- CreateEnum
CREATE TYPE "TxnType" AS ENUM ('INCOME', 'PURCHASE', 'INTERNAL_TRANSFER', 'DIRECT_DEBIT', 'STANDING_ORDER', 'CASH_WITHDRAWAL', 'BANK_FEE', 'REFUND', 'TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "TransferConfidence" AS ENUM ('CONFIRMED', 'HIGH', 'POSSIBLE', 'NOT_INTERNAL');

-- AlterEnum
ALTER TYPE "TxnSource" ADD VALUE 'STATEMENT_IMPORT';

-- AlterTable
ALTER TABLE "BankAccount" ADD COLUMN     "accountHolderName" TEXT,
ADD COLUMN     "accountNumberMasked" TEXT,
ADD COLUMN     "ibanMasked" TEXT,
ADD COLUMN     "providerAccountId" TEXT,
ADD COLUMN     "sortCodeMasked" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "bankDescription" TEXT,
ADD COLUMN     "internalTransferConfidence" "TransferConfidence",
ADD COLUMN     "internalTransferGroupId" TEXT,
ADD COLUMN     "merchantName" TEXT,
ADD COLUMN     "occurredAt" TIMESTAMP(3),
ADD COLUMN     "paymentReason" TEXT,
ADD COLUMN     "paymentReference" TEXT,
ADD COLUMN     "rawDescriptionRedacted" TEXT,
ADD COLUMN     "recipientAccountHint" TEXT,
ADD COLUMN     "recipientAccountId" TEXT,
ADD COLUMN     "recipientBankName" TEXT,
ADD COLUMN     "recipientName" TEXT,
ADD COLUMN     "senderAccountHint" TEXT,
ADD COLUMN     "senderAccountId" TEXT,
ADD COLUMN     "senderBankName" TEXT,
ADD COLUMN     "senderName" TEXT,
ADD COLUMN     "settledAt" TIMESTAMP(3),
ADD COLUMN     "sourceBankPackage" TEXT,
ADD COLUMN     "sourceBankTransactionId" TEXT,
ADD COLUMN     "subcategory" TEXT,
ADD COLUMN     "transactionType" "TxnType";

-- CreateIndex
CREATE INDEX "Transaction_userId_internalTransferGroupId_idx" ON "Transaction"("userId", "internalTransferGroupId");

-- CreateIndex
CREATE INDEX "Transaction_userId_transactionType_idx" ON "Transaction"("userId", "transactionType");
