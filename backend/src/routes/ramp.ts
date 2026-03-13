import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import { authMiddleware } from "../middleware/auth";
import { createDeposit, createWithdrawal } from "../services/rampService";

const router = Router();

// All ramp endpoints require authentication
router.use(authMiddleware);

// ── POST /api/ramp/deposit ────────────────────────────────────────────────────

router.post("/deposit", async (req: Request, res: Response) => {
  try {
    const { amount } = req.body as { amount?: unknown };

    if (typeof amount !== "number" || amount <= 0) {
      res.status(400).json({ error: "amount must be a positive number (BRL)" });
      return;
    }

    const walletAddress = req.walletAddress;
    if (!walletAddress) {
      res.status(401).json({ error: "Wallet address not found in auth token" });
      return;
    }

    const result = await createDeposit({ amount, walletAddress });
    res.json(result);
  } catch (err: any) {
    console.error("POST /ramp/deposit error:", err);
    res.status(502).json({ error: err.message ?? "Ramp service error" });
  }
});

// ── POST /api/ramp/withdraw ───────────────────────────────────────────────────

router.post("/withdraw", async (req: Request, res: Response) => {
  try {
    const { amount, pixKey } = req.body as { amount?: unknown; pixKey?: unknown };

    if (typeof amount !== "number" || amount <= 0) {
      res.status(400).json({ error: "amount must be a positive number (BRZ)" });
      return;
    }
    if (typeof pixKey !== "string" || pixKey.trim().length === 0) {
      res.status(400).json({ error: "pixKey is required" });
      return;
    }

    const walletAddress = req.walletAddress;
    if (!walletAddress) {
      res.status(401).json({ error: "Wallet address not found in auth token" });
      return;
    }

    const result = await createWithdrawal({
      amount,
      pixKey: pixKey.trim(),
      walletAddress,
    });
    res.json(result);
  } catch (err: any) {
    console.error("POST /ramp/withdraw error:", err);
    res.status(502).json({ error: err.message ?? "Ramp service error" });
  }
});

export default router;
