// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockBRZ
 * @notice Test-only ERC-20 that mimics the BRZ stablecoin.
 *         Mints 1,000,000 BRZ to the deployer and exposes a public mint().
 */
contract MockBRZ is ERC20 {
    constructor() ERC20("Mock BRZ", "BRZ") {
        _mint(msg.sender, 1_000_000 * 10 ** 18);
    }

    /// @notice Mint arbitrary tokens — only for testing.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
