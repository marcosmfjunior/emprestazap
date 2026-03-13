// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./BulletLoan.sol";

/**
 * @title LoanFactory
 * @notice Deploys and indexes BulletLoan contracts.
 *
 * Flow:
 *   1. Lender calls createLoan() → factory deploys a new BulletLoan,
 *      transfers `principal` BRZ from lender to the new contract, and sets
 *      its status to Funded in a single atomic call.
 *   2. When a borrower calls drawdown() on a BulletLoan, the loan calls back
 *      registerBorrower() so the factory can update its borrower indexes and
 *      remove the loan from availableLoans.
 *
 * Security: registerBorrower() is protected — only contracts deployed by this
 * factory can call it.
 */
contract LoanFactory is Ownable {
    // ─── Storage ──────────────────────────────────────────────────────────────

    address public brzToken;
    address public feeCollector;
    uint256 public feeBps;

    address[] public allLoans;
    mapping(address => address[]) public loansByLender;
    mapping(address => address[]) public loansByBorrower;

    /// @dev Tracks which addresses are loans created by this factory.
    mapping(address => bool) public isFactoryLoan;

    /// @dev Loans currently in Funded status (marketplace listings).
    address[] private _availableLoans;
    /// @dev Index of each available loan in _availableLoans for O(1) removal.
    mapping(address => uint256) private _availableLoanIndex;

    // ─── Events ──────────────────────────────────────────────────────────────

    event LoanCreated(
        address indexed loanAddress,
        address indexed lender,
        uint256 principal,
        uint256 annualRateBps,
        uint256 termMonths
    );
    event FeeBpsUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event FeeCollectorUpdated(address oldCollector, address newCollector);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _brzToken, address _feeCollector, uint256 _feeBps) Ownable(msg.sender) {
        require(_brzToken != address(0), "LoanFactory: invalid BRZ address");
        require(_feeCollector != address(0), "LoanFactory: invalid feeCollector");
        require(_feeBps <= 10_000, "LoanFactory: fee cannot exceed 100%");

        brzToken = _brzToken;
        feeCollector = _feeCollector;
        feeBps = _feeBps;
    }

    // ─── Core functions ───────────────────────────────────────────────────────

    /**
     * @notice Create a new bullet loan and fund it atomically.
     * @param _principal     BRZ amount to lend (18 decimals).
     * @param _annualRateBps Annual interest rate in basis points.
     * @param _termMonths    Loan term in months.
     * @return loanAddress   Address of the deployed BulletLoan.
     *
     * @dev The caller (lender) must have approved this contract for `_principal`
     *      BRZ before calling. The factory will forward the tokens to the new
     *      BulletLoan contract in one shot, so that the loan is immediately Funded.
     */
    function createLoan(
        uint256 _principal,
        uint256 _annualRateBps,
        uint256 _termMonths
    ) external returns (address loanAddress) {
        require(_principal > 0, "LoanFactory: principal must be > 0");
        require(_termMonths > 0, "LoanFactory: term must be > 0");

        // Deploy the BulletLoan — it starts in Created status.
        BulletLoan loan = new BulletLoan(
            brzToken,
            msg.sender,   // lender
            _principal,
            _annualRateBps,
            _termMonths,
            feeBps,
            feeCollector,
            address(this) // factory (for callback)
        );

        loanAddress = address(loan);

        // Transfer BRZ from lender to the new contract.
        bool ok = IERC20(brzToken).transferFrom(msg.sender, loanAddress, _principal);
        require(ok, "LoanFactory: BRZ transfer failed");

        // Transition the loan to Funded by calling fund() on behalf of the lender.
        // Because the tokens are already in the contract, we need a different approach:
        // The BulletLoan.fund() expects a transferFrom from lender → loan.
        // Since we already moved the tokens, we instead call a privileged init.
        // Solution: use the factory-only fundFromFactory() path.
        loan.fundFromFactory();

        // Register in indexes.
        allLoans.push(loanAddress);
        loansByLender[msg.sender].push(loanAddress);
        isFactoryLoan[loanAddress] = true;

        // Add to marketplace.
        _availableLoanIndex[loanAddress] = _availableLoans.length;
        _availableLoans.push(loanAddress);

        emit LoanCreated(loanAddress, msg.sender, _principal, _annualRateBps, _termMonths);
    }

    /**
     * @notice Called by a BulletLoan when a borrower draws down.
     * @dev    Only callable by loans created by this factory.
     */
    function registerBorrower(address _loan, address _borrower) external {
        require(isFactoryLoan[msg.sender], "LoanFactory: caller is not a factory loan");
        require(msg.sender == _loan, "LoanFactory: loan address mismatch");

        loansByBorrower[_borrower].push(_loan);
        _removeFromAvailable(_loan);
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    /**
     * @dev Remove a loan from the _availableLoans array in O(1) using the
     *      swap-and-pop pattern.
     */
    function _removeFromAvailable(address _loan) internal {
        uint256 idx = _availableLoanIndex[_loan];
        uint256 lastIdx = _availableLoans.length - 1;

        if (idx != lastIdx) {
            address lastLoan = _availableLoans[lastIdx];
            _availableLoans[idx] = lastLoan;
            _availableLoanIndex[lastLoan] = idx;
        }

        _availableLoans.pop();
        delete _availableLoanIndex[_loan];
    }

    // ─── View functions ───────────────────────────────────────────────────────

    function getAvailableLoans() external view returns (address[] memory) {
        return _availableLoans;
    }

    function getLoansByLender(address _lender) external view returns (address[] memory) {
        return loansByLender[_lender];
    }

    function getLoansByBorrower(address _borrower) external view returns (address[] memory) {
        return loansByBorrower[_borrower];
    }

    function getAllLoans() external view returns (address[] memory) {
        return allLoans;
    }

    function getLoanCount() external view returns (uint256) {
        return allLoans.length;
    }

    // ─── Admin functions ──────────────────────────────────────────────────────

    function setFeeBps(uint256 _newFeeBps) external onlyOwner {
        require(_newFeeBps <= 10_000, "LoanFactory: fee cannot exceed 100%");
        emit FeeBpsUpdated(feeBps, _newFeeBps);
        feeBps = _newFeeBps;
    }

    function setFeeCollector(address _newCollector) external onlyOwner {
        require(_newCollector != address(0), "LoanFactory: invalid address");
        emit FeeCollectorUpdated(feeCollector, _newCollector);
        feeCollector = _newCollector;
    }
}
