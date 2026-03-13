// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CompoundMath
 * @notice Fixed-point arithmetic library for compound interest calculation.
 *
 * All calculations use PRECISION = 1e18 as the scaling factor (WAD math).
 *
 * Formula: A = P * (1 + r/12)^n
 *   where r = annualRateBps / 10000 (annual rate as a decimal)
 *         n = termMonths
 *
 * Intermediate representation: (1 + r/12) scaled by PRECISION
 *   monthlyFactor = PRECISION + (annualRateBps * PRECISION) / (10000 * 12)
 *   result        = principal * monthlyFactor^n / PRECISION^(n-1)   (cancel scale)
 *
 * To avoid overflow in the loop we keep numbers in WAD (1e18) form and
 * divide by PRECISION after every multiplication.
 */
library CompoundMath {
    uint256 private constant PRECISION = 1e18;
    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant MONTHS_PER_YEAR = 12;

    /**
     * @notice Calculate total amount owed using compound interest.
     * @param principal     Loan principal in token units (18 decimals assumed).
     * @param annualRateBps Annual interest rate in basis points (e.g. 2400 = 24%).
     * @param termMonths    Loan duration in months.
     * @return totalOwed    principal × (1 + annualRateBps/10000/12)^termMonths
     */
    function calculateTotalOwed(
        uint256 principal,
        uint256 annualRateBps,
        uint256 termMonths
    ) internal pure returns (uint256 totalOwed) {
        if (termMonths == 0) return principal;
        if (annualRateBps == 0) return principal;

        // monthlyFactor in WAD = 1e18 + (annualRateBps * 1e18) / (10000 * 12)
        uint256 monthlyFactor = PRECISION + (annualRateBps * PRECISION) / (BPS_DENOMINATOR * MONTHS_PER_YEAR);

        // Exponentiation by squaring to reduce gas for large termMonths
        uint256 result = PRECISION; // 1.0 in WAD
        uint256 base = monthlyFactor;
        uint256 exp = termMonths;

        while (exp > 0) {
            if (exp % 2 == 1) {
                result = (result * base) / PRECISION;
            }
            base = (base * base) / PRECISION;
            exp /= 2;
        }

        // result is now (1 + r/12)^n in WAD — multiply by principal
        totalOwed = (principal * result) / PRECISION;
    }

    /**
     * @notice Calculate the fee amount from the interest earned.
     * @param totalOwed  Total repayment amount.
     * @param principal  Original principal.
     * @param feeBps     Platform fee in basis points (e.g. 200 = 2%).
     * @return feeAmount Fee charged on the interest portion only.
     */
    function calculateFee(
        uint256 totalOwed,
        uint256 principal,
        uint256 feeBps
    ) internal pure returns (uint256 feeAmount) {
        if (totalOwed <= principal) return 0;
        uint256 interest = totalOwed - principal;
        feeAmount = (interest * feeBps) / BPS_DENOMINATOR;
    }
}
