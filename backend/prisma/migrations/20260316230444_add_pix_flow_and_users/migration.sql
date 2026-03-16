-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LoanStatus" ADD VALUE 'PENDING_PAYMENT';
ALTER TYPE "LoanStatus" ADD VALUE 'DISBURSED';

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "borrowerEmail" TEXT,
ADD COLUMN     "disbursedAt" TIMESTAMP(3),
ADD COLUMN     "lenderEmail" TEXT,
ADD COLUMN     "pixDepositId" TEXT,
ADD COLUMN     "pixRepayId" TEXT,
ADD COLUMN     "principalBrl" DOUBLE PRECISION,
ALTER COLUMN "contractAddress" DROP NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'PENDING_PAYMENT';

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "privyId" TEXT NOT NULL,
    "email" TEXT,
    "walletAddress" TEXT,
    "pixKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_privyId_key" ON "User"("privyId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_walletAddress_key" ON "User"("walletAddress");

-- CreateIndex
CREATE INDEX "Loan_lenderEmail_idx" ON "Loan"("lenderEmail");

-- CreateIndex
CREATE INDEX "Loan_borrowerEmail_idx" ON "Loan"("borrowerEmail");
