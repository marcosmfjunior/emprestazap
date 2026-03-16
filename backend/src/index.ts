import express from "express";
import cors from "cors";
import "dotenv/config";

import { env } from "./config/env";
import { connectDB, disconnectDB, prisma } from "./config/database";
import { Indexer } from "./services/indexer";

import loansRouter from "./routes/loans";
import usersRouter from "./routes/users";
import rampRouter from "./routes/ramp";
import webhookRouter from "./routes/webhook";

// ── Express setup ─────────────────────────────────────────────────────────────

const app = express();

const corsOrigins = env.CORS_ORIGIN
  ? env.CORS_ORIGIN.split(",").map((o) => o.trim())
  : env.NODE_ENV === "production"
    ? [] // block all if CORS_ORIGIN not set in production
    : "*";
app.use(cors({ origin: corsOrigins }));
app.use(express.json());

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── API Routes ────────────────────────────────────────────────────────────────

app.use("/api/loans", loansRouter);
app.use("/api/users", usersRouter);
app.use("/api/ramp", rampRouter);
app.use("/api/ramp/webhook", webhookRouter);

// ── 404 handler ───────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ── Global error handler ──────────────────────────────────────────────────────

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

let indexer: Indexer | null = null;

async function bootstrap(): Promise<void> {
  await connectDB();

  // Start event indexer if blockchain config is present
  if (env.LOAN_FACTORY_ADDRESS && env.POLYGON_RPC_URL) {
    indexer = new Indexer({
      prisma,
      rpcUrl: env.POLYGON_RPC_URL,
      wsUrl: env.ALCHEMY_WEBSOCKET_URL,
      factoryAddress: env.LOAN_FACTORY_ADDRESS,
      startBlock: env.DEPLOY_BLOCK ? BigInt(env.DEPLOY_BLOCK) : undefined,
    });
    // Run indexer without blocking server startup
    indexer.start().catch((err) => {
      console.error("Indexer failed to start:", err);
    });
  } else {
    console.warn("⚠ LOAN_FACTORY_ADDRESS or POLYGON_RPC_URL not set — indexer disabled");
  }

  const server = app.listen(env.PORT, () => {
    console.log(`🚀 EmprestáZap API running on port ${env.PORT}`);
    console.log(`   Environment: ${env.NODE_ENV}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received — shutting down...`);
    indexer?.stop();
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

bootstrap().catch((err) => {
  console.error("Fatal bootstrap error:", err);
  process.exit(1);
});

export default app;
