/**
 * Loan flow service: orchestrates the full PIX-first custodial loan lifecycle.
 *
 * 1. createLoanProposal  — lender creates off-chain loan, gets PIX QR
 * 2. processLenderDeposit — PIX confirmed → on-chain createLoan + drawdown
 * 3. disburseToBorrower   — borrower requests PIX withdrawal
 * 4. initRepayment        — borrower gets PIX QR to repay
 * 5. processRepayment     — repayment PIX confirmed → on-chain repay
 */

import { ethers } from "ethers";
import { prisma } from "../config/database";
import { env } from "../config/env";
import {
  LOAN_FACTORY_WRITE_ABI,
  BULLET_LOAN_WRITE_ABI,
  ERC20_ABI,
} from "../config/blockchain";
import { getLenderWallet, getBorrowerWallet } from "../config/platformWallet";
import { createDeposit, createWithdrawal } from "./rampService";
import { notifyBorrowerLoanReady, notifyLenderRepaymentReceived } from "./emailService";

// ── 1. Create loan proposal ─────────────────────────────────────────────────

interface CreateProposalInput {
  lenderEmail: string;
  borrowerEmail: string;
  principalBrl: number;
  annualRateBps: number;
  termMonths: number;
}

interface CreateProposalResult {
  loanId: string;
  pixQrCode: string;
  pixCopyPaste: string;
  expiresAt: string;
}

export async function createLoanProposal(
  input: CreateProposalInput,
): Promise<CreateProposalResult> {
  const lenderWallet = getLenderWallet();

  // BRZ has 4 decimals — convert BRL amount to BRZ wei
  const principalWei = ethers.parseUnits(input.principalBrl.toString(), 4).toString();

  // Calculate totalOwed locally (mirrors CompoundMath on-chain)
  const totalOwedWei = calculateTotalOwed(
    BigInt(principalWei),
    input.annualRateBps,
    input.termMonths,
  ).toString();

  // Create loan record in DB
  const loan = await prisma.loan.create({
    data: {
      lender: lenderWallet.address.toLowerCase(),
      lenderEmail: input.lenderEmail,
      borrowerEmail: input.borrowerEmail,
      principal: principalWei,
      annualRateBps: input.annualRateBps,
      termMonths: input.termMonths,
      totalOwed: totalOwedWei,
      feeBps: 200, // 2% platform fee (matches deployed factory)
      status: "PENDING_PAYMENT",
      principalBrl: input.principalBrl,
    },
  });

  // Generate PIX QR code via Transfero (deposit BRZ to platform lender wallet)
  const deposit = await createDeposit({
    amount: input.principalBrl,
    walletAddress: lenderWallet.address,
  });

  // Save Transfero transaction ID
  await prisma.loan.update({
    where: { id: loan.id },
    data: { pixDepositId: deposit.transactionId },
  });

  return {
    loanId: loan.id,
    pixQrCode: deposit.pixQrCode,
    pixCopyPaste: deposit.pixCopyPaste,
    expiresAt: deposit.expiresAt,
  };
}

// ── 2. Process lender deposit (called by webhook) ───────────────────────────

export async function processLenderDeposit(pixTransactionId: string): Promise<void> {
  // Find loan by PIX deposit ID
  const loan = await prisma.loan.findFirst({
    where: { pixDepositId: pixTransactionId, status: "PENDING_PAYMENT" },
  });

  if (!loan) {
    console.warn(`No PENDING_PAYMENT loan found for PIX deposit ${pixTransactionId}`);
    return;
  }

  try {
    // Execute on-chain: approve + createLoan + drawdown
    const contractAddress = await executeOnChainFunding(
      BigInt(loan.principal),
      loan.annualRateBps,
      loan.termMonths,
    );

    // Update loan with on-chain data
    await prisma.loan.update({
      where: { id: loan.id },
      data: {
        status: "ACTIVE",
        contractAddress,
        fundedAt: new Date(),
        activatedAt: new Date(),
        dueDate: new Date(Date.now() + loan.termMonths * 30 * 24 * 60 * 60 * 1000),
      },
    });

    // Notify borrower
    if (loan.borrowerEmail && loan.principalBrl) {
      await notifyBorrowerLoanReady(loan.borrowerEmail, loan.principalBrl, loan.id);
    }

    console.log(`✅ Loan ${loan.id} funded and activated on-chain at ${contractAddress}`);
  } catch (err) {
    console.error(`❌ On-chain funding failed for loan ${loan.id}:`, err);
    // Keep as PENDING_PAYMENT for retry
  }
}

// ── 3. Disburse to borrower (borrower requests PIX withdrawal) ──────────────

interface DisburseResult {
  withdrawalId: string;
  estimatedArrival: string;
}

export async function disburseToBorrower(
  loanId: string,
  pixKey: string,
): Promise<DisburseResult> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId } });

  if (!loan || loan.status !== "ACTIVE") {
    throw new Error("Loan not found or not in ACTIVE status");
  }

  if (!loan.principalBrl) {
    throw new Error("Loan has no BRL amount recorded");
  }

  const borrowerWallet = getBorrowerWallet();

  // Withdraw BRZ from platform borrower wallet → PIX to borrower
  const result = await createWithdrawal({
    amount: loan.principalBrl,
    pixKey,
    walletAddress: borrowerWallet.address,
  });

  // Update loan status
  await prisma.loan.update({
    where: { id: loanId },
    data: {
      status: "DISBURSED",
      disbursedAt: new Date(),
    },
  });

  return {
    withdrawalId: result.withdrawalId,
    estimatedArrival: result.estimatedArrival,
  };
}

// ── 4. Init repayment (borrower gets PIX QR to repay) ───────────────────────

