import { ethers } from "ethers";
import { env } from "./env";

// ── Provider (HTTP) ────────────────────────────────────────────────────────────

export function getProvider(): ethers.JsonRpcProvider {
  if (!env.POLYGON_RPC_URL) {
    throw new Error("POLYGON_RPC_URL is not set");
  }
  return new ethers.JsonRpcProvider(env.POLYGON_RPC_URL);
}

// ── WebSocket Provider (for event listening) ──────────────────────────────────

export function getWsProvider(): ethers.WebSocketProvider {
  if (!env.ALCHEMY_WEBSOCKET_URL) {
    throw new Error("ALCHEMY_WEBSOCKET_URL is not set");
  }
  return new ethers.WebSocketProvider(env.ALCHEMY_WEBSOCKET_URL);
}

// ── ABIs ──────────────────────────────────────────────────────────────────────

export const LOAN_FACTORY_ABI = [
  "event LoanCreated(address indexed loanAddress, address indexed lender, uint256 principal, uint256 annualRateBps, uint256 termMonths)",
  "function getAvailableLoans() external view returns (address[])",
  "function getLoansByLender(address _lender) external view returns (address[])",
  "function getLoansByBorrower(address _borrower) external view returns (address[])",
  "function getAllLoans() external view returns (address[])",
  "function getLoanCount() external view returns (uint256)",
] as const;

export const BULLET_LOAN_ABI = [
  "event LoanFunded(address indexed loanAddress, uint256 principal)",
  "event LoanActivated(address indexed loanAddress, address indexed borrower, uint256 dueDate)",
  "event LoanRepaid(address indexed loanAddress, uint256 totalPaid, uint256 feeAmount)",
  "event LoanDefaulted(address indexed loanAddress, uint256 outstandingAmount)",
  "event LoanCancelled(address indexed loanAddress)",
  "function lender() external view returns (address)",
  "function borrower() external view returns (address)",
  "function principal() external view returns (uint256)",
  "function annualRateBps() external view returns (uint256)",
  "function termMonths() external view returns (uint256)",
  "function totalOwed() external view returns (uint256)",
  "function feeBps() external view returns (uint256)",
  "function fundedAt() external view returns (uint256)",
  "function activatedAt() external view returns (uint256)",
  "function dueDate() external view returns (uint256)",
  "function status() external view returns (uint8)",
  "function getLoanDetails() external view returns (address lender, address borrower, uint256 principal, uint256 annualRateBps, uint256 termMonths, uint256 totalOwed, uint256 dueDate, uint8 status)",
  "function isOverdue() external view returns (bool)",
] as const;

export const ERC20_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
] as const;

// ── Status enum mapping ───────────────────────────────────────────────────────

export enum LoanStatusOnChain {
  Created = 0,
  Funded = 1,
  Active = 2,
  Repaid = 3,
  Defaulted = 4,
  Cancelled = 5,
}

export const LOAN_STATUS_MAP: Record<number, string> = {
  0: "CREATED",
  1: "FUNDED",
  2: "ACTIVE",
  3: "REPAID",
  4: "DEFAULTED",
  5: "CANCELLED",
};
