// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PotluckCircle} from "./PotluckCircle.sol";
import {PotluckReputation} from "./PotluckReputation.sol";

/// @title PotluckFactory
/// @notice Deploys savings circles as minimal proxies and keeps the shared reputation registry.
contract PotluckFactory {
    address public immutable implementation;
    PotluckReputation public immutable reputation;

    address[] internal _circles;
    mapping(address => address[]) internal _createdBy;

    event CircleCreated(
        address indexed circle,
        address indexed creator,
        string name,
        address token,
        uint128 contribution,
        uint8 size,
        PotluckCircle.Mode mode
    );

    constructor() {
        implementation = address(new PotluckCircle());
        reputation = new PotluckReputation(address(this));
    }

    function createCircle(string calldata name, PotluckCircle.Config calldata c) external returns (address circle) {
        circle = Clones.clone(implementation);
        reputation.authorize(circle);
        PotluckCircle(circle).initialize(msg.sender, name, c, address(reputation));
        _circles.push(circle);
        _createdBy[msg.sender].push(circle);
        emit CircleCreated(circle, msg.sender, name, address(c.token), c.contribution, c.size, c.mode);
    }

    function circleCount() external view returns (uint256) {
        return _circles.length;
    }

    /// @notice Newest first, for listing in a frontend without an indexer.
    function latestCircles(uint256 limit) external view returns (address[] memory out) {
        uint256 n = _circles.length < limit ? _circles.length : limit;
        out = new address[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = _circles[_circles.length - 1 - i];
        }
    }

    function circlesCreatedBy(address who) external view returns (address[] memory) {
        return _createdBy[who];
    }
}
