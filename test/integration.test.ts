import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { LoanFactory, MockBRZ, BulletLoan } from "../typechain-types";

// ─── Constants ────────────────────────────────────────────────────────────────

const PRINCIPAL = ethers.parseEther("1000");
const ANNUAL_RATE_BPS = 2400;
const TERM_MONTHS = 12;
const FEE_BPS = 200;
const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function setup() {
  const [owner, lender, borrower, feeCollector] = await ethers.getSigners();

  const BRZ = await ethers.getContractFactory("MockBRZ");
  const brz = (await BRZ.deploy()) as MockBRZ;

  await brz.mint(lender.address, ethers.parseEther("100000"));
  await brz.mint(borrower.address, ethers.parseEther("100000"));

  const LF = await ethers.getContractFactory("LoanFactory");
  const factory = (await LF.deploy(
    await brz.getAddress(),
    feeCollector.address,
    FEE_BPS,
  )) as LoanFactory;

  return { factory, brz, owner, lender, borrower, feeCollector };
}

async function createFundedLoan(factory: LoanFactory, brz: MockBRZ, lender: any): Promise<BulletLoan> {
  await brz.connect(lender).approve(await factory.getAddress(), PRINCIPAL);
  const tx = await factory.connect(lender).createLoan(PRINCIPAL, ANNUAL_RATE_BPS, TERM_MONTHS);
  const receipt = await tx.wait();

  const iface = factory.interface;
  for (const log of receipt!.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "LoanCreated") {
        return await ethers.getContractAt("BulletLoan", parsed.args.loanAddress) as BulletLoan;
      }
    } catch { /* skip */ }
  }
  throw new Error("LoanCreated event not found");
}

// ─── Integration Tests ────────────────────────────────────────────────────────

