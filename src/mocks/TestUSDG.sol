// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet stand-in for Paxos USDG (6 decimals) on chains where Paxos has no test deployment.
/// Anyone can take 1,000 tokens from the faucet once an hour. Never deploy to a mainnet.
contract TestUSDG is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000e6;
    uint256 public constant FAUCET_COOLDOWN = 1 hours;
    mapping(address => uint256) public lastClaim;

    error Cooldown();

    constructor() ERC20("Global Dollar (Test)", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet() external {
        if (block.timestamp < lastClaim[msg.sender] + FAUCET_COOLDOWN) revert Cooldown();
        lastClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
