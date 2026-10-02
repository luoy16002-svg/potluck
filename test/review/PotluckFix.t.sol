// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PotluckCircle} from "../../src/PotluckCircle.sol";
import {PotluckFactory} from "../../src/PotluckFactory.sol";
import {PotluckReputation} from "../../src/PotluckReputation.sol";
import {ReviewToken} from "./PotluckReview.t.sol";

/// Test-only state fixtures; no production contract exposes these setters.
contract FixReputationFixture is PotluckReputation {
    constructor(address factory_) PotluckReputation(factory_) {}

    function seedStats(address member, Stats calldata value) external {
        _stats[member] = value;
    }
}

contract FixCircleFixture is PotluckCircle {
    function seedDiscount(uint256 round, uint128 discount) external {
        topDiscount[round] = discount;
    }
}

contract FixFeeToken is ReviewToken {
    bool public feeEnabled;

    constructor() ReviewToken(6) {}

    function setFeeEnabled(bool value) external {
        feeEnabled = value;
    }

    function _update(address from, address to, uint256 amount) internal override {
        uint256 fee = feeEnabled && from != address(0) && to != address(0) ? amount / 10 : 0;
        if (fee > 0) super._update(from, address(0), fee);
        super._update(from, to, amount - fee);
    }
}

contract PotluckFixTest is Test {
    PotluckFactory internal factory;
    ReviewToken internal token;
    address[20] internal actors;

    function setUp() public {
        vm.warp(1_790_000_000);
        factory = new PotluckFactory();
        token = new ReviewToken(6);
        for (uint256 i; i < actors.length; ++i) {
            actors[i] = makeAddr(string.concat("fix-member-", vm.toString(i)));
        }
    }

    function _config(uint8 size, PotluckCircle.Mode mode) internal view returns (PotluckCircle.Config memory) {
        return PotluckCircle.Config({
            token: token,
            contribution: 100,
            collateral: 100,
            size: size,
            roundDuration: 60,
            joinWindow: 60,
            bondBps: 3000,
            maxDiscountBps: mode == PotluckCircle.Mode.Auction ? 3000 : 0,
            mode: mode
        });
    }

    function _create(PotluckCircle.Config memory c) internal returns (PotluckCircle) {
        return PotluckCircle(factory.createCircle("Fix checks", c));
    }

    function _fundAndJoin(PotluckCircle circle) internal {
        PotluckCircle.Config memory c = circle.config();
        uint256 funding = uint256(c.collateral) + uint256(c.size) * c.contribution + 100;
        for (uint256 i; i < c.size; ++i) {
            token.mint(actors[i], funding);
            vm.startPrank(actors[i]);
            token.approve(address(circle), type(uint256).max);
            circle.join();
            vm.stopPrank();
        }
        _assertBacking(circle);
    }

    function _pay(PotluckCircle circle, uint256 count) internal {
        for (uint256 i; i < count; ++i) {
            vm.prank(actors[i]);
            circle.contribute();
        }
        _assertBacking(circle);
    }

    function _assertBacking(PotluckCircle circle) internal view {
        uint256 obligations;
        address[] memory members = circle.members();
        for (uint256 i; i < members.length; ++i) {
            PotluckCircle.Member memory m = circle.memberInfo(members[i]);
            obligations += uint256(m.collateralLeft) + m.bond + m.claimable;
        }
        if (circle.phase() == PotluckCircle.Phase.Active) obligations += circle.collected(circle.currentRound());
        assertEq(token.balanceOf(address(circle)), obligations, "all credits backed");
    }

    function _withdrawAll(PotluckCircle circle) internal {
        address[] memory members = circle.members();
        for (uint256 i; i < members.length; ++i) {
            PotluckCircle.Member memory m = circle.memberInfo(members[i]);
            if (uint256(m.collateralLeft) + m.bond + m.claimable == 0) continue;
            vm.prank(members[i]);
            circle.withdraw();
            _assertBacking(circle);
        }
        assertEq(token.balanceOf(address(circle)), 0, "nothing stranded");
    }

    function _completePaidFixed(PotluckCircle circle) internal {
        uint256 size = circle.config().size;
        for (uint256 r = 1; r <= size; ++r) {
            _pay(circle, size);
            circle.settleRound();
            _assertBacking(circle);
        }
        assertEq(uint8(circle.phase()), uint8(PotluckCircle.Phase.Completed));
    }

    function test_saturatedReputationAllowsCompletionAndWithdrawals() public {
        FixReputationFixture registry = new FixReputationFixture(address(this));
        PotluckCircle circle = PotluckCircle(Clones.clone(factory.implementation()));
        registry.authorize(address(circle));
        circle.initialize(address(this), "Saturated history", _config(2, PotluckCircle.Mode.Fixed), address(registry));
        registry.seedStats(
            actors[0],
            PotluckReputation.Stats({
                circlesCompleted: type(uint32).max,
                circlesDefaulted: type(uint32).max,
                onTimePayments: type(uint32).max - 1,
                missedPayments: type(uint32).max,
                totalContributed: type(uint128).max - 1,
                lastUpdated: 0
            })
        );
        _fundAndJoin(circle);
        _completePaidFixed(circle);

        PotluckReputation.Stats memory s = registry.stats(actors[0]);
        assertEq(s.circlesCompleted, type(uint32).max);
        assertEq(s.circlesDefaulted, type(uint32).max);
        assertEq(s.onTimePayments, type(uint32).max);
        assertEq(s.missedPayments, type(uint32).max);
        assertEq(s.totalContributed, type(uint128).max);
        assertEq(s.lastUpdated, block.timestamp);
        assertTrue(registry.recorded(address(circle), actors[0]));
        assertTrue(registry.recorded(address(circle), actors[1]));
        assertEq(registry.stats(actors[1]).circlesCompleted, 1);
        _withdrawAll(circle);
    }

    function test_defaultedReputationCountersSaturateAndAuthorizationRemains() public {
        FixReputationFixture registry = new FixReputationFixture(address(this));
        PotluckCircle circle = _create(_config(2, PotluckCircle.Mode.Fixed));
        registry.authorize(address(circle));
        registry.seedStats(
            actors[0],
            PotluckReputation.Stats(
                7, type(uint32).max, type(uint32).max - 1, type(uint32).max - 1, type(uint128).max, 0
            )
        );
        vm.expectRevert(PotluckReputation.OnlyCircle.selector);
        registry.record(actors[0], 2, 2, true, 1);
        vm.prank(actors[1]);
        vm.expectRevert(PotluckReputation.OnlyFactory.selector);
        registry.authorize(actors[1]);
        vm.prank(address(circle));
        registry.record(actors[0], 2, 2, true, 1);
        PotluckReputation.Stats memory s = registry.stats(actors[0]);
        assertEq(s.circlesCompleted, 7);
        assertEq(s.circlesDefaulted, type(uint32).max);
        assertEq(s.onTimePayments, type(uint32).max);
        assertEq(s.missedPayments, type(uint32).max);
        assertEq(s.totalContributed, type(uint128).max);
        vm.prank(address(circle));
        vm.expectRevert(PotluckReputation.AlreadyRecorded.selector);
        registry.record(actors[0], 2, 2, true, 1);
    }

    function test_reputationFailureDoesNotBlockOtherRecordsOrWithdrawals() public {
        PotluckCircle circle = _create(_config(3, PotluckCircle.Mode.Fixed));
        PotluckReputation registry = factory.reputation();
        vm.mockCallRevert(
            address(registry),
            abi.encodeWithSelector(PotluckReputation.record.selector, actors[0]),
            bytes("unavailable")
        );
        _fundAndJoin(circle);
        _completePaidFixed(circle);
        assertFalse(registry.recorded(address(circle), actors[0]));
        assertTrue(registry.recorded(address(circle), actors[1]));
        assertTrue(registry.recorded(address(circle), actors[2]));
        vm.prank(actors[0]);
        circle.claim();
        _withdrawAll(circle);
    }

    /// Whatever gas limit the final settlement is sent with, it either reverts or writes every record; a settler
    /// cannot pick a limit that starves the registry calls and silently drops a record.
    function test_noGasLimitCompletesWithSkippedRecords() public {
        PotluckCircle circle = _create(_config(3, PotluckCircle.Mode.Fixed));
        PotluckReputation registry = factory.reputation();
        _fundAndJoin(circle);
        for (uint256 r = 1; r < 3; ++r) {
            _pay(circle, 3);
            circle.settleRound();
        }
        _pay(circle, 3);
        bool anySuccess;
        for (uint256 g = 50_000; g <= 1_500_000; g += 5_000) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = address(circle).call{gas: g}(abi.encodeCall(PotluckCircle.settleRound, ()));
            if (ok) {
                anySuccess = true;
                assertEq(uint8(circle.phase()), uint8(PotluckCircle.Phase.Completed));
                for (uint256 i; i < 3; ++i) {
                    assertTrue(registry.recorded(address(circle), actors[i]), "every record written when settle succeeds");
                }
            }
            vm.revertToState(snap);
        }
        assertTrue(anySuccess, "settlement succeeds with enough gas");
    }

    function test_missingReputationCodeDoesNotBlockCompletion() public {
        PotluckCircle circle = PotluckCircle(Clones.clone(factory.implementation()));
        circle.initialize(
            address(this), "Unavailable registry", _config(2, PotluckCircle.Mode.Fixed), makeAddr("registry")
        );
        _fundAndJoin(circle);
        _completePaidFixed(circle);
        _withdrawAll(circle);
    }

    function test_lateSettlementGivesEveryOpenedRoundAFullWindow() public {
        for (uint256 mode; mode < 2; ++mode) {
            PotluckCircle circle = _create(_config(3, PotluckCircle.Mode(mode)));
            _fundAndJoin(circle);
            uint256 originalFirstDeadline = circle.roundDeadline(1);
            _pay(circle, 3);
            vm.warp(uint256(circle.startedAt()) + 10 * 60);
            circle.settleRound();
            assertEq(circle.roundDeadline(1), originalFirstDeadline, "historical deadline unchanged");

            for (uint256 r = 2; r <= 3; ++r) {
                uint256 openedAt = block.timestamp;
                uint256 deadline = circle.roundDeadline(r);
                assertEq(deadline, openedAt + 60, "full new payment and bidding window");
                vm.expectRevert(PotluckCircle.RoundStillOpen.selector);
                circle.settleRound();
                vm.warp(deadline);
                _pay(circle, 3);
                assertEq(circle.memberInfo(actors[0]).onTime, r, "payment at effective deadline is on time");
                if (mode == uint256(PotluckCircle.Mode.Auction)) {
                    vm.prank(actors[r - 1]);
                    circle.bid(10);
                    vm.expectRevert(PotluckCircle.RoundStillOpen.selector);
                    circle.settleRound();
                }
                vm.warp(deadline + 1);
                if (mode == uint256(PotluckCircle.Mode.Auction)) {
                    vm.prank(actors[r - 1]);
                    vm.expectRevert(PotluckCircle.BiddingClosed.selector);
                    circle.bid(11);
                }
                circle.settleRound();
                assertEq(circle.roundDeadline(r), deadline, "stored deadline survives settlement");
            }
            assertEq(uint8(circle.phase()), uint8(PotluckCircle.Phase.Completed));
            _withdrawAll(circle);
        }
    }

    function test_fixedEarlySettlementPreservesOriginalSchedule() public {
        PotluckCircle circle = _create(_config(3, PotluckCircle.Mode.Fixed));
        _fundAndJoin(circle);
        uint256 start = circle.startedAt();
        for (uint256 r = 1; r <= 3; ++r) {
            assertEq(circle.roundDeadline(r), start + r * 60);
            _pay(circle, 3);
            circle.settleRound();
        }
        assertEq(block.timestamp, start, "fixed rounds still settle early");
        _withdrawAll(circle);
    }

    function test_bidsCannotExceedCollectedPot() public {
        PotluckCircle.Config memory c = _config(10, PotluckCircle.Mode.Auction);
        c.collateral = 0;
        c.bondBps = 0;
        PotluckCircle circle = _create(c);
        _fundAndJoin(circle);
        _pay(circle, 2);
        assertEq(circle.maxDiscount(), 300);
        assertEq(circle.collected(1), 200);
        vm.prank(actors[0]);
        vm.expectRevert(PotluckCircle.DiscountTooHigh.selector);
        circle.bid(201);
        assertEq(circle.topBidder(1), address(0));
        assertEq(circle.topDiscount(1), 0);
        vm.prank(actors[0]);
        circle.bid(200);
        vm.warp(circle.roundDeadline(1) + 1);
        circle.settleRound();
        assertEq(circle.result(1).winner, actors[0]);
        assertEq(circle.result(1).pot, 200);
        assertEq(circle.result(1).discount, 200);
        assertEq(circle.result(1).payout, 0);
        assertEq(circle.memberInfo(actors[1]).claimable, 200);
        _assertBacking(circle);
    }

    function test_nominalBidCapStillAppliesWhenCollectedPotIsLarger() public {
        PotluckCircle circle = _create(_config(3, PotluckCircle.Mode.Auction));
        _fundAndJoin(circle);
        _pay(circle, 3);
        assertEq(circle.collected(1), 300);
        vm.prank(actors[0]);
        vm.expectRevert(PotluckCircle.DiscountTooHigh.selector);
        circle.bid(91);
        vm.prank(actors[0]);
        circle.bid(90);
        assertEq(circle.topDiscount(1), 90);
    }

    function test_settlementCapsFixtureDiscountAtPotAndKeepsWinner() public {
        // Accepted bids cannot reach this state with supported tokens: collected only increases.
        // Seed it locally to verify the defensive settlement cap independently of bid validation.
        FixCircleFixture circle = FixCircleFixture(Clones.clone(address(new FixCircleFixture())));
        PotluckCircle.Config memory c = _config(10, PotluckCircle.Mode.Auction);
        c.collateral = 0;
        c.bondBps = 0;
        circle.initialize(address(this), "Defensive cap", c, address(0));
        _fundAndJoin(circle);
        _pay(circle, 2);
        vm.prank(actors[1]);
        circle.bid(50);
        circle.seedDiscount(1, 300);
        vm.warp(circle.roundDeadline(1) + 1);
        circle.settleRound();
        PotluckCircle.RoundResult memory result = circle.result(1);
        assertEq(result.winner, actors[1], "winner retained");
        assertEq(result.discount, result.pot, "discount capped, never waived");
        assertEq(result.pot, 200);
        assertEq(result.payout, 0);
        assertEq(circle.memberInfo(actors[0]).claimable, 200);
        _assertBacking(circle);
    }

    function test_initializeRejectsAmountsAboveLifetimeBound() public {
        PotluckCircle.Config memory c = _config(2, PotluckCircle.Mode.Fixed);
        c.contribution = 1;
        c.collateral = type(uint128).max - 3;
        vm.expectRevert(PotluckCircle.BadConfig.selector);
        factory.createCircle("One above bound", c);
        c.collateral = 0;
        c.contribution = type(uint128).max;
        vm.expectRevert(PotluckCircle.BadConfig.selector);
        factory.createCircle("Oversized product", c);
        assertEq(factory.circleCount(), 0, "rejected creation is atomic");
    }

    function test_exactLifetimeBoundAllowsCombinedWithdrawal() public {
        PotluckCircle.Config memory c = _config(2, PotluckCircle.Mode.Fixed);
        c.contribution = 1;
        c.collateral = type(uint128).max - 4;
        c.bondBps = 5000;
        PotluckCircle circle = _create(c);
        _fundAndJoin(circle);
        _completePaidFixed(circle);
        PotluckCircle.Member memory first = circle.memberInfo(actors[0]);
        assertEq(first.bond, 1);
        assertEq(first.claimable, 1);
        _withdrawAll(circle);
    }

    function test_largeValidAmountsCompleteWithBondsAndDividends() public {
        PotluckCircle.Config memory c = _config(20, PotluckCircle.Mode.Auction);
        c.contribution = type(uint128).max / 400;
        c.collateral = uint128(type(uint128).max - uint256(c.contribution) * 400);
        c.bondBps = 5000;
        PotluckCircle circle = _create(c);
        _fundAndJoin(circle);
        for (uint256 r = 1; r <= 20; ++r) {
            _pay(circle, 20);
            uint128 discount = circle.maxDiscount();
            vm.prank(actors[r - 1]);
            circle.bid(discount);
            vm.warp(circle.roundDeadline(r) + 1);
            circle.settleRound();
            _assertBacking(circle);
        }
        assertEq(uint8(circle.phase()), uint8(PotluckCircle.Phase.Completed));
        _withdrawAll(circle);
    }

    function test_feeOnJoinRevertsWithoutCreditingCollateralOrActivating() public {
        FixFeeToken feeToken = new FixFeeToken();
        token = feeToken;
        PotluckCircle circle = _create(_config(2, PotluckCircle.Mode.Fixed));
        for (uint256 i; i < 2; ++i) {
            feeToken.mint(actors[i], 1000);
            vm.prank(actors[i]);
            feeToken.approve(address(circle), type(uint256).max);
        }
        vm.prank(actors[0]);
        circle.join();
        feeToken.setFeeEnabled(true);
        vm.prank(actors[1]);
        vm.expectRevert(PotluckCircle.BadConfig.selector);
        circle.join();
        assertEq(circle.memberCount(), 1);
        assertEq(uint8(circle.phase()), uint8(PotluckCircle.Phase.Forming));
        assertEq(circle.currentRound(), 0);
        assertFalse(circle.memberInfo(actors[1]).joined);
        assertEq(circle.memberInfo(actors[1]).collateralLeft, 0);
        assertEq(token.balanceOf(actors[1]), 1000, "transfer rolled back");
        assertEq(token.totalSupply(), 2000, "fee burn rolled back");
        _assertBacking(circle);
        feeToken.setFeeEnabled(false);
        vm.prank(actors[1]);
        circle.join();
        assertEq(uint8(circle.phase()), uint8(PotluckCircle.Phase.Active));
        _completePaidFixed(circle);
        _withdrawAll(circle);
    }

    function test_feeOnContributionRevertsWithoutCreditingPayment() public {
        FixFeeToken feeToken = new FixFeeToken();
        token = feeToken;
        PotluckCircle circle = _create(_config(2, PotluckCircle.Mode.Fixed));
        _fundAndJoin(circle);
        uint256 beforeBalance = token.balanceOf(actors[0]);
        uint256 beforeSupply = token.totalSupply();
        feeToken.setFeeEnabled(true);
        vm.prank(actors[0]);
        vm.expectRevert(PotluckCircle.BadConfig.selector);
        circle.contribute();
        assertFalse(circle.paid(1, actors[0]));
        assertEq(circle.collected(1), 0);
        assertEq(circle.memberInfo(actors[0]).contributed, 0);
        assertEq(circle.memberInfo(actors[0]).onTime, 0);
        assertEq(token.balanceOf(actors[0]), beforeBalance);
        assertEq(token.totalSupply(), beforeSupply);
        _assertBacking(circle);
        feeToken.setFeeEnabled(false);
        _completePaidFixed(circle);
        _withdrawAll(circle);
    }
}
