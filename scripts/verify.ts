import { run, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Re-verify already-deployed contracts on Polygonscan.
 * Reads addresses from deployments/{network}.json.
 *
 * Usage:
 *   npx hardhat run scripts/verify.ts --network amoy
 *   npx hardhat run scripts/verify.ts --network polygon
 */
async function main() {
  const filePath = path.join(__dirname, "..", "deployments", `${network.name}.json`);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `No deployment file found at ${filePath}. Run deploy.ts first.`,
    );
  }

  const deployment = JSON.parse(fs.readFileSync(filePath, "utf8"));

  console.log("─────────────────────────────────────────────");
  console.log("EmprestáZap — Contract Verification");
  console.log("─────────────────────────────────────────────");
  console.log(`Network:     ${deployment.network} (chainId: ${deployment.chainId})`);
  console.log(`LoanFactory: ${deployment.loanFactory}`);
  console.log(`BRZ Token:   ${deployment.brzToken}`);
  console.log(`FeeCollector:${deployment.feeCollector}`);
  console.log(`Fee BPS:     ${deployment.feeBps}\n`);

  await verifyContract(deployment.loanFactory, [
    deployment.brzToken,
    deployment.feeCollector,
    deployment.feeBps,
  ]);
}

async function verifyContract(address: string, constructorArgs: unknown[]) {
  console.log(`▶ Verifying ${address} ...`);
  try {
    await run("verify:verify", {
      address,
      constructorArguments: constructorArgs,
    });
    console.log("  ✅ Verified!");
  } catch (e: any) {
    if (e.message?.includes("Already Verified")) {
      console.log("  ℹ Already verified.");
    } else {
      console.error("  ⚠ Verification failed:", e.message);
      throw e;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
