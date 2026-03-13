/**
 * Ramp service: proxy for Transfero's on/off-ramp API.
 * Handles BRL → BRZ (deposit via Pix) and BRZ → BRL (withdraw via Pix).
 *
 * API keys are never sent to the frontend — all calls go through this service.
 */

import { env } from "../config/env";

interface DepositRequest {
  amount: number;       // Amount in BRL
  walletAddress: string; // User's wallet to credit BRZ to
}

interface DepositResponse {
  pixQrCode: string;
  pixCopyPaste: string;
  expiresAt: string;     // ISO timestamp
  transactionId: string;
}

interface WithdrawRequest {
  amount: number;        // Amount in BRZ (will be converted to BRL)
  pixKey: string;        // User's Pix key to receive BRL
  walletAddress: string; // User's wallet to debit BRZ from
}

interface WithdrawResponse {
  withdrawalId: string;
  estimatedArrival: string; // ISO timestamp
}

async function callTransfero<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${env.TRANSFERO_API_URL}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.TRANSFERO_API_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Transfero API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export async function createDeposit(req: DepositRequest): Promise<DepositResponse> {
  // POST /deposits  (Transfero endpoint — check actual API spec)
  const data = await callTransfero<{
    qr_code: string;
    qr_code_copy_paste: string;
    expires_at: string;
    id: string;
  }>("POST", "/deposits", {
    amount_brl: req.amount,
    wallet_address: req.walletAddress,
    currency: "BRZ",
  });

  return {
    pixQrCode: data.qr_code,
    pixCopyPaste: data.qr_code_copy_paste,
    expiresAt: data.expires_at,
    transactionId: data.id,
  };
}

export async function createWithdrawal(req: WithdrawRequest): Promise<WithdrawResponse> {
  // POST /withdrawals
  const data = await callTransfero<{
    id: string;
    estimated_arrival: string;
  }>("POST", "/withdrawals", {
    amount_brz: req.amount,
    pix_key: req.pixKey,
    wallet_address: req.walletAddress,
  });

  return {
    withdrawalId: data.id,
    estimatedArrival: data.estimated_arrival,
  };
}
