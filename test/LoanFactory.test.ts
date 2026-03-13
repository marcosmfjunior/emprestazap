import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { LoanFactory, MockBRZ, BulletLoan } from "../typechain-types";

// ─── Constants ────────────────────────────────────────────────────────────────

const PRINCIPAL = ethers.parseEther("1000");
const ANNUAL_RATE_BPS = 2400;   // 24%
const TERM_MONTHS = 12;
const FEE_BPS = 200;            // 2%

// ─── Fixture ─────────────────────────────────────────────────────────────────

async function deployFactoryFixture() {
  const [owner, lender, borrower, feeCollector, other] =
    await ethers.getSigners();

  const BRZ = await ethers.getContractFactory("MockBRZ");
  const brz = (await BRZ.deploy()) as MockBRZ;

  // Distribute BRZ
  await brz.mint(lender.address, ethers.parseEther("100000"));
  await brz.mint(borrower.address, ethers.parseEther("100000"));
  await brz.mint(other.address, ethers.parseEther("100000"));

  const LF = await ethers.getContractFactory("LoanFactory");
  const factory = (await LF.deploy(
    await brz.getAddress(),
    feeCollector.address,
    FEE_BPS,
  )) as LoanFactory;

  return { factory, brz, owner, lender, borrower, feeCollector, other };
}

