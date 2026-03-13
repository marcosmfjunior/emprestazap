import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import { getUserSummary, getLoansByLender, getLoansByBorrower } from "../services/loanService";

const router = Router();

// ── GET /api/users/:walletAddress/summary ─────────────────────────────────────

router.get("/:walletAddress/summary", async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.params;

    if (!ethers.isAddress(walletAddress)) {
      res.status(400).json({ error: "Invalid wallet address" });
      return;
    }

    const summary = await getUserSummary(walletAddress.toLowerCase());
    res.json(summary);
  } catch (err) {
    console.error("GET /users/:walletAddress/summary error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/users/:walletAddress/loans/lending ───────────────────────────────

router.get("/:walletAddress/loans/lending", async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.params;

    if (!ethers.isAddress(walletAddress)) {
      res.status(400).json({ error: "Invalid wallet address" });
      return;
    }

    const page = parseInt((req.query.page as string) ?? "1", 10);
    const limit = parseInt((req.query.limit as string) ?? "20", 10);

    const result = await getLoansByLender(walletAddress.toLowerCase(), { page, limit });
    res.json(result);
  } catch (err) {
    console.error("GET /users/:walletAddress/loans/lending error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/users/:walletAddress/loans/borrowing ────────────────────────────

router.get("/:walletAddress/loans/borrowing", async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.params;

    if (!ethers.isAddress(walletAddress)) {
      res.status(400).json({ error: "Invalid wallet address" });
      return;
    }

    const page = parseInt((req.query.page as string) ?? "1", 10);
    const limit = parseInt((req.query.limit as string) ?? "20", 10);

    const result = await getLoansByBorrower(walletAddress.toLowerCase(), { page, limit });
    res.json(result);
  } catch (err) {
    console.error("GET /users/:walletAddress/loans/borrowing error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
