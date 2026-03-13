import { ethers, network, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

interface DeploymentAddresses {
  network: string;
  chainId: number;
  brzToken: string;
  feeCollector: string;
  feeBps: number;
  loanFactory: string;
  deployedAt: string;
  deployer: string;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  console.log("─────────────────────────────────────────────");
  console.log("EmprestáZap — P2P Lending Platform Deploy");
  console.log("─────────────────────────────────────────────");
  console.log(`Network:    ${network.name} (chainId: ${chainId})`);
  console.log(`Deployer:   ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance:    ${ethers.formatEther(balance)} MATIC\n`);

  // ── Parameters ────────────────────────────────────────────────────────────

  let brzToken: string;
  let feeCollector: string;
  const feeBps = parseInt(process.env.FEE_BPS || "200"); // 2%

  // Testnets (hardhat, localhost, amoy) always use MockBRZ — no real BRZ exists there.
  // Only mainnet (polygon) uses the real BRZ token address.
  const isTestNetwork = ["hardhat", "localhost", "amoy"].includes(network.name);

  if (isTestNetwork) {
    console.log("▶ Deploying MockBRZ (test network)...");
    const MockBRZ = await ethers.getContractFactory("MockBRZ");
    const mockBrz = await MockBRZ.deploy();
    await mockBrz.waitForDeployment();
    brzToken = await mockBrz.getAddress();
    feeCollector = deployer.address;
    console.log(`  MockBRZ deployed at: ${brzToken}`);
  } else {
    // Mainnet: use the real BRZ token address
    brzToken = process.env.BRZ_TOKEN_ADDRESS!;
    feeCollector = process.env.FEE_COLLECTOR_ADDRESS!;

    if (!brzToken || !ethers.isAddress(brzToken)) {
      throw new Error("BRZ_TOKEN_ADDRESS not set or invalid in .env");
    }
    if (!feeCollector || !ethers.isAddress(feeCollector)) {
      throw new Error("FEE_COLLECTOR_ADDRESS not set or invalid in .env");
    }
  }

  console.log(`\nDeployment parameters:`);
  console.log(`  BRZ Token:     ${brzToken}`);
  console.log(`  Fee Collector: ${feeCollector}`);
  console.log(`  Fee BPS:       ${feeBps} (${feeBps / 100}%)\n`);

  // ── Deploy LoanFactory ────────────────────────────────────────────────────

  console.log("▶ Deploying LoanFactory...");
  const LoanFactory = await ethers.getContractFactory("LoanFactory");
  const factory = await LoanFactory.deploy(brzToken, feeCollector, feeBps);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log(`  LoanFactory deployed at: ${factoryAddress}`);

  // Wait for a few confirmations before verifying on non-local networks
  if (network.name !== "hardhat" && network.name !== "localhost") {
    console.log("\n  Waiting for 5 confirmations...");
    await factory.deploymentTransaction()?.wait(5);
  }

  // ── Save deployment addresses ─────────────────────────────────────────────

  const deployment: DeploymentAddresses = {
    network: network.name,
    chainId: Number(chainId),
    brzToken,
    feeCollector,
    feeBps,
    loanFactory: factoryAddress,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
  };

  const deployBlock = await ethers.provider.getBlockNumber();

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const filePath = path.join(deploymentsDir, `${network.name}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ ...deployment, deployBlock }, null, 2));
  console.log(`\n✅ Deployment saved to: ${filePath}`);

  // ── Auto-update backend/.env ──────────────────────────────────────────────
  // Update the three blockchain vars that change with every deploy,
  // leaving all other backend env vars (DB, Privy, etc.) untouched.

  const backendEnvPath = path.join(__dirname, "..", "backend", ".env");
  if (fs.existsSync(backendEnvPath)) {
    let envContent = fs.readFileSync(backendEnvPath, "utf8");

    const replace = (key: string, value: string) => {
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    };

    replace("LOAN_FACTORY_ADDRESS", factoryAddress);
    replace("BRZ_TOKEN_ADDRESS", brzToken);
    replace("DEPLOY_BLOCK", String(deployBlock));

    fs.writeFileSync(backendEnvPath, envContent);
    console.log(`✅ backend/.env updated (LOAN_FACTORY_ADDRESS, BRZ_TOKEN_ADDRESS, DEPLOY_BLOCK=${deployBlock})`);
  }

  // ── Verify on Polygonscan ─────────────────────────────────────────────────

  if (network.name !== "hardhat" && network.name !== "localhost") {
    await verifyContract(factoryAddress, [brzToken, feeCollector, feeBps]);
  }

  console.log("\n─────────────────────────────────────────────");
  console.log("Deployment complete!");
  console.log("─────────────────────────────────────────────");
  console.log(`LoanFactory: ${factoryAddress}`);
}

async function verifyContract(address: string, constructorArgs: unknown[]) {
  console.log(`\n▶ Verifying contract on Polygonscan...`);
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
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
