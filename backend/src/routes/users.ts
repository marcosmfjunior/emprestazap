import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import { getUserSummary, getLoansByLender, getLoansByBorrower } from "../services/loanService";
import { authMiddleware } from "../middleware/auth";
import { findOrCreateUser, updatePixKey } from "../services/userService";
import { prisma } from "../config/database";

const router = Router();

// ── GET /api/users/me (get or create own profile) ───────────────────────────

router.get("/me", authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!req.privyUserId) {
      res.status(401).json({ error: "Auth required" });
      return;
    }
    const user = await findOrCreateUser(req.privyUserId, req.privyEmail);
    res.json(user);
  } catch (err) {
    console.error("GET /users/me error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── PUT /api/users/me (update profile — pixKey) ────────────────────────────

router.put("/me", authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!req.privyUserId) {
      res.status(401).json({ error: "Auth required" });
      return;
    }
    const { pixKey } = req.body as { pixKey?: string };
    if (!pixKey || pixKey.trim().length === 0) {
      res.status(400).json({ error: "pixKey is required" });
      return;
    }
    const user = await updatePixKey(req.privyUserId, pixKey.trim());
    res.json(user);
  } catch (err) {
    console.error("PUT /users/me error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/users/me/loans (all loans by email) ───────────────────────────

router.get("/me/loans", authMiddleware, async (req: Request, res: Response) => {
  try {
    const email = req.privyEmail;
    if (!email) {
      res.status(400).json({ error: "Email not found in auth profile" });
      return;
    }

    const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10));
    const limit = Math.min(100, parseInt((req.query.limit as string) ?? "20", 10));
    const role = req.query.role as string | undefined;
    const skip = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: Record<string, any> =
      role === "lender"
        ? { lenderEmail: email }
        : role === "borrower"
          ? { borrowerEmail: email }
          : { OR: [{ lenderEmail: email }, { borrowerEmail: email }] };

    const [loans, total] = await Promise.all([
      prisma.loan.findMany({ where, skip, take: limit, orderBy: { createdAt: "desc" } }),
      prisma.loan.count({ where }),
    ]);

    const serialized = loans.map((loan) => ({
      ...loan,
      lastBlock: loan.lastBlock?.toString() ?? null,
    }));

    res.json({ loans: serialized, total, page, limit });
  } catch (err) {
    console.error("GET /users/me/loans error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Existing wallet-based routes ────────────────────────────────────────────

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
