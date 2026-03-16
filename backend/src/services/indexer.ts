/**
 * Blockchain event indexer.
 *
 * Listens to LoanFactory and BulletLoan events via WebSocket (Alchemy)
 * and persists loan state to PostgreSQL through Prisma.
 *
 * Resilience strategy:
 *  - Exponential back-off on WebSocket disconnects
 *  - Cursor (lastBlock) stored in DB to survive restarts without replaying all events
 *  - Tracks per-loan events for atomic upserts
 */

import { ethers } from "ethers";
import { PrismaClient } from "@prisma/client";
import {
  BULLET_LOAN_ABI,
  LOAN_FACTORY_ABI,
} from "../config/blockchain";
import { env } from "../config/env";

type LoanStatus = "CREATED" | "FUNDED" | "ACTIVE" | "REPAID" | "DEFAULTED" | "CANCELLED";

type EventLog = ethers.EventLog;

interface IndexerOptions {
  prisma: PrismaClient;
  rpcUrl: string;
  wsUrl: string;
  factoryAddress: string;
  /** Block to start from on first run (deploy block). Defaults to 0. */
  startBlock?: bigint;
}

export class Indexer {
  private prisma: PrismaClient;
  private rpcUrl: string;
  private wsUrl: string;
  private factoryAddress: string;
  private startBlock: bigint;

  private wsProvider?: ethers.WebSocketProvider;
  private httpProvider?: ethers.JsonRpcProvider;
  private factory?: ethers.Contract;
  private isRunning = false;
  private reconnectDelay = 2_000; // ms
  private maxReconnectDelay = 30_000; // ms

  constructor(opts: IndexerOptions) {
    this.prisma = opts.prisma;
    this.rpcUrl = opts.rpcUrl;
    this.wsUrl = opts.wsUrl;
    this.factoryAddress = opts.factoryAddress;
    this.startBlock = opts.startBlock ?? 0n;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.isRunning = true;
    console.log("🔎 Indexer starting...");

    // HTTP provider for back-fill
    this.httpProvider = new ethers.JsonRpcProvider(this.rpcUrl);

    // Initialise DB cursor
    let state = await this.prisma.indexerState.findUnique({
      where: { id: "singleton" },
    });
    if (!state) {
      state = await this.prisma.indexerState.create({
        data: { id: "singleton", lastBlock: this.startBlock },
      });
    }

    // Back-fill missed events since last shutdown.
    // Use max(DB cursor, configured startBlock) so DEPLOY_BLOCK is always respected
    // even when a stale cursor (e.g. 0) is already present in the DB.
    const fromBlock =
      state.lastBlock > this.startBlock ? state.lastBlock : this.startBlock;
    const currentBlock = BigInt(await this.httpProvider.getBlockNumber());
    if (currentBlock > fromBlock) {
      console.log(
        `⏩ Back-filling events from block ${fromBlock} to ${currentBlock}`,
      );
      await this.backfill(fromBlock, currentBlock);
    }

    // Connect WebSocket for live events
    await this.connectWs();
  }

  stop(): void {
    this.isRunning = false;
    this.wsProvider?.destroy();
    console.log("🛑 Indexer stopped.");
  }

  // ── WebSocket connection / reconnect ─────────────────────────────────────────

