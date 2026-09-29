// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PotluckReputation
/// @notice A portable savings record. Each completed Potluck circle writes, for every member, how many
/// contributions were on time, how many were missed and whether the member defaulted. Any other protocol
/// (a lender, another circle, a merchant) can read `stats` or `score` without trusting Potluck's frontend.
contract PotluckReputation {
    struct Stats {
        uint32 circlesCompleted;
        uint32 circlesDefaulted;
        uint32 onTimePayments;
        uint32 missedPayments;
        uint128 totalContributed;
        uint64 lastUpdated;
    }

    address public immutable factory;
    mapping(address => bool) public isCircle;
    mapping(address => Stats) internal _stats;
    mapping(address => mapping(address => bool)) public recorded;

    event CircleAuthorized(address indexed circle);
    event Recorded(address indexed member, address indexed circle, uint32 onTime, uint32 missed, bool defaulted);

    error OnlyFactory();
    error OnlyCircle();
    error AlreadyRecorded();

    constructor(address factory_) {
        if (factory_ == address(0)) revert OnlyFactory();
        factory = factory_;
    }

    function authorize(address circle) external {
        if (msg.sender != factory) revert OnlyFactory();
        isCircle[circle] = true;
        emit CircleAuthorized(circle);
    }

    /// @notice Called once per member by a circle created through the factory when it completes.
    function record(address member, uint32 onTime, uint32 missed, bool defaulted, uint128 contributed) external {
        if (!isCircle[msg.sender]) revert OnlyCircle();
        if (recorded[msg.sender][member]) revert AlreadyRecorded();
        recorded[msg.sender][member] = true;

        Stats storage s = _stats[member];
        if (defaulted) s.circlesDefaulted += 1;
        else s.circlesCompleted += 1;
        s.onTimePayments += onTime;
        s.missedPayments += missed;
        s.totalContributed += contributed;
        s.lastUpdated = uint64(block.timestamp);
        emit Recorded(member, msg.sender, onTime, missed, defaulted);
    }

    function stats(address member) external view returns (Stats memory) {
        return _stats[member];
    }

    /// @notice A simple 0-1000 score: starts at 500, rises with on-time payments and completed circles,
    /// falls with missed payments and defaults. Integrators are free to weigh `stats` their own way.
    function score(address member) external view returns (uint256) {
        Stats memory s = _stats[member];
        int256 v = 500 + int256(uint256(s.onTimePayments)) * 10 + int256(uint256(s.circlesCompleted)) * 40
            - int256(uint256(s.missedPayments)) * 35 - int256(uint256(s.circlesDefaulted)) * 200;
        if (v < 0) return 0;
        if (v > 1000) return 1000;
        return uint256(v);
    }
}