interface RepayInitResult {
  pixQrCode: string;
  pixCopyPaste: string;
  expiresAt: string;
  amountBrl: number;
}

export async function initRepayment(loanId: string): Promise<RepayInitResult> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId } });

  if (!loan || loan.status !== "DISBURSED") {
    throw new Error("Loan not found or not in DISBURSED status");
  }

  // Calculate repayment BRL amount (totalOwed in BRZ → BRL, roughly 1:1 for BRZ)
  const totalOwedBrz = Number(ethers.formatUnits(loan.totalOwed, 4));
  const borrowerWallet = getBorrowerWallet();

  // Generate PIX QR for repayment (deposit BRZ to platform borrower wallet)
  const deposit = await createDeposit({
    amount: totalOwedBrz,
    walletAddress: borrowerWallet.address,
  });

  // Save repay PIX ID
  await prisma.loan.update({
    where: { id: loanId },
    data: { pixRepayId: deposit.transactionId },
  });

  return {
    pixQrCode: deposit.pixQrCode,
    pixCopyPaste: deposit.pixCopyPaste,
    expiresAt: deposit.expiresAt,
    amountBrl: totalOwedBrz,
  };
}

// ── 5. Process repayment (webhook confirms borrower PIX) ────────────────────

export async function processRepayment(pixTransactionId: string): Promise<void> {
  const loan = await prisma.loan.findFirst({
    where: { pixRepayId: pixTransactionId, status: "DISBURSED" },
  });

  if (!loan) {
    console.warn(`No DISBURSED loan found for PIX repay ${pixTransactionId}`);
    return;
  }

  try {
    // Execute on-chain repay
    if (loan.contractAddress) {
      await executeOnChainRepay(loan.contractAddress, BigInt(loan.totalOwed));
    }

    await prisma.loan.update({
      where: { id: loan.id },
      data: {
        status: "REPAID",
        repaidAt: new Date(),
      },
    });

    // Notify lender
    if (loan.lenderEmail && loan.principalBrl) {
      const totalOwedBrl = Number(ethers.formatUnits(loan.totalOwed, 4));
      await notifyLenderRepaymentReceived(loan.lenderEmail, totalOwedBrl, loan.id);
    }

    console.log(`✅ Loan ${loan.id} repaid on-chain`);
  } catch (err) {
    console.error(`❌ On-chain repay failed for loan ${loan.id}:`, err);
  }
}

// ── On-chain helpers ────────────────────────────────────────────────────────

async function executeOnChainFunding(
  principal: bigint,
  annualRateBps: number,
  termMonths: number,
): Promise<string> {
  const lenderWallet = getLenderWallet();
  const borrowerWallet = getBorrowerWallet();

  // 1. Approve factory to spend BRZ
  const brz = new ethers.Contract(env.BRZ_TOKEN_ADDRESS, ERC20_ABI, lenderWallet);
  const approveTx = await brz.approve(env.LOAN_FACTORY_ADDRESS, principal);
  await approveTx.wait();

  // 2. Create loan via factory (lenderWallet is on-chain lender)
  const factory = new ethers.Contract(
    env.LOAN_FACTORY_ADDRESS,
    LOAN_FACTORY_WRITE_ABI,
    lenderWallet,
  );
  const createTx = await factory.createLoan(principal, annualRateBps, termMonths);
  const receipt = await createTx.wait();

  // Extract loan address from event
  const log = receipt.logs.find(
    (l: ethers.Log) => l.address.toLowerCase() === env.LOAN_FACTORY_ADDRESS.toLowerCase(),
  );
  if (!log) throw new Error("LoanCreated event not found in receipt");
  const parsed = factory.interface.parseLog({ topics: log.topics as string[], data: log.data });
  const loanAddress: string = parsed?.args?.loanAddress;
  if (!loanAddress) throw new Error("Could not extract loan address from event");

  // 3. Drawdown from borrower wallet
  const bulletLoan = new ethers.Contract(loanAddress, BULLET_LOAN_WRITE_ABI, borrowerWallet);
  const drawdownTx = await bulletLoan.drawdown();
  await drawdownTx.wait();

  return loanAddress;
}

async function executeOnChainRepay(
  loanContractAddress: string,
  totalOwed: bigint,
): Promise<void> {
  const borrowerWallet = getBorrowerWallet();

  // 1. Approve BulletLoan to spend BRZ (borrowerWallet is on-chain borrower)
  const brz = new ethers.Contract(env.BRZ_TOKEN_ADDRESS, ERC20_ABI, borrowerWallet);
  const approveTx = await brz.approve(loanContractAddress, totalOwed);
  await approveTx.wait();

  // 2. Call repay
  const bulletLoan = new ethers.Contract(
    loanContractAddress,
    BULLET_LOAN_WRITE_ABI,
    borrowerWallet,
  );
  const repayTx = await bulletLoan.repay();
  await repayTx.wait();
}

// ── Compound interest calculation (mirrors CompoundMath.sol) ────────────────

function calculateTotalOwed(
  principal: bigint,
  annualRateBps: number,
  termMonths: number,
): bigint {
  // totalOwed = principal × (1 + annualRateBps/10000/12)^termMonths
  // Using fixed-point with 1e18 precision
  const WAD = 10n ** 18n;
  const monthlyRate = WAD + (BigInt(annualRateBps) * WAD) / 10000n / 12n;

  let result = WAD;
  let base = monthlyRate;
  let exp = termMonths;

  // Exponentiation by squaring
  while (exp > 0) {
    if (exp % 2 === 1) {
      result = (result * base) / WAD;
    }
    base = (base * base) / WAD;
    exp = Math.floor(exp / 2);
  }

  return (principal * result) / WAD;
}
