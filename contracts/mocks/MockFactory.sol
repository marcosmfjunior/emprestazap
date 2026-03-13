// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockFactory
 * @notice Stub factory used in unit tests so BulletLoan.drawdown() can call
 *         registerBorrower() without reverting.
 */
contract MockFactory {
    address public lastLoan;
    address public lastBorrower;

    function registerBorrower(address loan, address borrower) external {
        lastLoan = loan;
        lastBorrower = borrower;
    }
}
