/**
 * Webhook route: receives payment confirmations from Transfero.
 * No auth middleware — validated by HMAC signature.
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import { env } from "../config/env";
import { processLenderDeposit, processRepayment } from "../services/loanFlowService";

const router = Router();

// ── POST /api/ramp/webhook ──────────────────────────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  try {
    // Validate webhook signature (if Transfero provides one)
    if (env.TRANSFERO_WEBHOOK_SECRET) {
      const signature = req.headers["x-webhook-signature"] as string;
      if (!signature) {
        res.status(401).json({ error: "Missing webhook signature" });
        return;
      }

      const expectedSig = crypto
        .createHmac("sha256", env.TRANSFERO_WEBHOOK_SECRET)
        .update(JSON.stringify(req.body))
        .digest("hex");

      if (signature !== expectedSig) {
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }
    }

    const { transaction_id, status, type } = req.body as {
      transaction_id?: string;
      status?: string;
      type?: string;
    };

    if (!transaction_id || status !== "completed") {
      // Ignore non-completed events
      res.json({ received: true });
      return;
    }

    console.log(`📬 Webhook received: type=${type} txId=${transaction_id}`);

    // Process based on type (deposit = lender funding or borrower repayment)
    if (type === "deposit") {
      // Try lender deposit first, then repayment
      await processLenderDeposit(transaction_id);
      await processRepayment(transaction_id);
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    // Always return 200 to avoid Transfero retries on our errors
    res.json({ received: true, error: "processing_failed" });
  }
});

export default router;
