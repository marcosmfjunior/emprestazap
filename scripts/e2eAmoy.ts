/**
 * End-to-end test script — creates a test loan using the deployed contracts.
 *
 * Requires:
 *   - deployments/{network}.json to exist (run npm run deploy:amoy first)
 *   - Lender wallet must have MockBRZ balance (MockBRZ has a public mint())
 *
 * Usage:
 *   npm run e2e:amoy    — runs on Polygon Amoy testnet
 *   npm run e2e:local   — runs on local Hardhat node
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const MOCK_BRZ_ABI = [
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
];

const LOAN_FACTORY_ABI = [
  "function createLoan(uint256 principal, uint256 annualRateBps, uint256 termMonths) external returns (address)",
  "event LoanCreated(address indexed loanAddress, address indexed lender, uint256 principal, uint256 annualRateBps, uint256 termMonths)",
];

async function main() {
  const [lender] = await ethers.getSigners();

  // Load deployed addresses
  const deploymentPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`No deployment found for network "${network.name}". Run: npm run deploy:${network.name}`);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  console.log("─────────────────────────────────────────────");
  console.log(`EmprestáZap — E2E Test (${network.name})`);
  console.log("─────────────────────────────────────────────");
  console.log(`Lender:       ${lender.address}`);
  console.log(`LoanFactory:  ${deployment.loanFactory}`);
  console.log(`MockBRZ:      ${deployment.brzToken}`);

  const brz     = new ethers.Contract(deployment.brzToken,    MOCK_BRZ_ABI,     lender);
  const factory = new ethers.Contract(deployment.loanFactory, LOAN_FACTORY_ABI, lender);

  const PRINCIPAL   = ethers.parseEther("1000"); // 1,000 BRZ
  const ANNUAL_RATE = 1200;                       // 12% APR
  const TERM_MONTHS = 3;

  // ── 1. Mint test BRZ if needed ────────────────────────────────────────────

  const balance: bigint = await brz.balanceOf(lender.address);
  if (balance < PRINCIPAL) {
    console.log("\n▶ Minting 2,000 MockBRZ...");
    const tx = await brz.mint(lender.address, PRINCIPAL * 2n);
    await tx.wait();
  }
  console.log(`\n  BRZ balance: ${ethers.formatEther(await brz.balanceOf(lender.address))} BRZ`);

  // ── 2. Approve LoanFactory ────────────────────────────────────────────────

  console.log("▶ Approving LoanFactory...");
  const approveTx = await brz.approve(deployment.loanFactory, PRINCIPAL);
  await approveTx.wait();
  console.log("  Approved ✅");

  // ── 3. Create Loan ────────────────────────────────────────────────────────

  console.log(`▶ Creating loan: ${ethers.formatEther(PRINCIPAL)} BRZ @ ${ANNUAL_RATE / 100}% APR, ${TERM_MONTHS} months...`);
  const tx = await factory.createLoan(PRINCIPAL, ANNUAL_RATE, TERM_MONTHS);
  const receipt = await tx.wait();
  console.log(`  Tx: ${receipt?.hash}`);

  // ── 4. Extract loan address from event ───────────────────────────────────

  const iface = new ethers.Interface(LOAN_FACTORY_ABI);
  let loanAddress: string | undefined;
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === "LoanCreated") {
        loanAddress = parsed.args.loanAddress;
        break;
      }
    } catch { /* skip */ }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════");
  console.log("✅  LOAN CREATED");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Loan contract: ${loanAddress ?? "check tx logs"}`);
  console.log(`  Principal:     ${ethers.formatEther(PRINCIPAL)} BRZ`);
  console.log(`  Rate:          ${ANNUAL_RATE / 100}% APR`);
  console.log(`  Term:          ${TERM_MONTHS} months`);

  if (network.name === "amoy" && receipt?.hash) {
    console.log(`\n🔍 View on Polygonscan:`);
    console.log(`  https://amoy.polygonscan.com/tx/${receipt.hash}`);
    if (loanAddress) {
      console.log(`  https://amoy.polygonscan.com/address/${loanAddress}`);
    }
  }

  console.log("\n🔍 Check the API:");
  console.log("  curl http://localhost:3000/api/loans/available");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
