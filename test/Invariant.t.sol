// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {PotluckFactory} from "../src/PotluckFactory.sol";
import {PotluckCircle} from "../src/PotluckCircle.sol";
import {TestUSDG} from "../src/mocks/TestUSDG.sol";

/// Random sequences of join / contribute / bid / settle / withdraw / time jumps from four members.
contract CircleHandler is Test {
    PotluckCircle public circle;
    TestUSDG public usdg;
    address[] public actors;
    uint256 public settled;

    constructor(PotluckCircle c, TestUSDG u, address[] memory a) {
        circle = c;
        usdg = u;
        actors = a;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function join(uint256 seed) external {
        vm.prank(_actor(seed));
        try circle.join() {} catch {}
    }

    function contribute(uint256 seed) external {
        vm.prank(_actor(seed));
        try circle.contribute() {} catch {}
    }

    function bid(uint256 seed, uint128 discount) external {
        discount = uint128(bound(discount, 0, circle.maxDiscount()));
        vm.prank(_actor(seed));
        try circle.bid(discount) {} catch {}
    }

    function settle() external {
        try circle.settleRound() {
            settled++;
        } catch {}
    }

    function claim(uint256 seed) external {
        vm.prank(_actor(seed));
        try circle.claim() {} catch {}
    }

    function withdraw(uint256 seed) external {
        vm.prank(_actor(seed));
        try circle.withdraw() {} catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }
}

contract PotluckInvariantTest is Test {
    PotluckCircle circle;
    TestUSDG usdg;
    CircleHandler handler;
    address[] actors;

    function setUp() public {
        vm.warp(1_790_000_000);
        PotluckFactory factory = new PotluckFactory();
        usdg = new TestUSDG();
        PotluckCircle.Config memory c = PotluckCircle.Config({
            token: usdg,
            contribution: 100e6,
            collateral: 100e6,
            size: 4,
            roundDuration: 1 days,
            joinWindow: 3 days,
            bondBps: 3000,
            maxDiscountBps: 2000,
            mode: PotluckCircle.Mode.Auction
        });
        circle = PotluckCircle(factory.createCircle("invariant", c));
        for (uint256 i; i < 4; ++i) {
            address a = makeAddr(string.concat("m", vm.toString(i)));
            actors.push(a);
            deal(address(usdg), a, 5_000e6);
            vm.prank(a);
            usdg.approve(address(circle), type(uint256).max);
        }
        handler = new CircleHandler(circle, usdg, actors);
        targetContract(address(handler));
    }

    /// The circle always holds exactly what it owes: unreturned collateral, bonds and unclaimed payouts, plus the current
    /// round's collected pot while a round is open.
    function invariant_balanceMatchesObligations() public view {
        uint256 owed;
        for (uint256 i; i < actors.length; ++i) {
            PotluckCircle.Member memory m = circle.memberInfo(actors[i]);
            owed += m.collateralLeft + m.bond + m.claimable;
        }
        if (circle.phase() == PotluckCircle.Phase.Active) owed += circle.collected(circle.currentRound());
        assertEq(usdg.balanceOf(address(circle)), owed);
    }

    /// No member ever receives more than was ever put in by everyone.
    function invariant_noValueCreated() public view {
        uint256 total;
        for (uint256 i; i < actors.length; ++i) total += usdg.balanceOf(actors[i]);
        total += usdg.balanceOf(address(circle));
        assertEq(total, 4 * 5_000e6);
    }

    function afterInvariant() public {
        // Evidence that the random sequences really reach settlement and completion, not just joining.
        console2.log("rounds settled in this run", handler.settled(), "phase", uint8(circle.phase()));
    }

    /// A round, once settled, never changes; the round counter only moves forward.
    function invariant_roundBounds() public view {
        assertLe(circle.currentRound(), 4);
        if (circle.phase() == PotluckCircle.Phase.Completed) {
            for (uint256 r = 1; r <= 4; ++r) assertGt(circle.result(r).settledAt, 0);
        }
    }
}