  private async connectWs(): Promise<void> {
    if (!this.isRunning) return;

    console.log("🔌 Connecting WebSocket to Alchemy...");

    try {
      this.wsProvider = new ethers.WebSocketProvider(this.wsUrl);

      this.factory = new ethers.Contract(
        this.factoryAddress,
        LOAN_FACTORY_ABI,
        this.wsProvider,
      );

      // Listen for new loans created
      this.factory.on("LoanCreated", this.onLoanCreated.bind(this));

      // Re-attach listeners for active loans
      await this.attachLoanListeners();

      // Listen for provider errors / disconnects
      // Cast to any because ethers' WebSocketLike type doesn't expose addEventListener
      // but the underlying WebSocket instance does
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws = this.wsProvider.websocket as any;
      if (typeof ws.addEventListener === "function") {
        ws.addEventListener("close", () => {
          console.warn("⚠ WebSocket closed. Reconnecting...");
          this.scheduleReconnect();
        });
        ws.addEventListener("error", (e: unknown) => {
          console.error("⚠ WebSocket error:", e);
        });
      } else if (typeof ws.on === "function") {
        // Node.js ws library uses .on()
        ws.on("close", () => {
          console.warn("⚠ WebSocket closed. Reconnecting...");
          this.scheduleReconnect();
        });
        ws.on("error", (e: unknown) => {
          console.error("⚠ WebSocket error:", e);
        });
      }

      this.reconnectDelay = 2_000; // reset back-off on successful connect
      console.log("✅ WebSocket connected. Listening for events...");
    } catch (err) {
      console.error("WebSocket connect failed:", err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.isRunning) return;
    console.log(`🔄 Reconnecting in ${this.reconnectDelay / 1000}s...`);
    setTimeout(() => this.connectWs(), this.reconnectDelay);
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.maxReconnectDelay,
    );
  }

  // ── Back-fill ─────────────────────────────────────────────────────────────────

  // Alchemy free tier limits eth_getLogs to 10 blocks per request.
  private readonly BACKFILL_CHUNK = 9n;

  private async backfill(fromBlock: bigint, toBlock: bigint): Promise<void> {
    if (!this.httpProvider) return;

    // Process in chunks to stay within Alchemy free-tier limits
    let chunk = fromBlock;
    while (chunk <= toBlock) {
      const chunkEnd = chunk + this.BACKFILL_CHUNK - 1n < toBlock
        ? chunk + this.BACKFILL_CHUNK - 1n
        : toBlock;

      await this.backfillChunk(chunk, chunkEnd);
      chunk = chunkEnd + 1n;
    }

    // Update cursor
    await this.prisma.indexerState.update({
      where: { id: "singleton" },
      data: { lastBlock: toBlock },
    });
  }

  private async backfillChunk(fromBlock: bigint, toBlock: bigint): Promise<void> {
    if (!this.httpProvider) return;

    const factory = new ethers.Contract(
      this.factoryAddress,
      LOAN_FACTORY_ABI,
      this.httpProvider,
    );

    const loanCreatedFilter = factory.filters.LoanCreated();
    const loanCreatedEvents = (await factory.queryFilter(
      loanCreatedFilter,
      fromBlock,
      toBlock,
    )) as EventLog[];

    for (const ev of loanCreatedEvents) {
      await this.handleLoanCreated(ev);
      const loanAddress = ev.args.loanAddress;
      await this.backfillLoan(loanAddress, fromBlock, toBlock);
    }

    // Update cursor after each chunk
    await this.prisma.indexerState.update({
      where: { id: "singleton" },
      data: { lastBlock: toBlock },
    });
  }

