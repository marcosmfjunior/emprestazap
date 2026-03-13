// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IBulletLoan
 * @notice Interface for BulletLoan contracts.
 */
interface IBulletLoan {
    // ─── Enums ───────────────────────────────────────────────────────────────

    enum Status {
        Created,
        Funded,
        Active,
        Repaid,
        Defaulted,
        Cancelled
    }

    // ─── Events ──────────────────────────────────────────────────────────────

    event LoanFunded(address indexed loanAddress, uint256 principal);
    event LoanActivated(address indexed loanAddress, address indexed borrower, uint256 dueDate);
    event LoanRepaid(address indexed loanAddress, uint256 totalPaid, uint256 feeAmount);
    event LoanDefaulted(address indexed loanAddress, uint256 outstandingAmount);
    event LoanCancelled(address indexed loanAddress);

    // ─── State-changing functions ─────────────────────────────────────────────

    /// @notice Lender deposits BRZ to fund the loan.
    function fund() external;

    /// @notice Factory-only: marks the loan as Funded after the factory has
    ///         transferred tokens directly.
    function fundFromFactory() external;

    /// @notice Borrower accepts the loan and receives BRZ.
    function drawdown() external;

    /// @notice Borrower repays principal + compound interest on or after due date.
    function repay() external;

    /// @notice Lender marks the loan as defaulted after due date passes without repayment.
    function claimDefault() external;

    /// @notice Lender cancels the loan before any borrower accepts it.
    function cancelLoan() external;

    // ─── View functions ───────────────────────────────────────────────────────

    function getStatus() external view returns (Status);

    function getLoanDetails()
        external
        view
        returns (
            address lender,
            address borrower,
            uint256 principal,
            uint256 annualRateBps,
            uint256 termMonths,
            uint256 totalOwed,
            uint256 dueDate,
            Status status
        );

    function getTotalOwed() external view returns (uint256);

    function isOverdue() external view returns (bool);
}
