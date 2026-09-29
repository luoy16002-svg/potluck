// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPotluckReputation {
    function record(address member, uint32 onTime, uint32 missed, bool defaulted, uint128 contributed) external;
}

/// @title PotluckCircle
/// @notice One rotating savings circle (ROSCA, known as hui, arisan, tanda, susu or chit fund).
/// `size` members each put `contribution` into the pot every round; each round one member takes the pot.
///
/// Two ways to pick who takes the pot:
/// - Fixed: members are paid in the order they joined.
/// - Auction: members who have not won yet bid a discount for taking the pot this round, like a Chinese
///   bidding hui or an Indian chit fund. The highest discount wins, and the discount is shared equally by
///   the other members, so people who can wait are paid interest by people who need the money now.
///
/// Default protection, without any trusted operator:
/// - Every member locks `collateral` when joining. A missed contribution is covered from it.
/// - A winner has `bondBps` of the payout held back (capped at what they still owe) and gets it back at the
///   end. A winner who stops paying is covered from this bond first.
/// - A member whose collateral and bond cannot cover a missed round is marked defaulted and can no longer win.
///
/// There is no owner and no admin function: funds only move by the rules below. On completion every
/// member's record (on-time payments, missed payments, default) is written to PotluckReputation.
contract PotluckCircle is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Phase {
        Forming,
        Active,
        Completed,
        Cancelled
    }

    enum Mode {
        Fixed,
        Auction
    }

    struct Config {
        IERC20 token;
        uint128 contribution;
        uint128 collateral;
        uint8 size;
        uint32 roundDuration;
        uint32 joinWindow;
        uint16 bondBps;
        uint16 maxDiscountBps;
        Mode mode;
    }

    struct Member {
        bool joined;
        bool won;
        bool defaulted;
        bool withdrawn;
        uint8 wonRound;
        uint8 onTime;
        uint8 missed;
        uint128 collateralLeft;
        uint128 bond;
        uint128 contributed;
        uint128 received;
    }

    struct RoundResult {
        address winner;
        uint128 pot;
        uint128 discount;
        uint128 payout;
        uint128 bondHeld;
        uint64 settledAt;
    }

    uint8 public constant MIN_SIZE = 2;
    uint8 public constant MAX_SIZE = 20;
    uint16 public constant MAX_BOND_BPS = 5_000;
    uint16 public constant MAX_DISCOUNT_BPS = 3_000;

    string public name;
    address public creator;
    IPotluckReputation public reputation;
    Config internal _config;

    Phase public phase;
    uint64 public createdAt;
    uint64 public startedAt;
    uint8 public currentRound;

    address[] internal _members;
    mapping(address => Member) internal _member;
    mapping(uint256 => mapping(address => bool)) public paid;
    mapping(uint256 => uint128) public collected;
    mapping(uint256 => address) public topBidder;
    mapping(uint256 => uint128) public topDiscount;
    mapping(uint256 => RoundResult) internal _results;

    event Joined(address indexed member, uint256 memberCount);
    event Started(uint64 startedAt);
    event Contributed(address indexed member, uint256 indexed round, uint128 amount, bool onTime);
    event BidPlaced(address indexed member, uint256 indexed round, uint128 discount);
    event MissedCovered(address indexed member, uint256 indexed round, uint128 covered, bool defaulted);
    event RoundSettled(
        uint256 indexed round, address indexed winner, uint128 pot, uint128 discount, uint128 payout, uint128 bondHeld
    );
    event DividendPaid(address indexed member, uint256 indexed round, uint128 amount);
    event Completed();
    event Cancelled();
    event Withdrawn(address indexed member, uint128 amount);

    error WrongPhase();
    error BadConfig();
    error JoinClosed();
    error AlreadyMember();
    error NotMember();
    error AlreadyPaid();
    error NotEligible();
    error MustContributeFirst();
    error BiddingClosed();
    error DiscountTooHigh();
    error BidTooLow();
    error RoundStillOpen();
    error NotCancellable();
    error NothingToWithdraw();

    constructor() {
        _disableInitializers();
    }

    function initialize(address creator_, string calldata name_, Config calldata c, address reputation_)
        external
        initializer
    {
        if (
            address(c.token) == address(0) || c.contribution == 0 || c.size < MIN_SIZE || c.size > MAX_SIZE
                || c.roundDuration < 60 || c.joinWindow < 60 || c.bondBps > MAX_BOND_BPS
                || c.maxDiscountBps > MAX_DISCOUNT_BPS || (c.mode == Mode.Fixed && c.maxDiscountBps != 0)
        ) revert BadConfig();
        creator = creator_;
        name = name_;
        _config = c;
        reputation = IPotluckReputation(reputation_);
        createdAt = uint64(block.timestamp);
    }

    // ----------------------------------------------------------------------------------------- forming

    /// @notice Join the circle by locking the collateral. The circle starts when it is full.
    function join() external nonReentrant {
        if (phase != Phase.Forming) revert WrongPhase();
        if (block.timestamp > createdAt + _config.joinWindow) revert JoinClosed();
        Member storage m = _member[msg.sender];
        if (m.joined) revert AlreadyMember();

        m.joined = true;
        m.collateralLeft = _config.collateral;
        _members.push(msg.sender);
        emit Joined(msg.sender, _members.length);

        if (_config.collateral > 0) {
            _config.token.safeTransferFrom(msg.sender, address(this), _config.collateral);
        }
        if (_members.length == _config.size) {
            phase = Phase.Active;
            startedAt = uint64(block.timestamp);
            currentRound = 1;
            emit Started(startedAt);
        }
    }

    /// @notice Cancel a circle that did not fill in time (anyone), or that the creator abandons before it
    /// starts. Members then take their collateral back with `withdraw`.
    function cancel() external {
        if (phase != Phase.Forming) revert WrongPhase();
        bool expired = block.timestamp > createdAt + _config.joinWindow;
        if (!expired && msg.sender != creator) revert NotCancellable();
        phase = Phase.Cancelled;
        emit Cancelled();
    }

    // ------------------------------------------------------------------------------------------ rounds

    /// @notice Pay this round's contribution. Payments after the round deadline are still accepted until the
    /// round is settled, but do not count as on time.
    function contribute() external nonReentrant {
        if (phase != Phase.Active) revert WrongPhase();
        Member storage m = _member[msg.sender];
        if (!m.joined) revert NotMember();
        if (m.defaulted) revert NotEligible();
        uint256 r = currentRound;
        if (paid[r][msg.sender]) revert AlreadyPaid();

        bool onTime = block.timestamp <= roundDeadline(r);
        uint128 amount = _config.contribution;
        paid[r][msg.sender] = true;
        collected[r] += amount;
        m.contributed += amount;
        if (onTime) m.onTime += 1;
        emit Contributed(msg.sender, r, amount, onTime);

        _config.token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Auction mode: offer a discount for taking this round's pot. Only members who have paid this
    /// round and have not won yet can bid. A new bid must beat the current best discount.
    function bid(uint128 discount) external {
        if (_config.mode != Mode.Auction) revert NotEligible();
        if (phase != Phase.Active) revert WrongPhase();
        uint256 r = currentRound;
        if (block.timestamp > roundDeadline(r)) revert BiddingClosed();
        Member storage m = _member[msg.sender];
        if (!m.joined || m.won || m.defaulted) revert NotEligible();
        if (!paid[r][msg.sender]) revert MustContributeFirst();
        if (discount > maxDiscount()) revert DiscountTooHigh();
        if (topBidder[r] != address(0) && discount <= topDiscount[r]) revert BidTooLow();

        topBidder[r] = msg.sender;
        topDiscount[r] = discount;
        emit BidPlaced(msg.sender, r, discount);
    }

    /// @notice Close the current round: cover missed payments from collateral and bonds, pay the pot to the
    /// winner and the auction discount to everyone else. Anyone can call it after the round deadline; in
    /// Fixed mode it can also be called as soon as every active member has paid.
    function settleRound() external nonReentrant {
        if (phase != Phase.Active) revert WrongPhase();
        uint256 r = currentRound;
        if (block.timestamp <= roundDeadline(r) && !(_config.mode == Mode.Fixed && _allActivePaid(r))) {
            revert RoundStillOpen();
        }

        _coverMissed(r);

        address winner = _config.mode == Mode.Auction ? topBidder[r] : address(0);
        // A top bidder who defaulted while covering this round loses the bid.
        if (winner != address(0) && _member[winner].defaulted) winner = address(0);
        uint128 discount = winner != address(0) ? topDiscount[r] : 0;
        if (winner == address(0)) winner = _nextInLine();

        uint128 pot = collected[r];
        if (winner == address(0)) {
            // Every remaining member defaulted: share the pot among members still in good standing.
            _splitAmongGood(r, pot, address(0));
            _results[r] = RoundResult(address(0), pot, 0, 0, 0, uint64(block.timestamp));
            emit RoundSettled(r, address(0), pot, 0, 0, 0);
        } else {
            if (discount > pot) discount = 0;
            uint128 gross = pot - discount;
            uint128 stillOwed = uint128(_config.size - r) * _config.contribution;
            uint128 bondAmt = uint128((uint256(gross) * _config.bondBps) / 10_000);
            if (bondAmt > stillOwed) bondAmt = stillOwed;

            Member storage w = _member[winner];
            w.won = true;
            w.wonRound = uint8(r);
            w.bond += bondAmt;
            uint128 dust = discount > 0 ? _splitAmongGood(r, discount, winner) : 0;
            uint128 payout = gross - bondAmt + dust;
            w.received += payout;
            _results[r] = RoundResult(winner, pot, discount, payout, bondAmt, uint64(block.timestamp));
            emit RoundSettled(r, winner, pot, discount, payout, bondAmt);
            _config.token.safeTransfer(winner, payout);
        }

        if (r == _config.size) {
            phase = Phase.Completed;
            emit Completed();
            _recordReputation();
        } else {
            currentRound = uint8(r + 1);
        }
    }

    /// @notice Take back remaining collateral and bond after the circle completes or is cancelled.
    function withdraw() external nonReentrant {
        if (phase != Phase.Completed && phase != Phase.Cancelled) revert WrongPhase();
        Member storage m = _member[msg.sender];
        if (!m.joined) revert NotMember();
        if (m.withdrawn) revert NothingToWithdraw();
        uint128 amount = m.collateralLeft + m.bond;
        if (amount == 0) revert NothingToWithdraw();
        m.withdrawn = true;
        m.collateralLeft = 0;
        m.bond = 0;
        emit Withdrawn(msg.sender, amount);
        _config.token.safeTransfer(msg.sender, amount);
    }

    // ---------------------------------------------------------------------------------------- internals

    function _allActivePaid(uint256 r) internal view returns (bool) {
        for (uint256 i; i < _members.length; ++i) {
            address a = _members[i];
            if (!_member[a].defaulted && !paid[r][a]) return false;
        }
        return true;
    }

    function _coverMissed(uint256 r) internal {
        uint128 amount = _config.contribution;
        for (uint256 i; i < _members.length; ++i) {
            address a = _members[i];
            Member storage m = _member[a];
            if (paid[r][a] || m.defaulted) continue;

            uint128 fromCollateral = m.collateralLeft >= amount ? amount : m.collateralLeft;
            m.collateralLeft -= fromCollateral;
            uint128 rest = amount - fromCollateral;
            uint128 fromBond = m.bond >= rest ? rest : m.bond;
            m.bond -= fromBond;
            uint128 covered = fromCollateral + fromBond;

            m.missed += 1;
            collected[r] += covered;
            paid[r][a] = true;
            if (covered < amount) m.defaulted = true;
            emit MissedCovered(a, r, covered, m.defaulted);
        }
    }

    function _nextInLine() internal view returns (address) {
        for (uint256 i; i < _members.length; ++i) {
            Member storage m = _member[_members[i]];
            if (!m.won && !m.defaulted) return _members[i];
        }
        return address(0);
    }

    /// @dev Splits `amount` equally among members in good standing except `exclude`, paying them directly.
    /// If nobody is in good standing, it is split among all members except `exclude` so no funds are stranded.
    /// With an `exclude` (the round winner) the undivided remainder is returned for the caller to add to the
    /// winner's payout; without one it goes to the first recipient.
    function _splitAmongGood(uint256 r, uint128 amount, address exclude) internal returns (uint128 dust) {
        uint256 n;
        for (uint256 i; i < _members.length; ++i) {
            address a = _members[i];
            if (a != exclude && !_member[a].defaulted) ++n;
        }
        bool everyone = n == 0;
        if (everyone) {
            for (uint256 i; i < _members.length; ++i) {
                if (_members[i] != exclude) ++n;
            }
        }
        if (n == 0) return amount;
        uint128 share = uint128(amount / n);
        dust = amount - share * uint128(n);
        for (uint256 i; i < _members.length; ++i) {
            address a = _members[i];
            if (a == exclude || (!everyone && _member[a].defaulted)) continue;
            uint128 pay = share;
            if (exclude == address(0) && dust > 0) {
                pay += dust;
                dust = 0;
            }
            if (pay == 0) continue;
            _member[a].received += pay;
            emit DividendPaid(a, r, pay);
            _config.token.safeTransfer(a, pay);
        }
    }

    function _recordReputation() internal {
        if (address(reputation) == address(0)) return;
        for (uint256 i; i < _members.length; ++i) {
            address a = _members[i];
            Member storage m = _member[a];
            reputation.record(a, m.onTime, m.missed, m.defaulted, m.contributed);
        }
    }

    // -------------------------------------------------------------------------------------------- views

    function config() external view returns (Config memory) {
        return _config;
    }

    function members() external view returns (address[] memory) {
        return _members;
    }

    function memberCount() external view returns (uint256) {
        return _members.length;
    }

    function memberInfo(address a) external view returns (Member memory) {
        return _member[a];
    }

    function result(uint256 r) external view returns (RoundResult memory) {
        return _results[r];
    }

    function potSize() public view returns (uint128) {
        return _config.contribution * _config.size;
    }

    function maxDiscount() public view returns (uint128) {
        return uint128((uint256(potSize()) * _config.maxDiscountBps) / 10_000);
    }

    function roundDeadline(uint256 r) public view returns (uint256) {
        return uint256(startedAt) + r * _config.roundDuration;
    }

    function joinDeadline() external view returns (uint256) {
        return uint256(createdAt) + _config.joinWindow;
    }
}
