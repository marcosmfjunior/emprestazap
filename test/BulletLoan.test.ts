import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { BulletLoan, MockBRZ } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// ─── Constants ────────────────────────────────────────────────────────────────

const PRINCIPAL = ethers.parseEther("1000");   // 1,000 BRZ
const ANNUAL_RATE_BPS = 2400;                  // 24% per year
const TERM_MONTHS = 12;
const FEE_BPS = 200;                           // 2% on interest
const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;  // 30 days

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute expected totalOwed in TypeScript (mirrors CompoundMath.sol).
 * Uses BigInt arithmetic with PRECISION = 1e18.
 */
function computeTotalOwed(
  principal: bigint,
  annualRateBps: bigint,
  termMonths: bigint,
): bigint {
  const PRECISION = 10n ** 18n;
  const monthlyFactor =
    PRECISION + (annualRateBps * PRECISION) / (10_000n * 12n);

  // Exponentiation by squaring
  let result = PRECISION;
  let base = monthlyFactor;
  let exp = termMonths;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) / PRECISION;
    base = (base * base) / PRECISION;
    exp /= 2n;
  }
  return (principal * result) / PRECISION;
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

async function deployLoanFixture() {
  const [owner, lender, borrower, feeCollector, other] =
    await ethers.getSigners();

  // Deploy MockBRZ
  const BRZ = await ethers.getContractFactory("MockBRZ");
  const brz = (await BRZ.deploy()) as MockBRZ;

  // Mint BRZ to lender and borrower
  await brz.mint(lender.address, ethers.parseEther("10000"));
  await brz.mint(borrower.address, ethers.parseEther("10000"));

  // Deploy BulletLoan directly (no factory) so we can test fund()
  const BulletLoanFactory = await ethers.getContractFactory("BulletLoan");
  const loan = (await BulletLoanFactory.deploy(
    await brz.getAddress(),
    lender.address,
    PRINCIPAL,
    ANNUAL_RATE_BPS,
    TERM_MONTHS,
    FEE_BPS,
    feeCollector.address,
    owner.address, // factory = owner for direct tests
  )) as BulletLoan;

  return { loan, brz, owner, lender, borrower, feeCollector, other };
}

async function fundedLoanFixture() {
  const base = await deployLoanFixture();
  const { loan, brz, lender } = base;

  await brz.connect(lender).approve(await loan.getAddress(), PRINCIPAL);
  await loan.connect(lender).fund();

  return base;
}

