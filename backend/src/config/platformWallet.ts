/**
 * Platform wallets: two ethers.Wallet instances controlled by the backend.
 *
 * LENDER_WALLET  — creates loans on-chain (is the on-chain lender)
 * BORROWER_WALLET — calls drawdown / repay (is the on-chain borrower)
 *
 * Both private keys live exclusively in env vars (Railway).
 */

import { ethers } from "ethers";
import { env } from "./env";
import { getProvider } from "./blockchain";

let _lenderWallet: ethers.Wallet | null = null;
let _borrowerWallet: ethers.Wallet | null = null;

export function getLenderWallet(): ethers.Wallet {
  if (!_lenderWallet) {
    if (!env.PLATFORM_LENDER_PRIVATE_KEY) {
      throw new Error("PLATFORM_LENDER_PRIVATE_KEY is not set");
    }
    _lenderWallet = new ethers.Wallet(env.PLATFORM_LENDER_PRIVATE_KEY, getProvider());
  }
  return _lenderWallet;
}

export function getBorrowerWallet(): ethers.Wallet {
  if (!_borrowerWallet) {
    if (!env.PLATFORM_BORROWER_PRIVATE_KEY) {
      throw new Error("PLATFORM_BORROWER_PRIVATE_KEY is not set");
    }
    _borrowerWallet = new ethers.Wallet(env.PLATFORM_BORROWER_PRIVATE_KEY, getProvider());
  }
  return _borrowerWallet;
}
