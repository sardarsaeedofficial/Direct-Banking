-- CreateEnum
CREATE TYPE "BankConnectionStatus" AS ENUM ('PENDING', 'AUTHORIZATION_REQUIRED', 'ACTIVE', 'REAUTH_REQUIRED', 'EXPIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "BalanceAuthority" AS ENUM ('LEDGER', 'PROVIDER');

-- AlterTable
ALTER TABLE "BankAccount" ADD COLUMN     "availableBalanceMinor" BIGINT,
ADD COLUMN     "balanceAuthority" "BalanceAuthority" NOT NULL DEFAULT 'LEDGER',
ADD COLUMN     "bankConnectionId" TEXT,
ADD COLUMN     "providerOwnershipKey" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "possibleDuplicateOfId" TEXT;

-- CreateTable
CREATE TABLE "BankConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerConnectionIdEncrypted" TEXT,
    "status" "BankConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "institutionName" TEXT,
    "institutionProviderId" TEXT,
    "consentGrantedAt" TIMESTAMP(3),
    "consentExpiresAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "authState" TEXT,
    "authStateExpiresAt" TIMESTAMP(3),
    "authDeviceId" TEXT,
    "historyImportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionEvidence" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "sourceType" "TxnSource" NOT NULL,
    "provider" TEXT,
    "providerConnectionId" TEXT,
    "providerAccountId" TEXT,
    "providerTransactionId" TEXT,
    "notificationFingerprint" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawPayloadHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankConnection_authState_key" ON "BankConnection"("authState");

-- CreateIndex
CREATE INDEX "BankConnection_userId_status_idx" ON "BankConnection"("userId", "status");

-- CreateIndex
CREATE INDEX "TransactionEvidence_transactionId_idx" ON "TransactionEvidence"("transactionId");

-- CreateIndex
CREATE INDEX "TransactionEvidence_notificationFingerprint_idx" ON "TransactionEvidence"("notificationFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionEvidence_provider_providerTransactionId_key" ON "TransactionEvidence"("provider", "providerTransactionId");

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_bankConnectionId_fkey" FOREIGN KEY ("bankConnectionId") REFERENCES "BankConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_possibleDuplicateOfId_fkey" FOREIGN KEY ("possibleDuplicateOfId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankConnection" ADD CONSTRAINT "BankConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionEvidence" ADD CONSTRAINT "TransactionEvidence_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
