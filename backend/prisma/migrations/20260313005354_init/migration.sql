-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('CREATED', 'FUNDED', 'ACTIVE', 'REPAID', 'DEFAULTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "lender" TEXT NOT NULL,
    "borrower" TEXT,
    "principal" TEXT NOT NULL,
    "annualRateBps" INTEGER NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "totalOwed" TEXT NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "status" "LoanStatus" NOT NULL DEFAULT 'CREATED',
    "fundedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "repaidAt" TIMESTAMP(3),
    "defaultedAt" TIMESTAMP(3),
    "txHash" TEXT,
    "lastBlock" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexerState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "lastBlock" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Loan_contractAddress_key" ON "Loan"("contractAddress");

-- CreateIndex
CREATE INDEX "Loan_lender_idx" ON "Loan"("lender");

-- CreateIndex
CREATE INDEX "Loan_borrower_idx" ON "Loan"("borrower");

-- CreateIndex
CREATE INDEX "Loan_status_idx" ON "Loan"("status");

-- CreateIndex
CREATE INDEX "Loan_dueDate_idx" ON "Loan"("dueDate");
