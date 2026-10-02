// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PotluckCircle} from "../../src/PotluckCircle.sol";
import {PotluckFactory} from "../../src/PotluckFactory.sol";
import {PotluckReputation} from "../../src/PotluckReputation.sol";

/// Local fixture for ordinary transfers and ERC-20 return-value compatibility.
contract ReviewToken is ERC20 {
    uint8 private immutable _decimals;
    bool public emptyReturn;
    bool public falseReturn;

    constructor(uint8 decimals_) ERC20("Review token", "RVT") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setReturns(bool empty_, bool false_) external {
        emptyReturn = empty_;
        falseReturn = false_;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (falseReturn) return false;
        bool ok = super.transfer(to, amount);
        if (emptyReturn) {
            assembly ("memory-safe") { return(0, 0) }
        }
        return ok;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (falseReturn) return false;
        bool ok = super.transferFrom(from, to, amount);
        if (emptyReturn) {
            assembly ("memory-safe") { return(0, 0) }
        }
        return ok;
    }
}

/// Positive safety checks. Findings in review/FINDINGS.md are assessed separately.
contract PotluckReviewTest is Test {
    PotluckFactory internal factory;
    address[20] internal actors;

    function setUp() public {
        vm.warp(1_790_000_000);
        factory = new PotluckFactory();
        for (uint256 i; i < actors.length; ++i) {
            actors[i] = makeAddr(string.concat("review-member-", vm.toString(i)));
        }
    }

    function _config(ReviewToken token, uint8 n, uint128 amount, uint128 collateral, PotluckCircle.Mode mode)
        internal
        pure
        returns (PotluckCircle.Config memory)
    {
        return PotluckCircle.Config({
            token: token,
            contribution: amount,
            collateral: collateral,
            size: n,
            roundDuration: 60,
            joinWindow: 60,
            bondBps: 3000,
            maxDiscountBps: mode == PotluckCircle.Mode.Auction ? 3000 : 0,
            mode: mode
        });
    }

    function _create(PotluckCircle.Config memory c) internal returns (PotluckCircle) {
        return PotluckCircle(factory.createCircle("Review checks", c));
    }

    function _assertBacking(PotluckCircle circle, ReviewToken token) internal view {
        address[] memory members = circle.members();
        uint256 obligations;
        for (uint256 i; i < members.length; ++i) {
            PotluckCircle.Member memory m = circle.memberInfo(members[i]);
            obligations += uint256(m.collateralLeft) + uint256(m.bond) + uint256(m.claimable);
        }
        if (circle.phase() == PotluckCircle.Phase.Active) {
            obligations += circle.collected(circle.currentRound());
        }
        assertEq(token.balanceOf(address(circle)), obligations, "balance backs every obligation");
    }

    function _fundAndJoin(PotluckCircle circle, ReviewToken token, uint8 count) internal returns (uint256 funding) {
        PotluckCircle.Config memory c = circle.config();
        funding = uint256(c.collateral) + uint256(c.size) * c.contribution + 100;
        for (uint256 i; i < count; ++i) {
            token.mint(actors[i], funding);
            vm.startPrank(actors[i]);
            token.approve(address(circle), type(uint256).max);
            circle.join();
            vm.stopPrank();
            _assertBacking(circle, token);
        }
    }

    function _payAll(PotluckCircle circle, ReviewToken token, uint8 n) internal {
        for (uint256 i; i < n; ++i) {
            vm.prank(actors[i]);
            circle.contribute();
            _assertBacking(circle, token);
        }
    }

    function _close(PotluckCircle circle, ReviewToken token) internal {
        vm.warp(circle.roundDeadline(circle.currentRound()) + 1);
        circle.settleRound();
        _assertBacking(circle, token);
    }

    function _withdrawAll(PotluckCircle circle, ReviewToken token, uint8 n) internal {
        for (uint256 i; i < n; ++i) {
            PotluckCircle.Member memory m = circle.memberInfo(actors[i]);
            if (uint256(m.collateralLeft) + m.bond + m.claimable != 0) {
                vm.prank(actors[i]);
                circle.withdraw();
                _assertBacking(circle, token);
            }
        }
        assertEq(token.balanceOf(address(circle)), 0, "all assigned funds withdrawable");
    }

    function _ordinaryCycle(uint8 decimals_, bool emptyReturn) internal {
        ReviewToken token = new ReviewToken(decimals_);
        token.setReturns(emptyReturn, false);
        uint128 amount = uint128(100 * 10 ** uint256(decimals_));
        PotluckCircle circle = _create(_config(token, 3, amount, amount, PotluckCircle.Mode.Fixed));
        uint256 funding = _fundAndJoin(circle, token, 3);
        for (uint256 r = 1; r <= 3; ++r) {
            _payAll(circle, token, 3);
            circle.settleRound();
            _assertBacking(circle, token);
            assertEq(circle.result(r).winner, actors[r - 1]);
        }
        assertEq(circle.result(3).bondHeld, 0, "last winner owes no further rounds");
        _withdrawAll(circle, token, 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(token.balanceOf(actors[i]), funding);
        }
    }

    function test_sixAndEighteenDecimalsConserveFunds() public {
        _ordinaryCycle(6, false);
        _ordinaryCycle(18, false);
    }

    function test_emptyReturnTokenCompletesAndRefunds() public {
        _ordinaryCycle(6, true);
    }

    function test_falseReturnRollsBackJoinContributionClaimAndWithdrawal() public {
        ReviewToken token = new ReviewToken(6);
        PotluckCircle circle = _create(_config(token, 2, 100, 100, PotluckCircle.Mode.Fixed));
        token.mint(actors[0], 100);
        vm.prank(actors[0]);
        token.approve(address(circle), type(uint256).max);
        token.setReturns(false, true);
        vm.prank(actors[0]);
        vm.expectRevert();
        circle.join();
        assertEq(circle.memberCount(), 0);
        assertFalse(circle.memberInfo(actors[0]).joined);
        _assertBacking(circle, token);

        token.setReturns(false, false);
        _fundAndJoin(circle, token, 2);
        token.setReturns(false, true);
        vm.prank(actors[0]);
        vm.expectRevert();
        circle.contribute();
        assertFalse(circle.paid(1, actors[0]));
        assertEq(circle.memberInfo(actors[0]).contributed, 0);
        assertEq(circle.memberInfo(actors[0]).onTime, 0);
        _assertBacking(circle, token);

        token.setReturns(false, false);
        _payAll(circle, token, 2);
        circle.settleRound();
        uint128 credit = circle.memberInfo(actors[0]).claimable;
        assertGt(credit, 0);
        token.setReturns(false, true);
        vm.prank(actors[0]);
        vm.expectRevert();
        circle.claim();
        assertEq(circle.memberInfo(actors[0]).claimable, credit);

        token.setReturns(false, false);
        _payAll(circle, token, 2);
        token.setReturns(false, true);
        circle.settleRound(); // Settlement makes no token transfers.
        bytes32 beforeState = keccak256(abi.encode(circle.memberInfo(actors[0])));
        vm.prank(actors[0]);
        vm.expectRevert();
        circle.withdraw();
        assertEq(keccak256(abi.encode(circle.memberInfo(actors[0]))), beforeState);
        _assertBacking(circle, token);
        token.setReturns(false, false);
        _withdrawAll(circle, token, 2);
    }

    function test_exactRoundDeadlineAndNoDuplicateSettlement() public {
        for (uint256 mode; mode < 2; ++mode) {
            ReviewToken token = new ReviewToken(6);
            PotluckCircle circle = _create(_config(token, 2, 100, 100, PotluckCircle.Mode(mode)));
            _fundAndJoin(circle, token, 2);
            vm.warp(circle.roundDeadline(1));
            _payAll(circle, token, 2);
            assertEq(circle.memberInfo(actors[0]).onTime, 1);
            if (mode == uint256(PotluckCircle.Mode.Auction)) {
                vm.prank(actors[1]);
                circle.bid(0); // The exact deadline still permits bids.
                vm.expectRevert(PotluckCircle.RoundStillOpen.selector);
                circle.settleRound();
                vm.warp(block.timestamp + 1);
            }
            circle.settleRound();
            bytes32 settled = keccak256(abi.encode(circle.result(1)));
            vm.expectRevert(PotluckCircle.RoundStillOpen.selector);
            circle.settleRound();
            assertEq(circle.currentRound(), 2);
            assertEq(keccak256(abi.encode(circle.result(1))), settled);
            _payAll(circle, token, 2);
            _close(circle, token);
            vm.expectRevert(PotluckCircle.WrongPhase.selector);
            circle.settleRound();
            _withdrawAll(circle, token, 2);
        }
    }

    function test_cancellationAtJoinDeadlineAndAfterExpiry() public {
        ReviewToken token = new ReviewToken(6);
        PotluckCircle circle = _create(_config(token, 3, 100, 100, PotluckCircle.Mode.Fixed));
        vm.warp(circle.joinDeadline());
        uint256 funding = _fundAndJoin(circle, token, 2); // Joining at the boundary is allowed.
        vm.prank(actors[2]);
        vm.expectRevert(PotluckCircle.NotCancellable.selector);
        circle.cancel();
        vm.warp(block.timestamp + 1);
        vm.prank(actors[2]);
        circle.cancel();
        _withdrawAll(circle, token, 2);
        for (uint256 i; i < 2; ++i) {
            assertEq(token.balanceOf(actors[i]), funding);
        }
        vm.prank(actors[0]);
        vm.expectRevert(PotluckCircle.NothingToWithdraw.selector);
        circle.withdraw();
    }

    function test_creatorCanCancelBeforeExpiryWithoutBeingMember() public {
        ReviewToken token = new ReviewToken(6);
        PotluckCircle circle = _create(_config(token, 3, 100, 100, PotluckCircle.Mode.Fixed));
        uint256 funding = _fundAndJoin(circle, token, 1);
        circle.cancel();
        _withdrawAll(circle, token, 1);
        assertEq(token.balanceOf(actors[0]), funding);
    }

    function test_allPartialCoverageDefaultsStillCompleteAndRefund() public {
        ReviewToken token = new ReviewToken(6);
        PotluckCircle circle = _create(_config(token, 3, 100, 7, PotluckCircle.Mode.Fixed));
        uint256 funding = _fundAndJoin(circle, token, 3);
        _close(circle, token);
        assertEq(circle.result(1).winner, address(0));
        assertEq(circle.result(1).pot, 21);
        for (uint256 i; i < 3; ++i) {
            PotluckCircle.Member memory m = circle.memberInfo(actors[i]);
            assertTrue(m.defaulted);
            assertEq(m.collateralLeft, 0);
            assertEq(m.claimable, 7);
        }
        circle.settleRound(); // All members are already defaulted.
        circle.settleRound();
        assertEq(uint8(circle.phase()), uint8(PotluckCircle.Phase.Completed));
        _withdrawAll(circle, token, 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(token.balanceOf(actors[i]), funding);
        }
    }

    function test_noEligibleWinnerSplitsPotAmongRemainingGoodMembers() public {
        ReviewToken token = new ReviewToken(6);
        PotluckCircle circle = _create(_config(token, 3, 100, 0, PotluckCircle.Mode.Fixed));
        _fundAndJoin(circle, token, 3);
        for (uint256 r = 1; r <= 3; ++r) {
            _payAll(circle, token, 2);
            _close(circle, token);
        }
        assertEq(circle.result(1).winner, actors[0]);
        assertEq(circle.result(2).winner, actors[1]);
        assertEq(circle.result(3).winner, address(0));
        assertEq(circle.result(3).pot, 200);
        _withdrawAll(circle, token, 3);
    }

    function test_twentyMembersCanMissEveryRoundWithSufficientCollateral() public {
        ReviewToken token = new ReviewToken(6);
        PotluckCircle circle = _create(_config(token, 20, 100, 2000, PotluckCircle.Mode.Auction));
        uint256 funding = _fundAndJoin(circle, token, 20);
        for (uint256 r = 1; r <= 20; ++r) {
            _close(circle, token);
            assertEq(circle.result(r).winner, actors[r - 1]);
            assertEq(circle.result(r).pot, 2000);
        }
        for (uint256 i; i < 20; ++i) {
            PotluckCircle.Member memory m = circle.memberInfo(actors[i]);
            assertFalse(m.defaulted);
            assertEq(m.missed, 20);
            assertEq(m.contributed, 0);
        }
        assertEq(circle.result(20).bondHeld, 0);
        _withdrawAll(circle, token, 20);
        for (uint256 i; i < 20; ++i) {
            assertEq(token.balanceOf(actors[i]), funding);
        }
    }

    function test_subunitDividendRemainderReturnsToWinner() public {
        ReviewToken token = new ReviewToken(6);
        PotluckCircle circle = _create(_config(token, 4, 1, 0, PotluckCircle.Mode.Auction));
        _fundAndJoin(circle, token, 4);
        _payAll(circle, token, 4);
        vm.prank(actors[0]);
        circle.bid(1);
        _close(circle, token);
        assertEq(circle.result(1).payout, 4);
        for (uint256 i = 1; i < 4; ++i) {
            assertEq(circle.memberInfo(actors[i]).claimable, 0);
        }
        for (uint256 r = 2; r <= 4; ++r) {
            _payAll(circle, token, 4);
            _close(circle, token);
        }
        _withdrawAll(circle, token, 4);
    }

    function test_initializationAndMemberAuthorizationRemainEnforced() public {
        ReviewToken token = new ReviewToken(6);
        PotluckCircle.Config memory c = _config(token, 2, 100, 100, PotluckCircle.Mode.Auction);
        PotluckCircle circle = _create(c);
        PotluckReputation registry = factory.reputation();
        PotluckCircle implementation = PotluckCircle(factory.implementation());
        vm.expectRevert();
        circle.initialize(address(this), "again", c, address(registry));
        vm.expectRevert();
        implementation.initialize(address(this), "implementation", c, address(0));
        assertTrue(registry.isCircle(address(circle)));
        assertFalse(registry.isCircle(factory.implementation()));
        vm.expectRevert(PotluckReputation.OnlyFactory.selector);
        registry.authorize(address(this));
        vm.expectRevert(PotluckReputation.OnlyCircle.selector);
        registry.record(actors[0], 1, 0, false, 100);
        _fundAndJoin(circle, token, 2);
        vm.expectRevert(PotluckCircle.NotMember.selector);
        circle.contribute();
        vm.expectRevert(PotluckCircle.NotEligible.selector);
        circle.bid(0);
        vm.expectRevert(PotluckCircle.NothingToWithdraw.selector);
        circle.claim();
        for (uint256 r = 1; r <= 2; ++r) {
            _payAll(circle, token, 2);
            _close(circle, token);
        }
        vm.expectRevert(PotluckCircle.NotMember.selector);
        circle.withdraw();
        _withdrawAll(circle, token, 2);
    }

    function _exerciseRound(PotluckCircle circle, ReviewToken token, uint8 n, uint256 seed, uint256 r) internal {
        for (uint256 i; i < n; ++i) {
            PotluckCircle.Member memory m = circle.memberInfo(actors[i]);
            uint256 choice = uint256(keccak256(abi.encode(seed, r, i)));
            if (!m.defaulted && choice % 3 != 0) {
                vm.prank(actors[i]);
                circle.contribute();
                _assertBacking(circle, token);
            }
            if (m.claimable > 0 && choice % 2 == 0) {
                vm.prank(actors[i]);
                circle.claim();
                _assertBacking(circle, token);
            }
        }
        if (circle.config().mode == PotluckCircle.Mode.Auction) {
            for (uint256 i; i < n; ++i) {
                PotluckCircle.Member memory m = circle.memberInfo(actors[i]);
                if (m.defaulted || m.won || !circle.paid(r, actors[i])) continue;
                // Positive accounting coverage uses bids backed by funds already collected.
                uint256 cap = circle.maxDiscount();
                if (cap > circle.collected(r)) cap = circle.collected(r);
                uint128 discount = uint128(uint256(keccak256(abi.encode(seed, r))) % (cap + 1));
                vm.prank(actors[i]);
                circle.bid(discount);
                break;
            }
        }
        _close(circle, token);
    }

    function testFuzz_plainTokenBackingAndCompletion(uint8 n, uint16 bondBps, uint256 seed) public {
        n = uint8(bound(n, 2, 20));
        bondBps = uint16(bound(bondBps, 0, 5000));
        uint128 amount = uint128(1 + seed % 1e18);
        uint128 collateral = amount * uint128((seed >> 64) % 4);
        ReviewToken token = new ReviewToken(seed % 2 == 0 ? 6 : 18);
        PotluckCircle.Mode mode = (seed >> 1) % 2 == 0 ? PotluckCircle.Mode.Fixed : PotluckCircle.Mode.Auction;
        PotluckCircle.Config memory c = _config(token, n, amount, collateral, mode);
        c.bondBps = bondBps;
        PotluckCircle circle = _create(c);
        uint256 funding = _fundAndJoin(circle, token, n);
        for (uint256 r = 1; r <= n; ++r) {
            _exerciseRound(circle, token, n, seed, r);
        }
        assertEq(uint8(circle.phase()), uint8(PotluckCircle.Phase.Completed));
        assertEq(circle.currentRound(), n);
        assertEq(circle.result(n).bondHeld, 0);
        for (uint256 i; i < n; ++i) {
            uint256 wins;
            for (uint256 r = 1; r <= n; ++r) {
                if (circle.result(r).winner == actors[i]) ++wins;
            }
            assertLe(wins, 1);
            assertTrue(factory.reputation().recorded(address(circle), actors[i]));
        }
        _withdrawAll(circle, token, n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            total += token.balanceOf(actors[i]);
        }
        assertEq(total, uint256(n) * funding, "no value created or stranded");
    }
}