async function activeLoanFixture() {
  const base = await fundedLoanFixture();
  const { loan, borrower } = base;

  // registerBorrower is called from the loan back to owner (factory),
  // but in direct tests the factory is set to owner who won't revert.
  // We need to mock the factory callback. In direct tests we just need to
  // ensure the loan's factory (owner) doesn't revert. Since LoanFactory is
  // not deployed here, we use the owner address as factory — the callback
  // call will revert unless we stub it out.
  //
  // Solution: redeploy the loan pointing to a stub factory that accepts all calls.
  const { brz, lender, feeCollector, owner } = base;
  const StubFactory = await ethers.getContractFactory("MockFactory");
  const stubFactory = await StubFactory.deploy();

  const BulletLoanFactory = await ethers.getContractFactory("BulletLoan");
  const loan2 = (await BulletLoanFactory.deploy(
    await brz.getAddress(),
    lender.address,
    PRINCIPAL,
    ANNUAL_RATE_BPS,
    TERM_MONTHS,
    FEE_BPS,
    feeCollector.address,
    await stubFactory.getAddress(),
  )) as BulletLoan;

  await brz.connect(lender).approve(await loan2.getAddress(), PRINCIPAL);
  await loan2.connect(lender).fund();
  await loan2.connect(borrower).drawdown();

  return { ...base, loan: loan2 };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("BulletLoan", function () {
  // ── Constructor / totalOwed calculation ─────────────────────────────────────

  describe("Constructor", function () {
    it("calculates totalOwed correctly for 24% annual, 12 months", async function () {
      const { loan } = await loadFixture(deployLoanFixture);
      const expected = computeTotalOwed(
        PRINCIPAL,
        BigInt(ANNUAL_RATE_BPS),
        BigInt(TERM_MONTHS),
      );
      expect(await loan.totalOwed()).to.equal(expected);
    });

    it("calculates totalOwed correctly for 0% rate", async function () {
      const [, lender, , feeCollector, , owner] = await ethers.getSigners();
      const BRZ = await ethers.getContractFactory("MockBRZ");
      const brz = await BRZ.deploy();
      const BulletLoanFactory = await ethers.getContractFactory("BulletLoan");
      const loan = await BulletLoanFactory.deploy(
        await brz.getAddress(),
        lender.address,
        PRINCIPAL,
        0,          // 0% rate
        TERM_MONTHS,
        FEE_BPS,
        feeCollector.address,
        owner.address,
      );
      expect(await loan.totalOwed()).to.equal(PRINCIPAL);
    });

    it("calculates totalOwed correctly for 12% annual, 6 months", async function () {
      const [, lender, , feeCollector, owner] = await ethers.getSigners();
      const BRZ = await ethers.getContractFactory("MockBRZ");
      const brz = await BRZ.deploy();
      const BulletLoanFactory = await ethers.getContractFactory("BulletLoan");
      const loan = await BulletLoanFactory.deploy(
        await brz.getAddress(),
        lender.address,
        PRINCIPAL,
        1200,      // 12% annual
        6,         // 6 months
        FEE_BPS,
        feeCollector.address,
        owner.address,
      );
      const expected = computeTotalOwed(PRINCIPAL, 1200n, 6n);
      expect(await loan.totalOwed()).to.equal(expected);
    });

    it("starts in Created status", async function () {
      const { loan } = await loadFixture(deployLoanFixture);
      expect(await loan.getStatus()).to.equal(0); // Status.Created
    });
  });

  // ── fund() ───────────────────────────────────────────────────────────────────

  describe("fund()", function () {
    it("transitions to Funded when called by lender", async function () {
      const { loan, brz, lender } = await loadFixture(deployLoanFixture);
      await brz.connect(lender).approve(await loan.getAddress(), PRINCIPAL);
      await loan.connect(lender).fund();
      expect(await loan.getStatus()).to.equal(1); // Status.Funded
    });

    it("emits LoanFunded event", async function () {
      const { loan, brz, lender } = await loadFixture(deployLoanFixture);
      await brz.connect(lender).approve(await loan.getAddress(), PRINCIPAL);
      await expect(loan.connect(lender).fund())
        .to.emit(loan, "LoanFunded")
        .withArgs(await loan.getAddress(), PRINCIPAL);
    });

    it("reverts if caller is not lender", async function () {
      const { loan, brz, other } = await loadFixture(deployLoanFixture);
      await brz.connect(other).approve(await loan.getAddress(), PRINCIPAL);
      await expect(loan.connect(other).fund()).to.be.revertedWith(
        "BulletLoan: caller is not lender",
      );
    });

    it("reverts if status is not Created", async function () {
      const { loan, brz, lender } = await loadFixture(deployLoanFixture);
      await brz.connect(lender).approve(await loan.getAddress(), PRINCIPAL * 2n);
      await loan.connect(lender).fund();
      await expect(loan.connect(lender).fund()).to.be.revertedWith(
        "BulletLoan: invalid status for this action",
      );
    });

    it("reverts if lender has insufficient approval", async function () {
      const { loan, brz, lender } = await loadFixture(deployLoanFixture);
      await brz.connect(lender).approve(await loan.getAddress(), PRINCIPAL - 1n);
      await expect(loan.connect(lender).fund()).to.be.reverted;
    });
  });

  // ── drawdown() ───────────────────────────────────────────────────────────────

  describe("drawdown()", function () {
    it("sets borrower and activates loan", async function () {
      const { loan, brz, lender, borrower } = await loadFixture(fundedLoanFixture);

      const StubFactory = await ethers.getContractFactory("MockFactory");
      const stubFactory = await StubFactory.deploy();
      const BulletLoanFactory = await ethers.getContractFactory("BulletLoan");
      const loan2 = (await BulletLoanFactory.deploy(
        await brz.getAddress(), lender.address, PRINCIPAL, ANNUAL_RATE_BPS,
        TERM_MONTHS, FEE_BPS, (await ethers.getSigners())[3].address,
        await stubFactory.getAddress(),
      )) as BulletLoan;
      await brz.connect(lender).approve(await loan2.getAddress(), PRINCIPAL);
      await loan2.connect(lender).fund();

      await loan2.connect(borrower).drawdown();

      expect(await loan2.borrower()).to.equal(borrower.address);
      expect(await loan2.getStatus()).to.equal(2); // Status.Active
    });

    it("transfers principal to borrower", async function () {
      const { brz, lender, borrower } = await loadFixture(fundedLoanFixture);
      const StubFactory = await ethers.getContractFactory("MockFactory");
      const stubFactory = await StubFactory.deploy();
      const BulletLoanFactory = await ethers.getContractFactory("BulletLoan");
      const loan2 = (await BulletLoanFactory.deploy(
        await brz.getAddress(), lender.address, PRINCIPAL, ANNUAL_RATE_BPS,
        TERM_MONTHS, FEE_BPS, (await ethers.getSigners())[3].address,
        await stubFactory.getAddress(),
      )) as BulletLoan;
      await brz.connect(lender).approve(await loan2.getAddress(), PRINCIPAL);
      await loan2.connect(lender).fund();

      const before = await brz.balanceOf(borrower.address);
      await loan2.connect(borrower).drawdown();
      const after = await brz.balanceOf(borrower.address);

      expect(after - before).to.equal(PRINCIPAL);
    });

    it("sets dueDate correctly", async function () {
      const { brz, lender, borrower } = await loadFixture(fundedLoanFixture);
      const StubFactory = await ethers.getContractFactory("MockFactory");
      const stubFactory = await StubFactory.deploy();
      const BulletLoanFactory = await ethers.getContractFactory("BulletLoan");
      const loan2 = (await BulletLoanFactory.deploy(
        await brz.getAddress(), lender.address, PRINCIPAL, ANNUAL_RATE_BPS,
        TERM_MONTHS, FEE_BPS, (await ethers.getSigners())[3].address,
        await stubFactory.getAddress(),
      )) as BulletLoan;
      await brz.connect(lender).approve(await loan2.getAddress(), PRINCIPAL);
      await loan2.connect(lender).fund();
      await loan2.connect(borrower).drawdown();

      const activatedAt = await loan2.activatedAt();
      const dueDate = await loan2.dueDate();
      expect(dueDate).to.equal(activatedAt + BigInt(TERM_MONTHS * SECONDS_PER_MONTH));
    });

    it("emits LoanActivated event", async function () {
      const { brz, lender, borrower } = await loadFixture(fundedLoanFixture);
      const StubFactory = await ethers.getContractFactory("MockFactory");
      const stubFactory = await StubFactory.deploy();
      const BulletLoanFactory = await ethers.getContractFactory("BulletLoan");
      const loan2 = (await BulletLoanFactory.deploy(
        await brz.getAddress(), lender.address, PRINCIPAL, ANNUAL_RATE_BPS,
        TERM_MONTHS, FEE_BPS, (await ethers.getSigners())[3].address,
        await stubFactory.getAddress(),
      )) as BulletLoan;
      await brz.connect(lender).approve(await loan2.getAddress(), PRINCIPAL);
      await loan2.connect(lender).fund();

      await expect(loan2.connect(borrower).drawdown()).to.emit(loan2, "LoanActivated");
    });

    it("reverts if caller is lender", async function () {
      const { loan, lender } = await loadFixture(fundedLoanFixture);
      await expect(loan.connect(lender).drawdown()).to.be.revertedWith(
        "BulletLoan: lender cannot be borrower",
      );
    });

    it("reverts if status is not Funded", async function () {
      const { loan, lender, borrower } = await loadFixture(deployLoanFixture);
      await expect(loan.connect(borrower).drawdown()).to.be.revertedWith(
        "BulletLoan: invalid status for this action",
      );
    });
  });

  // ── repay() ───────────────────────────────────────────────────────────────────

  describe("repay()", function () {
    async function getActiveLoan() {
      const [, lender, borrower, feeCollector] = await ethers.getSigners();
      const BRZ = await ethers.getContractFactory("MockBRZ");
      const brz = (await BRZ.deploy()) as MockBRZ;
      await brz.mint(lender.address, ethers.parseEther("10000"));
      await brz.mint(borrower.address, ethers.parseEther("10000"));

      const StubFactory = await ethers.getContractFactory("MockFactory");
      const stubFactory = await StubFactory.deploy();
      const BLF = await ethers.getContractFactory("BulletLoan");
      const loan = (await BLF.deploy(
        await brz.getAddress(), lender.address, PRINCIPAL, ANNUAL_RATE_BPS,
        TERM_MONTHS, FEE_BPS, feeCollector.address, await stubFactory.getAddress(),
      )) as BulletLoan;

      await brz.connect(lender).approve(await loan.getAddress(), PRINCIPAL);
      await loan.connect(lender).fund();
      await loan.connect(borrower).drawdown();

      return { loan, brz, lender, borrower, feeCollector };
    }

    it("distributes funds correctly between lender and feeCollector", async function () {
      const { loan, brz, lender, borrower, feeCollector } = await getActiveLoan();

      const totalOwed = await loan.totalOwed();
      const expectedFee = ((totalOwed - PRINCIPAL) * BigInt(FEE_BPS)) / 10_000n;
      const expectedLenderAmount = totalOwed - expectedFee;

      await brz.connect(borrower).approve(await loan.getAddress(), totalOwed);

      const lenderBefore = await brz.balanceOf(lender.address);
      const feeBefore = await brz.balanceOf(feeCollector.address);

      await loan.connect(borrower).repay();

      expect(await brz.balanceOf(lender.address) - lenderBefore).to.equal(expectedLenderAmount);
      expect(await brz.balanceOf(feeCollector.address) - feeBefore).to.equal(expectedFee);
    });

    it("transitions to Repaid status", async function () {
      const { loan, brz, borrower } = await getActiveLoan();
      const totalOwed = await loan.totalOwed();
      await brz.connect(borrower).approve(await loan.getAddress(), totalOwed);
      await loan.connect(borrower).repay();
      expect(await loan.getStatus()).to.equal(3); // Status.Repaid
    });

    it("emits LoanRepaid event", async function () {
      const { loan, brz, borrower } = await getActiveLoan();
      const totalOwed = await loan.totalOwed();
      await brz.connect(borrower).approve(await loan.getAddress(), totalOwed);
      await expect(loan.connect(borrower).repay()).to.emit(loan, "LoanRepaid");
    });

    it("reverts if caller is not borrower", async function () {
      const { loan, brz, lender, borrower } = await getActiveLoan();
      const totalOwed = await loan.totalOwed();
      await brz.connect(lender).approve(await loan.getAddress(), totalOwed);
      await expect(loan.connect(lender).repay()).to.be.revertedWith(
        "BulletLoan: caller is not borrower",
      );
    });

    it("reverts if borrower has insufficient balance", async function () {
      const [, lender, borrower, feeCollector] = await ethers.getSigners();
      const BRZ = await ethers.getContractFactory("MockBRZ");
      const brz = (await BRZ.deploy()) as MockBRZ;
      await brz.mint(lender.address, ethers.parseEther("10000"));
      // Borrower starts with 0 BRZ. After drawdown they receive exactly PRINCIPAL.
      // totalOwed > PRINCIPAL (compound interest), so repay will fail.

      const StubFactory = await ethers.getContractFactory("MockFactory");
      const stubFactory = await StubFactory.deploy();
      const BLF = await ethers.getContractFactory("BulletLoan");
      const loan = (await BLF.deploy(
        await brz.getAddress(), lender.address, PRINCIPAL, ANNUAL_RATE_BPS,
        TERM_MONTHS, FEE_BPS, feeCollector.address, await stubFactory.getAddress(),
      )) as BulletLoan;
      await brz.connect(lender).approve(await loan.getAddress(), PRINCIPAL);
      await loan.connect(lender).fund();
      await loan.connect(borrower).drawdown();

      // Borrower has PRINCIPAL but totalOwed > PRINCIPAL — must revert.
      const totalOwed = await loan.totalOwed();
      expect(await brz.balanceOf(borrower.address)).to.equal(PRINCIPAL);
      await brz.connect(borrower).approve(await loan.getAddress(), totalOwed);
      await expect(loan.connect(borrower).repay()).to.be.reverted;
    });

    it("reverts if borrower has not approved enough", async function () {
      const { loan, brz, borrower } = await getActiveLoan();
      const totalOwed = await loan.totalOwed();
      await brz.connect(borrower).approve(await loan.getAddress(), totalOwed - 1n);
      await expect(loan.connect(borrower).repay()).to.be.reverted;
    });
  });

  // ── claimDefault() ────────────────────────────────────────────────────────────

  describe("claimDefault()", function () {
    async function getActiveLoan() {
      const [, lender, borrower, feeCollector] = await ethers.getSigners();
      const BRZ = await ethers.getContractFactory("MockBRZ");
      const brz = (await BRZ.deploy()) as MockBRZ;
      await brz.mint(lender.address, ethers.parseEther("10000"));
      await brz.mint(borrower.address, ethers.parseEther("10000"));

      const StubFactory = await ethers.getContractFactory("MockFactory");
      const stubFactory = await StubFactory.deploy();
      const BLF = await ethers.getContractFactory("BulletLoan");
      const loan = (await BLF.deploy(
        await brz.getAddress(), lender.address, PRINCIPAL, ANNUAL_RATE_BPS,
        TERM_MONTHS, FEE_BPS, feeCollector.address, await stubFactory.getAddress(),
      )) as BulletLoan;
      await brz.connect(lender).approve(await loan.getAddress(), PRINCIPAL);
      await loan.connect(lender).fund();
      await loan.connect(borrower).drawdown();

      return { loan, brz, lender, borrower };
    }

    it("marks loan as Defaulted after due date", async function () {
      const { loan, lender } = await getActiveLoan();
      const dueDate = await loan.dueDate();
      await time.increaseTo(dueDate + 1n);
      await loan.connect(lender).claimDefault();
      expect(await loan.getStatus()).to.equal(4); // Status.Defaulted
    });

    it("emits LoanDefaulted event", async function () {
      const { loan, lender } = await getActiveLoan();
      const dueDate = await loan.dueDate();
      await time.increaseTo(dueDate + 1n);
      await expect(loan.connect(lender).claimDefault())
        .to.emit(loan, "LoanDefaulted");
    });

    it("reverts if called before due date", async function () {
      const { loan, lender } = await getActiveLoan();
      await expect(loan.connect(lender).claimDefault()).to.be.revertedWith(
        "BulletLoan: loan is not overdue yet",
      );
    });

    it("reverts if caller is not lender", async function () {
      const { loan, borrower } = await getActiveLoan();
      const dueDate = await loan.dueDate();
      await time.increaseTo(dueDate + 1n);
      await expect(loan.connect(borrower).claimDefault()).to.be.revertedWith(
        "BulletLoan: caller is not lender",
      );
    });
  });

  // ── cancelLoan() ──────────────────────────────────────────────────────────────

  describe("cancelLoan()", function () {
    it("returns principal to lender", async function () {
      const { loan, brz, lender } = await loadFixture(fundedLoanFixture);
      const before = await brz.balanceOf(lender.address);
      await loan.connect(lender).cancelLoan();
      const after = await brz.balanceOf(lender.address);
      expect(after - before).to.equal(PRINCIPAL);
    });

    it("transitions to Cancelled status", async function () {
      const { loan, lender } = await loadFixture(fundedLoanFixture);
      await loan.connect(lender).cancelLoan();
      expect(await loan.getStatus()).to.equal(5); // Status.Cancelled
    });

    it("emits LoanCancelled event", async function () {
      const { loan, lender } = await loadFixture(fundedLoanFixture);
      await expect(loan.connect(lender).cancelLoan())
        .to.emit(loan, "LoanCancelled")
        .withArgs(await loan.getAddress());
    });

    it("reverts if status is not Funded", async function () {
      const { loan, lender } = await loadFixture(deployLoanFixture);
      await expect(loan.connect(lender).cancelLoan()).to.be.revertedWith(
        "BulletLoan: invalid status for this action",
      );
    });

    it("reverts if caller is not lender", async function () {
      const { loan, other } = await loadFixture(fundedLoanFixture);
      await expect(loan.connect(other).cancelLoan()).to.be.revertedWith(
        "BulletLoan: caller is not lender",
      );
    });
  });

  // ── isOverdue() ───────────────────────────────────────────────────────────────

  describe("isOverdue()", function () {
    it("returns false before due date", async function () {
      const [, lender, borrower, feeCollector] = await ethers.getSigners();
      const BRZ = await ethers.getContractFactory("MockBRZ");
      const brz = (await BRZ.deploy()) as MockBRZ;
      await brz.mint(lender.address, ethers.parseEther("10000"));
      await brz.mint(borrower.address, ethers.parseEther("10000"));
      const StubFactory = await ethers.getContractFactory("MockFactory");
      const stubFactory = await StubFactory.deploy();
      const BLF = await ethers.getContractFactory("BulletLoan");
      const loan = (await BLF.deploy(
        await brz.getAddress(), lender.address, PRINCIPAL, ANNUAL_RATE_BPS,
        TERM_MONTHS, FEE_BPS, feeCollector.address, await stubFactory.getAddress(),
      )) as BulletLoan;
      await brz.connect(lender).approve(await loan.getAddress(), PRINCIPAL);
      await loan.connect(lender).fund();
      await loan.connect(borrower).drawdown();
      expect(await loan.isOverdue()).to.be.false;
    });

    it("returns true after due date", async function () {
      const [, lender, borrower, feeCollector] = await ethers.getSigners();
      const BRZ = await ethers.getContractFactory("MockBRZ");
      const brz = (await BRZ.deploy()) as MockBRZ;
      await brz.mint(lender.address, ethers.parseEther("10000"));
      await brz.mint(borrower.address, ethers.parseEther("10000"));
      const StubFactory = await ethers.getContractFactory("MockFactory");
      const stubFactory = await StubFactory.deploy();
      const BLF = await ethers.getContractFactory("BulletLoan");
      const loan = (await BLF.deploy(
        await brz.getAddress(), lender.address, PRINCIPAL, ANNUAL_RATE_BPS,
        TERM_MONTHS, FEE_BPS, feeCollector.address, await stubFactory.getAddress(),
      )) as BulletLoan;
      await brz.connect(lender).approve(await loan.getAddress(), PRINCIPAL);
      await loan.connect(lender).fund();
      await loan.connect(borrower).drawdown();

      const dueDate = await loan.dueDate();
      await time.increaseTo(dueDate + 1n);
      expect(await loan.isOverdue()).to.be.true;
    });
  });
});
