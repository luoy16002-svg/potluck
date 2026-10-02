// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PotluckFactory} from "../src/PotluckFactory.sol";
import {PotluckCircle} from "../src/PotluckCircle.sol";
import {PotluckReputation} from "../src/PotluckReputation.sol";
import {TestUSDG} from "../src/mocks/TestUSDG.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract PotluckTest is Test {
    PotluckFactory factory;
    PotluckReputation rep;
    TestUSDG usdg;
    address[] people;

    uint128 constant C = 100e6; // 100 USDG a round
    uint32 constant ROUND = 1 days;

    function setUp() public {
        vm.warp(1_790_000_000);
        factory = new PotluckFactory();
        rep = factory.reputation();
        usdg = new TestUSDG();
        for (uint256 i; i < 6; ++i) {
            address p = makeAddr(string.concat("member", vm.toString(i)));
            people.push(p);
            deal(address(usdg), p, 10_000e6);
        }
    }

    function _cfg(uint8 size, PotluckCircle.Mode mode, uint16 bondBps, uint16 maxDiscBps)
        internal
        view
        returns (PotluckCircle.Config memory c)
    {
        c = PotluckCircle.Config({
            token: usdg,
            contribution: C,
            collateral: C,
            size: size,
            roundDuration: ROUND,
            joinWindow: 3 days,
            bondBps: bondBps,
            maxDiscountBps: maxDiscBps,
            mode: mode
        });
    }

    function _create(PotluckCircle.Config memory c) internal returns (PotluckCircle circle) {
        vm.prank(people[0]);
        circle = PotluckCircle(factory.createCircle("Test circle", c));
    }

    function _joinAll(PotluckCircle circle, uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            vm.startPrank(people[i]);
            usdg.approve(address(circle), type(uint256).max);
            circle.join();
            vm.stopPrank();
        }
    }

    function _payAll(PotluckCircle circle, uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            vm.prank(people[i]);
            circle.contribute();
        }
    }

    // ------------------------------------------------------------------------------------------ fixed

    function test_fixedCircle_fullCycle_everyonePaidBack() public {
        PotluckCircle circle = _create(_cfg(4, PotluckCircle.Mode.Fixed, 2000, 0));
        _joinAll(circle, 4);
        assertEq(uint8(circle.phase()), uint8(PotluckCircle.Phase.Active));

        for (uint256 r = 1; r <= 4; ++r) {
            _payAll(circle, 4);
            circle.settleRound(); // everyone paid: fixed mode may settle early
            assertEq(circle.result(r).winner, people[r - 1]);
            assertEq(circle.result(r).pot, 4 * C);
        }
        assertEq(uint8(circle.phase()), uint8(PotluckCircle.Phase.Completed));

        for (uint256 i; i < 4; ++i) {
            vm.prank(people[i]);
            circle.withdraw();
            // paid 4 rounds, received the pot, got collateral and bond back: net zero
            assertEq(usdg.balanceOf(people[i]), 10_000e6, "net position");
        }
        assertEq(usdg.balanceOf(address(circle)), 0, "circle empty");
        assertEq(rep.stats(people[0]).circlesCompleted, 1);
        assertEq(rep.stats(people[0]).onTimePayments, 4);
        assertEq(rep.score(people[0]), 500 + 40 + 40);
    }

    function test_bondIsCappedAtWhatTheWinnerStillOwes() public {
        PotluckCircle circle = _create(_cfg(4, PotluckCircle.Mode.Fixed, 5000, 0));
        _joinAll(circle, 4);
        _payAll(circle, 4);
        circle.settleRound();
        // pot 400, 50% = 200, still owed 3 rounds * 100 = 300 -> bond 200
        assertEq(circle.result(1).bondHeld, 200e6);
        for (uint256 r = 2; r <= 3; ++r) {
            _payAll(circle, 4);
            circle.settleRound();
        }
        // round 3 winner owes 1 round: bond capped at 100
        assertEq(circle.result(3).bondHeld, 100e6);
        _payAll(circle, 4);
        circle.settleRound();
        assertEq(circle.result(4).bondHeld, 0, "last winner owes nothing");
    }

    function test_fixedCannotSettleEarlyIfSomeoneHasNotPaid() public {
        PotluckCircle circle = _create(_cfg(3, PotluckCircle.Mode.Fixed, 0, 0));
        _joinAll(circle, 3);
        _payAll(circle, 2);
        vm.expectRevert(PotluckCircle.RoundStillOpen.selector);
        circle.settleRound();
    }

    // ---------------------------------------------------------------------------------------- default

    function test_missedPaymentIsCoveredByCollateral() public {
        PotluckCircle circle = _create(_cfg(3, PotluckCircle.Mode.Fixed, 0, 0));
        _joinAll(circle, 3);
        _payAll(circle, 2); // member2 misses round 1
        vm.warp(circle.roundDeadline(1) + 1);
        circle.settleRound();

        assertEq(circle.result(1).pot, 3 * C, "pot is whole");
        PotluckCircle.Member memory m = circle.memberInfo(people[2]);
        assertEq(m.collateralLeft, 0);
        assertEq(m.missed, 1);
        assertFalse(m.defaulted);
    }

    function test_memberWhoCannotCoverDefaultsAndIsSkipped() public {
        PotluckCircle circle = _create(_cfg(3, PotluckCircle.Mode.Fixed, 0, 0));
        _joinAll(circle, 3);
        // member0 wins round 1
        _payAll(circle, 3);
        circle.settleRound();
        // member1 misses rounds 2 and 3: round 2 covered by collateral, round 3 -> default
        vm.prank(people[0]);
        circle.contribute();
        vm.prank(people[2]);
        circle.contribute();
        vm.warp(circle.roundDeadline(2) + 1);
        circle.settleRound();
        // member1 was next in line and still in good standing (collateral covered) -> wins round 2
        assertEq(circle.result(2).winner, people[1]);

        vm.prank(people[0]);
        circle.contribute();
        vm.prank(people[2]);
        circle.contribute();
        vm.warp(circle.roundDeadline(3) + 1);
        circle.settleRound();
        PotluckCircle.Member memory m1 = circle.memberInfo(people[1]);
        assertTrue(m1.defaulted, "no collateral left");
        assertEq(circle.result(3).winner, people[2]);
        assertEq(rep.stats(people[1]).circlesDefaulted, 1);
        assertEq(rep.score(people[1]) < 500, true);
    }

    function test_winnerWhoStopsPayingIsCoveredByCollateralFirst() public {
        PotluckCircle circle = _create(_cfg(3, PotluckCircle.Mode.Fixed, 3000, 0));
        _joinAll(circle, 3);
        _payAll(circle, 3);
        circle.settleRound(); // member0 wins, bond = min(30% of 300, 200) = 90
        assertEq(circle.memberInfo(people[0]).bond, 90e6);
        // member0 skips round 2: collateral (100) covers first
        vm.prank(people[1]);
        circle.contribute();
        vm.prank(people[2]);
        circle.contribute();
        vm.warp(circle.roundDeadline(2) + 1);
        circle.settleRound();
        assertEq(circle.memberInfo(people[0]).collateralLeft, 0);
        assertEq(circle.memberInfo(people[0]).bond, 90e6);
        // skips round 3 too: bond covers 90 of 100 -> defaulted, pot short by 10
        vm.prank(people[1]);
        circle.contribute();
        vm.prank(people[2]);
        circle.contribute();
        vm.warp(circle.roundDeadline(3) + 1);
        circle.settleRound();
        assertTrue(circle.memberInfo(people[0]).defaulted);
        assertEq(circle.result(3).pot, 290e6);
    }

    // ---------------------------------------------------------------------------------------- auction

    function test_auction_highestDiscountWinsAndOthersShareIt() public {
        PotluckCircle circle = _create(_cfg(4, PotluckCircle.Mode.Auction, 0, 2000));
        _joinAll(circle, 4);
        _payAll(circle, 4);

        vm.prank(people[2]);
        circle.bid(20e6);
        vm.prank(people[3]);
        circle.bid(35e6);
        vm.prank(people[2]);
        vm.expectRevert(PotluckCircle.BidTooLow.selector);
        circle.bid(35e6);

        uint256 before1 = usdg.balanceOf(people[1]);
        uint256 before3 = usdg.balanceOf(people[3]);
        vm.warp(circle.roundDeadline(1) + 1);
        circle.settleRound();
        // settling only credits; nobody is paid until they claim
        assertEq(usdg.balanceOf(people[3]), before3);
        vm.prank(people[1]);
        circle.claim();
        vm.prank(people[3]);
        circle.claim();

        assertEq(circle.result(1).winner, people[3]);
        assertEq(circle.result(1).discount, 35e6);
        // 35 shared by 3 others: 11.666666 each, 2 units of dust to the winner
        assertEq(usdg.balanceOf(people[1]) - before1, 11_666_666);
        assertEq(usdg.balanceOf(people[3]) - before3, 400e6 - 35e6 + 2);
    }

    function test_auction_noBidsFallsBackToJoinOrder() public {
        PotluckCircle circle = _create(_cfg(3, PotluckCircle.Mode.Auction, 0, 1000));
        _joinAll(circle, 3);
        _payAll(circle, 3);
        vm.expectRevert(PotluckCircle.RoundStillOpen.selector); // auctions wait for the deadline
        circle.settleRound();
        vm.warp(circle.roundDeadline(1) + 1);
        circle.settleRound();
        assertEq(circle.result(1).winner, people[0]);
    }

    function test_auction_rules() public {
        PotluckCircle circle = _create(_cfg(3, PotluckCircle.Mode.Auction, 0, 1000));
        _joinAll(circle, 3);
        vm.prank(people[1]);
        vm.expectRevert(PotluckCircle.MustContributeFirst.selector);
        circle.bid(1);
        _payAll(circle, 3);
        vm.prank(people[1]);
        vm.expectRevert(PotluckCircle.DiscountTooHigh.selector);
        circle.bid(30e6 + 1); // max = 10% of 300
        vm.prank(people[1]);
        circle.bid(10e6);
        vm.warp(circle.roundDeadline(1) + 1);
        circle.settleRound();
        // winner cannot bid again
        vm.prank(people[1]);
        circle.contribute();
        vm.prank(people[1]);
        vm.expectRevert(PotluckCircle.NotEligible.selector);
        circle.bid(20e6);
    }

    // --------------------------------------------------------------------------------- forming/cancel

    function test_cancelWhenNotFilled_refundsCollateral() public {
        PotluckCircle circle = _create(_cfg(4, PotluckCircle.Mode.Fixed, 0, 0));
        _joinAll(circle, 2);
        vm.prank(people[3]);
        vm.expectRevert(PotluckCircle.NotCancellable.selector);
        circle.cancel();
        vm.warp(block.timestamp + 3 days + 1);
        vm.prank(people[3]);
        circle.cancel();
        vm.prank(people[1]);
        circle.withdraw();
        assertEq(usdg.balanceOf(people[1]), 10_000e6);
        vm.prank(people[3]);
        vm.expectRevert(PotluckCircle.WrongPhase.selector);
        circle.join();
    }

    function test_configValidation() public {
        PotluckCircle.Config memory c = _cfg(1, PotluckCircle.Mode.Fixed, 0, 0);
        vm.expectRevert(PotluckCircle.BadConfig.selector);
        factory.createCircle("bad", c);
        c = _cfg(4, PotluckCircle.Mode.Fixed, 0, 500); // discount only makes sense in auctions
        vm.expectRevert(PotluckCircle.BadConfig.selector);
        factory.createCircle("bad", c);
    }

    function test_onlyCirclesCanWriteReputation() public {
        vm.expectRevert(PotluckReputation.OnlyCircle.selector);
        rep.record(people[0], 10, 0, false, 1);
        vm.expectRevert(PotluckReputation.OnlyFactory.selector);
        rep.authorize(address(this));
    }

    function test_implementationCannotBeInitialized() public {
        PotluckCircle impl = PotluckCircle(factory.implementation());
        vm.expectRevert();
        impl.initialize(address(this), "x", _cfg(3, PotluckCircle.Mode.Fixed, 0, 0), address(rep));
    }

    // ----------------------------------------------------------------------------------------- frozen

    /// A member whose address the token issuer freezes cannot stop the circle: rounds still settle,
    /// everyone else claims and withdraws, and the frozen member's money stays credited to them.
    function test_frozenMemberCannotBlockTheCircle() public {
        FreezableUSDG f = new FreezableUSDG();
        for (uint256 i; i < 3; ++i) {
            f.mint(people[i], 10_000e6);
        }
        PotluckCircle.Config memory c = _cfg(3, PotluckCircle.Mode.Auction, 2000, 1000);
        c.token = f;
        vm.prank(people[0]);
        PotluckCircle circle = PotluckCircle(factory.createCircle("frozen", c));
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(people[i]);
            f.approve(address(circle), type(uint256).max);
            circle.join();
            vm.stopPrank();
        }
        f.freeze(people[1]); // after joining, the issuer freezes member 1
        for (uint256 r = 1; r <= 3; ++r) {
            for (uint256 i; i < 3; ++i) {
                if (i == 1) continue; // frozen: cannot pay, collateral covers round 1, then defaults
                vm.prank(people[i]);
                circle.contribute();
            }
            vm.warp(circle.roundDeadline(r) + 1);
            circle.settleRound(); // never reverts on the frozen address
        }
        assertEq(uint8(circle.phase()), uint8(PotluckCircle.Phase.Completed));
        for (uint256 i; i < 3; ++i) {
            if (i == 1) continue;
            vm.prank(people[i]);
            circle.withdraw();
        }
        vm.prank(people[1]);
        vm.expectRevert();
        circle.withdraw(); // the token refuses, only for the frozen member
        PotluckCircle.Member memory m1 = circle.memberInfo(people[1]);
        assertEq(usdg.balanceOf(address(circle)), 0);
        assertEq(
            f.balanceOf(address(circle)),
            m1.collateralLeft + m1.bond + m1.claimable,
            "only the frozen member's own funds remain"
        );
    }

    // ------------------------------------------------------------------------------------ conservation

    /// Random sizes, bonds, bids and missed payments: the circle never holds more or less than it owes.
    function testFuzz_moneyIsConserved(uint8 size, uint16 bondBps, uint256 seed) public {
        size = uint8(bound(size, 2, 6));
        bondBps = uint16(bound(bondBps, 0, 5000));
        PotluckCircle circle = _create(_cfg(size, PotluckCircle.Mode.Auction, bondBps, 3000));
        _joinAll(circle, size);
        uint256 total;
        for (uint256 i; i < size; ++i) {
            total += usdg.balanceOf(people[i]);
        }
        total += usdg.balanceOf(address(circle));

        for (uint256 r = 1; r <= size; ++r) {
            for (uint256 i; i < size; ++i) {
                PotluckCircle.Member memory m = circle.memberInfo(people[i]);
                if (m.defaulted) continue;
                if (uint256(keccak256(abi.encode(seed, r, i))) % 5 == 0) continue; // ~20% miss
                vm.prank(people[i]);
                circle.contribute();
            }
            uint256 bidder = uint256(keccak256(abi.encode(seed, r))) % size;
            PotluckCircle.Member memory b = circle.memberInfo(people[bidder]);
            if (!b.won && !b.defaulted && circle.paid(r, people[bidder])) {
                uint256 cap = circle.maxDiscount();
                if (cap > circle.collected(r)) cap = circle.collected(r);
                uint128 d = uint128(uint256(keccak256(abi.encode(seed, "d", r))) % (cap + 1));
                vm.prank(people[bidder]);
                circle.bid(d);
            }
            vm.warp(circle.roundDeadline(r) + 1);
            circle.settleRound();
        }
        for (uint256 i; i < size; ++i) {
            PotluckCircle.Member memory m = circle.memberInfo(people[i]);
            if (m.collateralLeft + m.bond + m.claimable > 0) {
                vm.prank(people[i]);
                circle.withdraw();
            }
        }
        uint256 after_;
        for (uint256 i; i < size; ++i) {
            after_ += usdg.balanceOf(people[i]);
        }
        assertEq(usdg.balanceOf(address(circle)), 0, "nothing stranded");
        assertEq(after_, total, "conserved");
    }
}

/// USDG-like token whose issuer can freeze addresses (Paxos USDG supports freezing).
contract FreezableUSDG is ERC20 {
    mapping(address => bool) public frozen;

    constructor() ERC20("Freezable USDG", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function freeze(address who) external {
        frozen[who] = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!frozen[from] && !frozen[to], "frozen");
        super._update(from, to, value);
    }
}
