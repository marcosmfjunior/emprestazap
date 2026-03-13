import { Router, Request, Response } from "express";
import { ethers } from "ethers";
import {
  getLoans,
  getAvailableLoans,
  getLoanByAddress,
  LoanFilters,
} from "../services/loanService";

const router = Router();

// ── GET /api/loans ────────────────────────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  try {
    const filters: LoanFilters = {};

    if (req.query.status) {
      filters.status = req.query.status as LoanFilters["status"];
    }
    if (req.query.minAmount) {
      filters.minAmount = req.query.minAmount as string;
    }
    if (req.query.maxAmount) {
      filters.maxAmount = req.query.maxAmount as string;
    }
    if (req.query.minRate) {
      filters.minRate = parseInt(req.query.minRate as string, 10);
    }
    if (req.query.maxRate) {
      filters.maxRate = parseInt(req.query.maxRate as string, 10);
    }
    if (req.query.term) {
      filters.termMonths = parseInt(req.query.term as string, 10);
    }

    const page = parseInt((req.query.page as string) ?? "1", 10);
    const limit = parseInt((req.query.limit as string) ?? "20", 10);

    const result = await getLoans(filters, { page, limit });
    res.json(result);
  } catch (err) {
    console.error("GET /loans error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/loans/available ──────────────────────────────────────────────────

router.get("/available", async (req: Request, res: Response) => {
  try {
    const page = parseInt((req.query.page as string) ?? "1", 10);
    const limit = parseInt((req.query.limit as string) ?? "20", 10);
    const result = await getAvailableLoans({ page, limit });
    res.json(result);
  } catch (err) {
    console.error("GET /loans/available error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/loans/:address ───────────────────────────────────────────────────

router.get("/:address", async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    if (!ethers.isAddress(address)) {
      res.status(400).json({ error: "Invalid contract address" });
      return;
    }

    const loan = await getLoanByAddress(address.toLowerCase());
    if (!loan) {
      res.status(404).json({ error: "Loan not found" });
      return;
    }

    res.json(loan);
  } catch (err) {
    console.error("GET /loans/:address error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