describe("Integration", function () {
  // ── Happy path: full repayment ────────────────────────────────────────────────

  describe("Full repayment flow", function () {
    it("lender creates loan → borrower draws → borrower repays → balances correct", async function () {
      const { factory, brz, lender, borrower, feeCollector } = await setup();

      // ── 1. Create & fund loan ──────────────────────────────────────────────
      const lenderBalanceBefore = await brz.balanceOf(lender.address);
      const loan = await createFundedLoan(factory, brz, lender);

      // Lender's BRZ should be reduced by principal
      expect(await brz.balanceOf(lender.address)).to.equal(lenderBalanceBefore - PRINCIPAL);
      expect(await loan.getStatus()).to.equal(1); // Funded

      // Loan appears in marketplace
      const available = await factory.getAvailableLoans();
      expect(available).to.include(await loan.getAddress());

      // ── 2. Borrower draws down ─────────────────────────────────────────────
      const borrowerBalanceBefore = await brz.balanceOf(borrower.address);
      await loan.connect(borrower).drawdown();

      expect(await loan.getStatus()).to.equal(2); // Active
      expect(await brz.balanceOf(borrower.address)).to.equal(borrowerBalanceBefore + PRINCIPAL);

      // Loan removed from marketplace
      const availableAfter = await factory.getAvailableLoans();
      expect(availableAfter).to.not.include(await loan.getAddress());

      // ── 3. Borrower repays ─────────────────────────────────────────────────
      const totalOwed = await loan.totalOwed();
      const expectedFee = ((totalOwed - PRINCIPAL) * BigInt(FEE_BPS)) / 10_000n;
      const expectedLenderAmount = totalOwed - expectedFee;

      await brz.connect(borrower).approve(await loan.getAddress(), totalOwed);

      const lenderBefore = await brz.balanceOf(lender.address);
      const feeBefore = await brz.balanceOf(feeCollector.address);

      await loan.connect(borrower).repay();

      expect(await loan.getStatus()).to.equal(3); // Repaid
      expect(await brz.balanceOf(lender.address) - lenderBefore).to.equal(expectedLenderAmount);
      expect(await brz.balanceOf(feeCollector.address) - feeBefore).to.equal(expectedFee);

      // ── 4. Verify factory indexes ──────────────────────────────────────────
      const byLender = await factory.getLoansByLender(lender.address);
      expect(byLender).to.include(await loan.getAddress());

      const byBorrower = await factory.getLoansByBorrower(borrower.address);
      expect(byBorrower).to.include(await loan.getAddress());
    });
  });

  // ── Default flow ──────────────────────────────────────────────────────────────

  describe("Default flow", function () {
    it("lender creates → borrower draws → due date passes → lender claims default", async function () {
      const { factory, brz, lender, borrower } = await setup();

      const loan = await createFundedLoan(factory, brz, lender);
      await loan.connect(borrower).drawdown();

      expect(await loan.getStatus()).to.equal(2); // Active
      expect(await loan.isOverdue()).to.be.false;

      // Fast-forward past due date
      const dueDate = await loan.dueDate();
      await time.increaseTo(dueDate + 1n);

      expect(await loan.isOverdue()).to.be.true;

      await loan.connect(lender).claimDefault();
      expect(await loan.getStatus()).to.equal(4); // Defaulted

      // After default, repay should revert (wrong status)
      const totalOwed = await loan.totalOwed();
      await brz.connect(borrower).approve(await loan.getAddress(), totalOwed);
      await expect(loan.connect(borrower).repay()).to.be.revertedWith(
        "BulletLoan: invalid status for this action",
      );
    });

    it("reverts claimDefault if called before due date", async function () {
      const { factory, brz, lender, borrower } = await setup();
      const loan = await createFundedLoan(factory, brz, lender);
      await loan.connect(borrower).drawdown();

      await expect(loan.connect(lender).claimDefault()).to.be.revertedWith(
        "BulletLoan: loan is not overdue yet",
      );
    });
  });

  // ── Cancellation flow ─────────────────────────────────────────────────────────

  describe("Cancellation flow", function () {
    it("lender creates → cancels → recovers BRZ", async function () {
      const { factory, brz, lender } = await setup();

      const lenderBalanceBefore = await brz.balanceOf(lender.address);
      const loan = await createFundedLoan(factory, brz, lender);

      // BRZ deducted
      expect(await brz.balanceOf(lender.address)).to.equal(lenderBalanceBefore - PRINCIPAL);

      await loan.connect(lender).cancelLoan();
      expect(await loan.getStatus()).to.equal(5); // Cancelled

      // BRZ fully returned
      expect(await brz.balanceOf(lender.address)).to.equal(lenderBalanceBefore);
    });

    it("no borrower can drawdown a cancelled loan", async function () {
      const { factory, brz, lender, borrower } = await setup();
      const loan = await createFundedLoan(factory, brz, lender);
      await loan.connect(lender).cancelLoan();

      await expect(loan.connect(borrower).drawdown()).to.be.revertedWith(
        "BulletLoan: invalid status for this action",
      );
    });
  });

  // ── Multiple loans ────────────────────────────────────────────────────────────

  describe("Multiple loans", function () {
    it("factory correctly tracks multiple loans from same lender", async function () {
      const { factory, brz, lender } = await setup();

      const loan1 = await createFundedLoan(factory, brz, lender);
      const loan2 = await createFundedLoan(factory, brz, lender);
      const loan3 = await createFundedLoan(factory, brz, lender);

      const byLender = await factory.getLoansByLender(lender.address);
      expect(byLender).to.have.length(3);
      expect(byLender).to.include(await loan1.getAddress());
      expect(byLender).to.include(await loan2.getAddress());
      expect(byLender).to.include(await loan3.getAddress());

      expect(await factory.getLoanCount()).to.equal(3);
    });

    it("availableLoans correctly handles multiple drawdowns", async function () {
      const { factory, brz, lender, borrower } = await setup();

      const loan1 = await createFundedLoan(factory, brz, lender);
      const loan2 = await createFundedLoan(factory, brz, lender);

      expect(await factory.getAvailableLoans()).to.have.length(2);

      // Borrower draws loan1
      await loan1.connect(borrower).drawdown();
      const avail1 = await factory.getAvailableLoans();
      expect(avail1).to.have.length(1);
      expect(avail1).to.not.include(await loan1.getAddress());
      expect(avail1).to.include(await loan2.getAddress());

      // Borrower draws loan2
      await loan2.connect(borrower).drawdown();
      expect(await factory.getAvailableLoans()).to.have.length(0);
    });
  });

  // ── Status transition guard ───────────────────────────────────────────────────

  describe("Status transitions", function () {
    it("cannot fund an already-funded loan", async function () {
      const { factory, brz, lender } = await setup();
      const loan = await createFundedLoan(factory, brz, lender);

      await brz.connect(lender).approve(await loan.getAddress(), PRINCIPAL);
      await expect(loan.connect(lender).fund()).to.be.revertedWith(
        "BulletLoan: invalid status for this action",
      );
    });

    it("cannot repay before drawdown", async function () {
      const { factory, brz, lender, borrower } = await setup();
      const loan = await createFundedLoan(factory, brz, lender);

      await brz.connect(borrower).approve(await loan.getAddress(), PRINCIPAL);
      await expect(loan.connect(borrower).repay()).to.be.revertedWith(
        "BulletLoan: caller is not borrower",
      );
    });

    it("cannot cancel an active loan", async function () {
      const { factory, brz, lender, borrower } = await setup();
      const loan = await createFundedLoan(factory, brz, lender);
      await loan.connect(borrower).drawdown();

      await expect(loan.connect(lender).cancelLoan()).to.be.revertedWith(
        "BulletLoan: invalid status for this action",
      );
    });

    it("cannot claimDefault on a repaid loan", async function () {
      const { factory, brz, lender, borrower } = await setup();
      const loan = await createFundedLoan(factory, brz, lender);
      await loan.connect(borrower).drawdown();

      const totalOwed = await loan.totalOwed();
      await brz.connect(borrower).approve(await loan.getAddress(), totalOwed);
      await loan.connect(borrower).repay();

      const dueDate = await loan.dueDate();
      await time.increaseTo(dueDate + 1n);
      await expect(loan.connect(lender).claimDefault()).to.be.revertedWith(
        "BulletLoan: invalid status for this action",
      );
    });
  });
});
