/**
 * Loan service: business logic for reading loan data.
 * Combines DB (Prisma) reads for performance with on-chain reads for accuracy.
 */

import { ethers } from "ethers";
import { prisma } from "../config/database";
import { BULLET_LOAN_ABI, ERC20_ABI, getProvider } from "../config/blockchain";
import { env } from "../config/env";

// ── Prisma types (generated after `prisma generate`) ─────────────────────────
type LoanStatus = "CREATED" | "FUNDED" | "ACTIVE" | "REPAID" | "DEFAULTED" | "CANCELLED";

interface Loan {
  id: string;
  contractAddress: string;
  lender: string;
  borrower: string | null;
  principal: string;
  annualRateBps: number;
  termMonths: number;
  totalOwed: string;
  feeBps: number;
  status: LoanStatus;
  fundedAt: Date | null;
  activatedAt: Date | null;
  dueDate: Date | null;
  repaidAt: Date | null;
  defaultedAt: Date | null;
  txHash: string | null;
  lastBlock: bigint | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LoanFilters {
  status?: LoanStatus;
  minAmount?: string; // wei string
  maxAmount?: string;
  minRate?: number;   // bps
  maxRate?: number;
  termMonths?: number;
}

export interface PaginationOptions {
  page?: number;
  limit?: number;
}

export interface LoanDetail extends Omit<Loan, "lastBlock"> {
  lastBlock: string | null;   // serialised as string (BigInt → JSON safe)
  daysRemaining: number | null;
  interestAccrued: string;    // wei string
  isOverdue: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Using 'any' here to avoid importing Prisma namespace types before prisma generate
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildWhereClause(filters: LoanFilters): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {};

  if (filters.status) where.status = filters.status;
  if (filters.termMonths) where.termMonths = filters.termMonths;

  // Note: string comparison works when all values have the same number of digits (wei values)
  const principalFilter: Record<string, string> = {};
  if (filters.minAmount) principalFilter.gte = filters.minAmount;
  if (filters.maxAmount) principalFilter.lte = filters.maxAmount;
  if (Object.keys(principalFilter).length > 0) where.principal = principalFilter;

  if (filters.minRate !== undefined || filters.maxRate !== undefined) {
    where.annualRateBps = {};
    if (filters.minRate !== undefined) where.annualRateBps.gte = filters.minRate;
    if (filters.maxRate !== undefined) where.annualRateBps.lte = filters.maxRate;
  }

  return where;
}

function enrichLoan(loan: Loan): LoanDetail {
  const now = Date.now();
  let daysRemaining: number | null = null;
  let isOverdue = false;

  if (loan.status === "ACTIVE" && loan.dueDate) {
    const msLeft = loan.dueDate.getTime() - now;
    daysRemaining = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
    isOverdue = msLeft < 0;
  }

  // Interest accrued is totalOwed - principal (simple; compound already baked in)
  const totalOwed = BigInt(loan.totalOwed);
  const principal = BigInt(loan.principal);
  const interestAccrued = (totalOwed - principal).toString();

  return {
    ...loan,
    lastBlock: loan.lastBlock?.toString() ?? null,
    daysRemaining,
    interestAccrued,
    isOverdue,
  };
}

// ── Service functions ─────────────────────────────────────────────────────────

export async function getLoans(
  filters: LoanFilters = {},
  pagination: PaginationOptions = {},
): Promise<{ loans: LoanDetail[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, pagination.page ?? 1);
  const limit = Math.min(100, pagination.limit ?? 20);
  const skip = (page - 1) * limit;
  const where = buildWhereClause(filters);

  const [loans, total] = await Promise.all([
    prisma.loan.findMany({ where, skip, take: limit, orderBy: { createdAt: "desc" } }),
    prisma.loan.count({ where }),
  ]);

  return { loans: loans.map(enrichLoan), total, page, limit };
}

export async function getAvailableLoans(
  pagination: PaginationOptions = {},
): Promise<{ loans: LoanDetail[]; total: number }> {
  const result = await getLoans({ status: "FUNDED" }, pagination);
  return { loans: result.loans, total: result.total };
}

export async function getLoanByAddress(
  contractAddress: string,
): Promise<LoanDetail | null> {
  const loan = await prisma.loan.findUnique({ where: { contractAddress } });
  if (!loan) return null;
  return enrichLoan(loan);
}

export async function getUserSummary(walletAddress: string): Promise<{
  brzBalance: string;
  loansAsLender: number;
  loansAsBorrower: number;
  volumeLent: string;
  volumeBorrowed: string;
}> {
  const provider = getProvider();
  const erc20 = new ethers.Contract(env.BRZ_TOKEN_ADDRESS, ERC20_ABI, provider);
  const brzBalance: bigint = await erc20.balanceOf(walletAddress);

  const [lenderLoans, borrowerLoans] = await Promise.all([
    prisma.loan.findMany({
      where: { lender: walletAddress },
      select: { principal: true },
    }),
    prisma.loan.findMany({
      where: { borrower: walletAddress },
      select: { principal: true },
    }),
  ]);

  const volumeLent = lenderLoans
    .reduce((acc: bigint, l: { principal: string }) => acc + BigInt(l.principal), 0n)
    .toString();

  const volumeBorrowed = borrowerLoans
    .reduce((acc: bigint, l: { principal: string }) => acc + BigInt(l.principal), 0n)
    .toString();

  return {
    brzBalance: brzBalance.toString(),
    loansAsLender: lenderLoans.length,
    loansAsBorrower: borrowerLoans.length,
    volumeLent,
    volumeBorrowed,
  };
}

export async function getLoansByLender(
  lender: string,
  pagination: PaginationOptions = {},
): Promise<{ loans: LoanDetail[]; total: number }> {
  const page = Math.max(1, pagination.page ?? 1);
  const limit = Math.min(100, pagination.limit ?? 20);
  const skip = (page - 1) * limit;

  const [loans, total] = await Promise.all([
    prisma.loan.findMany({
      where: { lender },
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.loan.count({ where: { lender } }),
  ]);

  return { loans: loans.map(enrichLoan), total };
}

export async function getLoansByBorrower(
  borrower: string,
  pagination: PaginationOptions = {},
): Promise<{ loans: LoanDetail[]; total: number }> {
  const page = Math.max(1, pagination.page ?? 1);
  const limit = Math.min(100, pagination.limit ?? 20);
  const skip = (page - 1) * limit;

  const [loans, total] = await Promise.all([
    prisma.loan.findMany({
      where: { borrower },
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.loan.count({ where: { borrower } }),
  ]);

  return { loans: loans.map(enrichLoan), total };
}
