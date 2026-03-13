// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IBulletLoan.sol";
import "./libraries/CompoundMath.sol";

/**
 * @title BulletLoan
 * @notice A single bullet loan between a lender and a borrower using BRZ (ERC-20).
 *
 * Lifecycle:
 *   Created  → fund()        → Funded
 *   Funded   → drawdown()    → Active
 *   Active   → repay()       → Repaid
 *   Active   → claimDefault()→ Defaulted  (only after dueDate)
 *   Funded   → cancelLoan()  → Cancelled
 *
 * Interest model: compound, calculated once at deployment.
 *   totalOwed = principal × (1 + annualRateBps/10000/12)^termMonths
 *
 * Fee model: platform fee applied only to the interest portion.
 *   feeAmount   = (totalOwed - principal) × feeBps / 10000
 *   lenderAmount = totalOwed - feeAmount
 */
contract BulletLoan is IBulletLoan, ReentrancyGuard {
    // ─── Storage ──────────────────────────────────────────────────────────────

    address public lender;
    address public borrower;
    address public brzToken;
    address public feeCollector;
    address public factory;

    uint256 public principal;
    uint256 public annualRateBps;
    uint256 public termMonths;
    uint256 public totalOwed;
    uint256 public feeBps;

    uint256 public fundedAt;
    uint256 public activatedAt;
    uint256 public dueDate;

    Status public status;

    uint256 private constant SECONDS_PER_MONTH = 30 days;

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(
        address _brzToken,
        address _lender,
        uint256 _principal,
        uint256 _annualRateBps,
        uint256 _termMonths,
        uint256 _feeBps,
        address _feeCollector,
        address _factory
    ) {
        require(_brzToken != address(0), "BulletLoan: invalid BRZ address");
        require(_lender != address(0), "BulletLoan: invalid lender address");
        require(_principal > 0, "BulletLoan: principal must be > 0");
        require(_termMonths > 0, "BulletLoan: term must be > 0");
        require(_feeBps <= 10_000, "BulletLoan: fee cannot exceed 100%");
        require(_feeCollector != address(0), "BulletLoan: invalid feeCollector");
        require(_factory != address(0), "BulletLoan: invalid factory");

        brzToken = _brzToken;
        lender = _lender;
        principal = _principal;
        annualRateBps = _annualRateBps;
        termMonths = _termMonths;
        feeBps = _feeBps;
        feeCollector = _feeCollector;
        factory = _factory;

        totalOwed = CompoundMath.calculateTotalOwed(_principal, _annualRateBps, _termMonths);

        status = Status.Created;
    }

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyLender() {
        require(msg.sender == lender, "BulletLoan: caller is not lender");
        _;
    }

    modifier onlyBorrower() {
        require(msg.sender == borrower, "BulletLoan: caller is not borrower");
        _;
    }

    modifier inStatus(Status _required) {
        require(status == _required, "BulletLoan: invalid status for this action");
        _;
    }

    // ─── State-changing functions ─────────────────────────────────────────────

    /**
     * @notice Lender funds the loan by depositing `principal` BRZ into this contract.
     * @dev    Lender must have approved this contract for at least `principal` BRZ.
     */
    function fund() external nonReentrant onlyLender inStatus(Status.Created) {
        status = Status.Funded;
        fundedAt = block.timestamp;

        bool ok = IERC20(brzToken).transferFrom(msg.sender, address(this), principal);
        require(ok, "BulletLoan: BRZ transfer failed");

        emit LoanFunded(address(this), principal);
    }

    /**
     * @notice Called by the factory after it has already transferred BRZ to this
     *         contract directly.  Marks the loan as Funded without a second transfer.
     * @dev    Only the factory (set in constructor) can call this.  Tokens must
     *         already be present in the contract before this is called.
     */
    function fundFromFactory() external inStatus(Status.Created) {
        require(msg.sender == factory, "BulletLoan: caller is not factory");
        require(
            IERC20(brzToken).balanceOf(address(this)) >= principal,
            "BulletLoan: insufficient BRZ balance"
        );

        status = Status.Funded;
        fundedAt = block.timestamp;

        emit LoanFunded(address(this), principal);
    }

    /**
     * @notice Any address (except the lender) can draw down the loan.
     *         Borrower receives the full `principal` in BRZ.
     */
    function drawdown() external nonReentrant inStatus(Status.Funded) {
        require(msg.sender != lender, "BulletLoan: lender cannot be borrower");

        borrower = msg.sender;
        activatedAt = block.timestamp;
        dueDate = activatedAt + termMonths * SECONDS_PER_MONTH;
        status = Status.Active;

        // Notify the factory so it can update its indexes
        ILoanFactoryCallback(factory).registerBorrower(address(this), msg.sender);

        bool ok = IERC20(brzToken).transfer(borrower, principal);
        require(ok, "BulletLoan: BRZ transfer failed");

        emit LoanActivated(address(this), borrower, dueDate);
    }

    /**
     * @notice Borrower repays `totalOwed` BRZ.
     *         Funds are split between the lender and the fee collector.
     * @dev    Borrower must approve this contract for at least `totalOwed` BRZ beforehand.
     */
    function repay() external nonReentrant onlyBorrower inStatus(Status.Active) {
        uint256 feeAmount = CompoundMath.calculateFee(totalOwed, principal, feeBps);
        uint256 lenderAmount = totalOwed - feeAmount;

        status = Status.Repaid;

        bool ok1 = IERC20(brzToken).transferFrom(msg.sender, lender, lenderAmount);
        require(ok1, "BulletLoan: lender transfer failed");

        if (feeAmount > 0) {
            bool ok2 = IERC20(brzToken).transferFrom(msg.sender, feeCollector, feeAmount);
            require(ok2, "BulletLoan: fee transfer failed");
        }

        emit LoanRepaid(address(this), totalOwed, feeAmount);
    }

    /**
     * @notice Lender marks the loan as defaulted after the due date has passed.
     * @dev    This is an on-chain record only — no collateral or liquidation in v1.
     */
    function claimDefault() external nonReentrant onlyLender inStatus(Status.Active) {
        require(block.timestamp > dueDate, "BulletLoan: loan is not overdue yet");

        status = Status.Defaulted;

        emit LoanDefaulted(address(this), totalOwed);
    }

    /**
     * @notice Lender cancels the loan and recovers the deposited BRZ.
     *         Only possible when the loan is Funded (no borrower yet).
     */
    function cancelLoan() external nonReentrant onlyLender inStatus(Status.Funded) {
        status = Status.Cancelled;

        bool ok = IERC20(brzToken).transfer(lender, principal);
        require(ok, "BulletLoan: BRZ refund failed");

        emit LoanCancelled(address(this));
    }

    // ─── View functions ───────────────────────────────────────────────────────

    function getStatus() external view returns (Status) {
        return status;
    }

    function getLoanDetails()
        external
        view
        returns (
            address _lender,
            address _borrower,
            uint256 _principal,
            uint256 _annualRateBps,
            uint256 _termMonths,
            uint256 _totalOwed,
            uint256 _dueDate,
            Status _status
        )
    {
        return (lender, borrower, principal, annualRateBps, termMonths, totalOwed, dueDate, status);
    }

    function getTotalOwed() external view returns (uint256) {
        return totalOwed;
    }

    function isOverdue() external view returns (bool) {
        return status == Status.Active && block.timestamp > dueDate;
    }
}

/**
 * @notice Minimal interface for the factory callback used in drawdown().
 */
interface ILoanFactoryCallback {
    function registerBorrower(address loan, address borrower) external;
}