/** Helper: lender creates and funds a loan via the factory. */
async function createLoanViaFactory(
  factory: LoanFactory,
  brz: MockBRZ,
  lender: ReturnType<typeof ethers.getSigners> extends Promise<infer T>
    ? T[number]
    : never,
) {
  await brz.connect(lender).approve(await factory.getAddress(), PRINCIPAL);
  const tx = await factory.connect(lender).createLoan(
    PRINCIPAL,
    ANNUAL_RATE_BPS,
    TERM_MONTHS,
  );
  const receipt = await tx.wait();

  // Parse LoanCreated event to get the loan address
  const iface = factory.interface;
  let loanAddress: string | undefined;
  for (const log of receipt!.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "LoanCreated") {
        loanAddress = parsed.args.loanAddress;
        break;
      }
    } catch { /* non-factory events */ }
  }

  if (!loanAddress) throw new Error("LoanCreated event not found");
  return loanAddress;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("LoanFactory", function () {
  // ── createLoan ───────────────────────────────────────────────────────────────

  describe("createLoan()", function () {
    it("deploys a BulletLoan and registers it", async function () {
      const { factory, brz, lender } = await loadFixture(deployFactoryFixture);
      const loanAddress = await createLoanViaFactory(factory, brz, lender);

      expect(await factory.getLoanCount()).to.equal(1);
      const allLoans = await factory.getAllLoans();
      expect(allLoans[0]).to.equal(loanAddress);
    });

    it("emits LoanCreated event", async function () {
      const { factory, brz, lender } = await loadFixture(deployFactoryFixture);
      await brz.connect(lender).approve(await factory.getAddress(), PRINCIPAL);
      await expect(
        factory.connect(lender).createLoan(PRINCIPAL, ANNUAL_RATE_BPS, TERM_MONTHS),
      )
        .to.emit(factory, "LoanCreated")
        .withArgs(
          // loanAddress is not known ahead of time; use anyValue
          (v: unknown) => typeof v === "string",
          lender.address,
          PRINCIPAL,
          ANNUAL_RATE_BPS,
          TERM_MONTHS,
        );
    });

    it("registers loan under lender", async function () {
      const { factory, brz, lender } = await loadFixture(deployFactoryFixture);
      const loanAddress = await createLoanViaFactory(factory, brz, lender);
      const byLender = await factory.getLoansByLender(lender.address);
      expect(byLender).to.include(loanAddress);
    });

    it("sets the loan to Funded status", async function () {
      const { factory, brz, lender } = await loadFixture(deployFactoryFixture);
      const loanAddress = await createLoanViaFactory(factory, brz, lender);
      const loan = await ethers.getContractAt("BulletLoan", loanAddress) as BulletLoan;
      expect(await loan.getStatus()).to.equal(1); // Status.Funded
    });

    it("adds loan to availableLoans", async function () {
      const { factory, brz, lender } = await loadFixture(deployFactoryFixture);
      const loanAddress = await createLoanViaFactory(factory, brz, lender);
      const available = await factory.getAvailableLoans();
      expect(available).to.include(loanAddress);
    });

    it("reverts if principal is 0", async function () {
      const { factory } = await loadFixture(deployFactoryFixture);
      await expect(
        factory.createLoan(0, ANNUAL_RATE_BPS, TERM_MONTHS),
      ).to.be.revertedWith("LoanFactory: principal must be > 0");
    });

    it("reverts if term is 0", async function () {
      const { factory, brz, lender } = await loadFixture(deployFactoryFixture);
      await brz.connect(lender).approve(await factory.getAddress(), PRINCIPAL);
      await expect(
        factory.connect(lender).createLoan(PRINCIPAL, ANNUAL_RATE_BPS, 0),
      ).to.be.revertedWith("LoanFactory: term must be > 0");
    });

    it("reverts if lender has not approved factory", async function () {
      const { factory, lender } = await loadFixture(deployFactoryFixture);
      await expect(
        factory.connect(lender).createLoan(PRINCIPAL, ANNUAL_RATE_BPS, TERM_MONTHS),
      ).to.be.reverted;
    });
  });

  // ── getAvailableLoans / after drawdown ────────────────────────────────────────

  describe("getAvailableLoans()", function () {
    it("returns only Funded loans", async function () {
      const { factory, brz, lender } = await loadFixture(deployFactoryFixture);
      const addr1 = await createLoanViaFactory(factory, brz, lender);
      await createLoanViaFactory(factory, brz, lender);

      const available = await factory.getAvailableLoans();
      expect(available).to.have.length(2);
    });

    it("removes loan from availableLoans after drawdown", async function () {
      const { factory, brz, lender, borrower } = await loadFixture(deployFactoryFixture);
      const loanAddress = await createLoanViaFactory(factory, brz, lender);

      const loan = await ethers.getContractAt("BulletLoan", loanAddress) as BulletLoan;
      await loan.connect(borrower).drawdown();

      const available = await factory.getAvailableLoans();
      expect(available).to.not.include(loanAddress);
    });
  });

  // ── getLoansByLender / getLoansByBorrower ─────────────────────────────────────

  describe("getLoansByLender()", function () {
    it("returns all loans for a lender", async function () {
      const { factory, brz, lender } = await loadFixture(deployFactoryFixture);
      const addr1 = await createLoanViaFactory(factory, brz, lender);
      const addr2 = await createLoanViaFactory(factory, brz, lender);
      const byLender = await factory.getLoansByLender(lender.address);
      expect(byLender).to.include(addr1);
      expect(byLender).to.include(addr2);
    });

    it("returns empty array for address with no loans", async function () {
      const { factory, other } = await loadFixture(deployFactoryFixture);
      const result = await factory.getLoansByLender(other.address);
      expect(result).to.be.empty;
    });
  });

  describe("getLoansByBorrower()", function () {
    it("registers borrower after drawdown", async function () {
      const { factory, brz, lender, borrower } = await loadFixture(deployFactoryFixture);
      const loanAddress = await createLoanViaFactory(factory, brz, lender);

      const loan = await ethers.getContractAt("BulletLoan", loanAddress) as BulletLoan;
      await loan.connect(borrower).drawdown();

      const byBorrower = await factory.getLoansByBorrower(borrower.address);
      expect(byBorrower).to.include(loanAddress);
    });
  });

  // ── Admin functions ───────────────────────────────────────────────────────────

  describe("setFeeBps()", function () {
    it("allows owner to update feeBps", async function () {
      const { factory, owner } = await loadFixture(deployFactoryFixture);
      await factory.connect(owner).setFeeBps(300);
      expect(await factory.feeBps()).to.equal(300);
    });

    it("emits FeeBpsUpdated event", async function () {
      const { factory, owner } = await loadFixture(deployFactoryFixture);
      await expect(factory.connect(owner).setFeeBps(300))
        .to.emit(factory, "FeeBpsUpdated")
        .withArgs(FEE_BPS, 300);
    });

    it("reverts for non-owner", async function () {
      const { factory, other } = await loadFixture(deployFactoryFixture);
      await expect(factory.connect(other).setFeeBps(300)).to.be.reverted;
    });

    it("reverts if fee > 100%", async function () {
      const { factory, owner } = await loadFixture(deployFactoryFixture);
      await expect(factory.connect(owner).setFeeBps(10_001)).to.be.revertedWith(
        "LoanFactory: fee cannot exceed 100%",
      );
    });
  });

  describe("setFeeCollector()", function () {
    it("allows owner to update feeCollector", async function () {
      const { factory, owner, other } = await loadFixture(deployFactoryFixture);
      await factory.connect(owner).setFeeCollector(other.address);
      expect(await factory.feeCollector()).to.equal(other.address);
    });

    it("emits FeeCollectorUpdated event", async function () {
      const { factory, owner, other, feeCollector } = await loadFixture(deployFactoryFixture);
      await expect(factory.connect(owner).setFeeCollector(other.address))
        .to.emit(factory, "FeeCollectorUpdated")
        .withArgs(feeCollector.address, other.address);
    });

    it("reverts for non-owner", async function () {
      const { factory, other } = await loadFixture(deployFactoryFixture);
      await expect(factory.connect(other).setFeeCollector(other.address)).to.be.reverted;
    });

    it("reverts for zero address", async function () {
      const { factory, owner } = await loadFixture(deployFactoryFixture);
      await expect(
        factory.connect(owner).setFeeCollector(ethers.ZeroAddress),
      ).to.be.revertedWith("LoanFactory: invalid address");
    });
  });

  // ── registerBorrower access control ──────────────────────────────────────────

  describe("registerBorrower() access control", function () {
    it("reverts when called by an EOA (not a factory loan)", async function () {
      const { factory, other } = await loadFixture(deployFactoryFixture);
      await expect(
        factory.connect(other).registerBorrower(other.address, other.address),
      ).to.be.revertedWith("LoanFactory: caller is not a factory loan");
    });
  });
});