  private async backfillLoan(
    loanAddress: string,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<void> {
    if (!this.httpProvider) return;

    const loan = new ethers.Contract(
      loanAddress,
      BULLET_LOAN_ABI,
      this.httpProvider,
    );

    const events = [
      "LoanFunded",
      "LoanActivated",
      "LoanRepaid",
      "LoanDefaulted",
      "LoanCancelled",
    ] as const;

    for (const evName of events) {
      const filter = loan.filters[evName]();
      const logs = (await loan.queryFilter(filter, fromBlock, toBlock)) as EventLog[];
      for (const log of logs) {
        await this.handleLoanEvent(evName, log);
      }
    }
  }

  // ── Live event handlers ───────────────────────────────────────────────────────

  private async attachLoanListeners(): Promise<void> {
    if (!this.wsProvider) return;

    // Attach listeners for loans that are not yet in final status
    const activeLoans = await this.prisma.loan.findMany({
      where: { status: { in: ["CREATED", "FUNDED", "ACTIVE"] } },
      select: { contractAddress: true },
    });

    for (const { contractAddress } of activeLoans) {
      if (contractAddress) this.watchLoan(contractAddress);
    }
  }

  private watchLoan(loanAddress: string): void {
    if (!this.wsProvider) return;

    const loan = new ethers.Contract(
      loanAddress,
      BULLET_LOAN_ABI,
      this.wsProvider,
    );

    loan.on("LoanActivated", (log: EventLog) =>
      this.handleLoanEvent("LoanActivated", log),
    );
    loan.on("LoanRepaid", (log: EventLog) =>
      this.handleLoanEvent("LoanRepaid", log),
    );
    loan.on("LoanDefaulted", (log: EventLog) =>
      this.handleLoanEvent("LoanDefaulted", log),
    );
    loan.on("LoanCancelled", (log: EventLog) =>
      this.handleLoanEvent("LoanCancelled", log),
    );
  }

  private async onLoanCreated(...args: unknown[]): Promise<void> {
    // ethers.js v6 passes event as last arg
    const ev = args[args.length - 1] as EventLog;
    await this.handleLoanCreated(ev);
    this.watchLoan(ev.args.loanAddress);
  }

  // ── DB persistence ────────────────────────────────────────────────────────────

  private async handleLoanCreated(ev: EventLog): Promise<void> {
    try {
      const { loanAddress, lender, principal, annualRateBps, termMonths } =
        ev.args;

      // Read totalOwed from chain
      const provider =
        this.httpProvider ?? new ethers.JsonRpcProvider(this.rpcUrl);
      const loan = new ethers.Contract(loanAddress, BULLET_LOAN_ABI, provider);
      const totalOwed: bigint = await loan.totalOwed();
      const feeBps: bigint = await loan.feeBps();

      await this.prisma.loan.upsert({
        where: { contractAddress: loanAddress },
        update: {},
        create: {
          contractAddress: loanAddress,
          lender,
          principal: principal.toString(),
          annualRateBps: Number(annualRateBps),
          termMonths: Number(termMonths),
          totalOwed: totalOwed.toString(),
          feeBps: Number(feeBps),
          status: "CREATED",
          txHash: ev.transactionHash,
          lastBlock: BigInt(ev.blockNumber),
        },
      });

      console.log(`📋 LoanCreated: ${loanAddress}`);
    } catch (err) {
      console.error("handleLoanCreated error:", err);
    }
  }

  private async handleLoanEvent(
    eventName: string,
    ev: EventLog,
  ): Promise<void> {
    try {
      const loanAddress = ev.args.loanAddress as string;

      const updateData: Record<string, unknown> = {
        txHash: ev.transactionHash,
        lastBlock: BigInt(ev.blockNumber),
      };

      const block = await ev.getBlock();
      const timestamp = block
        ? new Date(Number(block.timestamp) * 1000)
        : new Date();

      switch (eventName) {
        case "LoanFunded":
          updateData.status = "FUNDED" satisfies LoanStatus;
          updateData.fundedAt = timestamp;
          break;
        case "LoanActivated":
          updateData.status = "ACTIVE" satisfies LoanStatus;
          updateData.borrower = ev.args.borrower;
          updateData.activatedAt = timestamp;
          updateData.dueDate = new Date(Number(ev.args.dueDate) * 1000);
          break;
        case "LoanRepaid":
          updateData.status = "REPAID" satisfies LoanStatus;
          updateData.repaidAt = timestamp;
          break;
        case "LoanDefaulted":
          updateData.status = "DEFAULTED" satisfies LoanStatus;
          updateData.defaultedAt = timestamp;
          break;
        case "LoanCancelled":
          updateData.status = "CANCELLED" satisfies LoanStatus;
          break;
      }

      await this.prisma.loan.update({
        where: { contractAddress: loanAddress },
        data: updateData,
      });

      console.log(`🔔 ${eventName}: ${loanAddress}`);
    } catch (err) {
      console.error(`handleLoanEvent(${eventName}) error:`, err);
    }
  }
}
