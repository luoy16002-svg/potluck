// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {PotluckFactory} from "../src/PotluckFactory.sol";
import {PotluckCircle} from "../src/PotluckCircle.sol";

/// Opt in with --fork-url arc_mainnet or arc_testnet, using Arc Foundry.
/// Upstream Forge must fail these tests on an Arc fork, rather than mask missing precompiles.
contract ArcForkTest is Test {
    IERC20Metadata constant USDC = IERC20Metadata(0x3600000000000000000000000000000000000000);
    address constant RESTRICTED = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    uint128 constant C = 100e6;
    uint256 constant INITIAL = 10_000e6;
    uint256 constant SCALE = 1e12;
    PotluckFactory factory;
    address[3] people;

    function setUp() public {
        // Keep forge test offline and the existing suite unchanged.
        try vm.activeFork() returns (uint256) {}
        catch {
            vm.skip(true, "Arc integration: supply --fork-url arc_mainnet or arc_testnet");
        }
        require(block.chainid == 5042 || block.chainid == 5042002, "Expected an Arc fork");
        assertEq(USDC.decimals(), 6);
        factory = new PotluckFactory();
        for (uint256 i; i < 3; ++i) {
            people[i] = makeAddr(string.concat("arc-member-", vm.toString(i)));
            vm.deal(people[i], INITIAL * SCALE);
            _balance(people[i], INITIAL);
        }
    }

    function _config(PotluckCircle.Mode mode) internal pure returns (PotluckCircle.Config memory) {
        return PotluckCircle.Config({
            token: USDC,
            contribution: C,
            collateral: C,
            size: 3,
            roundDuration: 60,
            joinWindow: 1 days,
            bondBps: 2000,
            maxDiscountBps: mode == PotluckCircle.Mode.Auction ? 3000 : 0,
            mode: mode
        });
    }

    function _create(PotluckCircle.Config memory cfg) internal returns (PotluckCircle circle) {
        vm.prank(people[0]);
        circle = PotluckCircle(factory.createCircle("Arc fork circle", cfg));
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(people[i]);
            USDC.approve(address(circle), type(uint256).max);
            circle.join();
            vm.stopPrank();
            _balance(people[i], INITIAL - cfg.collateral);
            _backing(circle);
        }
        assertEq(uint8(circle.phase()), uint8(PotluckCircle.Phase.Active));
    }

    function _balance(address who, uint256 expected) internal view {
        assertEq(USDC.balanceOf(who), expected, "ERC20 balance");
        assertEq(who.balance, expected * SCALE, "native balance (including dust)");
    }

    function _backing(PotluckCircle circle) internal view {
        uint256 owed;
        for (uint256 i; i < 3; ++i) {
            PotluckCircle.Member memory m = circle.memberInfo(people[i]);
            owed += uint256(m.collateralLeft) + m.bond + m.claimable;
        }
        if (circle.phase() == PotluckCircle.Phase.Active) owed += circle.collected(circle.currentRound());
        _balance(address(circle), owed);
    }

    function _pay(PotluckCircle circle, uint256 i) internal {
        uint256 beforeBalance = USDC.balanceOf(people[i]);
        vm.prank(people[i]);
        circle.contribute();
        _balance(people[i], beforeBalance - C);
        _backing(circle);
    }

    function _claim(PotluckCircle circle, uint256 i) internal {
        uint256 amount = circle.memberInfo(people[i]).claimable;
        if (amount == 0) return;
        uint256 beforeBalance = USDC.balanceOf(people[i]);
        vm.prank(people[i]);
        circle.claim();
        _balance(people[i], beforeBalance + amount);
        assertEq(circle.memberInfo(people[i]).claimable, 0);
        _backing(circle);
    }

    function _withdraw(PotluckCircle circle, uint256 i, uint256 expected) internal {
        PotluckCircle.Member memory m = circle.memberInfo(people[i]);
        if (uint256(m.collateralLeft) + m.bond + m.claimable > 0) {
            vm.prank(people[i]);
            circle.withdraw();
        }
        _balance(people[i], expected);
        _backing(circle);
    }

    function test_nativeFundingAndFractionalERC20View() public {
        address probe = makeAddr("native-balance-probe");
        vm.deal(probe, 123e18 + SCALE - 1);
        assertEq(USDC.balanceOf(probe), 123e6, "balanceOf truncates only sub-micro-USDC");
        assertEq(probe.balance, 123e18 + SCALE - 1);
        vm.prank(probe);
        USDC.transfer(people[0], 1e6);
        assertEq(probe.balance, 122e18 + SCALE - 1);
        assertEq(USDC.balanceOf(probe), 122e6);
        _balance(people[0], INITIAL + 1e6);
    }

    // StdStorage cannot discover a balance mapping for native-backed USDC.
    function setERC20Balance(address who, uint256 amount) external {
        require(msg.sender == address(this));
        deal(address(USDC), who, amount);
    }

    function test_erc20DealProbe() public {
        address probe = makeAddr("erc20-deal-probe");
        vm.deal(probe, 0);
        try this.setERC20Balance(probe, 123e6) {
            _balance(probe, 123e6);
            console2.log("ERC20 deal supported by this runtime");
        } catch {
            console2.log("ERC20 deal cannot locate native-backed balance; use vm.deal");
            _balance(probe, 0);
        }
        vm.deal(probe, 123e18);
        _balance(probe, 123e6);
    }

    function test_fixedThreeMembersComplete() public {
        PotluckCircle circle = _create(_config(PotluckCircle.Mode.Fixed));
        // Same-second Arc blocks do not prevent fully-paid fixed rounds from settling.
        for (uint256 r = 1; r <= 3; ++r) {
            for (uint256 i; i < 3; ++i) {
                _pay(circle, i);
            }
            circle.settleRound();
            PotluckCircle.RoundResult memory result = circle.result(r);
            assertEq(result.winner, people[r - 1]);
            assertEq(result.pot, 3 * C);
            assertEq(result.bondHeld, r < 3 ? 60e6 : 0);
            assertEq(result.payout, r < 3 ? 240e6 : 300e6);
            _backing(circle);
            _claim(circle, r - 1);
        }
        assertEq(uint8(circle.phase()), uint8(PotluckCircle.Phase.Completed));
        for (uint256 i; i < 3; ++i) {
            _withdraw(circle, i, INITIAL);
            assertEq(factory.reputation().stats(people[i]).onTimePayments, 3);
            assertEq(factory.reputation().stats(people[i]).circlesCompleted, 1);
        }
        _balance(address(circle), 0);
    }

    function test_auctionThreeMembersCompleteWithRounding() public {
        PotluckCircle circle = _create(_config(PotluckCircle.Mode.Auction));
        uint128[3] memory discounts = [uint128(30e6 + 1), uint128(20e6), uint128(0)];
        uint256[3] memory winners = [uint256(2), uint256(0), uint256(1)];
        for (uint256 r = 1; r <= 3; ++r) {
            for (uint256 i; i < 3; ++i) {
                _pay(circle, i);
            }
            vm.prank(people[winners[r - 1]]);
            circle.bid(discounts[r - 1]);
            vm.warp(circle.roundDeadline(r));
            vm.expectRevert(PotluckCircle.RoundStillOpen.selector);
            circle.settleRound();
            vm.warp(circle.roundDeadline(r) + 1);
            circle.settleRound();
            PotluckCircle.RoundResult memory result = circle.result(r);
            assertEq(result.winner, people[winners[r - 1]]);
            assertEq(result.pot, 300e6);
            assertEq(result.discount, discounts[r - 1]);
            uint128 gross = 300e6 - discounts[r - 1];
            uint128 bond = r < 3 ? uint128(uint256(gross) * 2000 / 10_000) : 0;
            assertEq(result.bondHeld, bond);
            assertEq(result.payout, gross - bond + discounts[r - 1] % 2);
            _backing(circle);
            for (uint256 i; i < 3; ++i) {
                _claim(circle, i);
            }
        }
        assertEq(uint8(circle.phase()), uint8(PotluckCircle.Phase.Completed));
        _withdraw(circle, 0, INITIAL - 5e6);
        _withdraw(circle, 1, INITIAL + 25e6);
        _withdraw(circle, 2, INITIAL - 20e6);
        _balance(address(circle), 0);
    }

    function test_missedPaymentCoveredFromCollateral() public {
        PotluckCircle circle = _create(_config(PotluckCircle.Mode.Fixed));
        for (uint256 r = 1; r <= 3; ++r) {
            for (uint256 i; i < 3; ++i) {
                if (r == 2 && i == 0) continue;
                _pay(circle, i);
            }
            if (r == 2) vm.warp(circle.roundDeadline(r) + 1);
            circle.settleRound();
            assertEq(circle.result(r).pot, 300e6);
            _backing(circle);
        }
        PotluckCircle.Member memory missed = circle.memberInfo(people[0]);
        assertEq(missed.collateralLeft, 0);
        assertEq(missed.bond, 60e6, "collateral used before winner bond");
        assertEq(missed.missed, 1);
        assertEq(missed.contributed, 200e6);
        assertFalse(missed.defaulted);
        assertEq(factory.reputation().stats(people[0]).missedPayments, 1);
        for (uint256 i; i < 3; ++i) {
            _withdraw(circle, i, INITIAL);
        }
        _balance(address(circle), 0);
    }

    function test_restrictedMemberCannotFundButOthersComplete() public {
        if (block.chainid != 5042002) vm.skip(true, "Seeded blocklisted address is documented only on testnet");
        people[0] = RESTRICTED;
        vm.deal(RESTRICTED, INITIAL * SCALE);
        // No blocked token transfer is needed to join a zero-collateral circle.
        PotluckCircle.Config memory cfg = _config(PotluckCircle.Mode.Fixed);
        cfg.collateral = 0;
        cfg.bondBps = 0;
        PotluckCircle circle = _create(cfg);
        vm.prank(RESTRICTED);
        vm.expectRevert();
        circle.contribute();
        assertFalse(circle.paid(1, RESTRICTED));
        _backing(circle);
        for (uint256 r = 1; r <= 3; ++r) {
            _pay(circle, 1);
            _pay(circle, 2);
            vm.warp(circle.roundDeadline(r) + 1);
            circle.settleRound();
            assertEq(circle.result(r).pot, 200e6);
            _backing(circle);
        }
        assertEq(uint8(circle.phase()), uint8(PotluckCircle.Phase.Completed));
        assertTrue(circle.memberInfo(RESTRICTED).defaulted);
        assertEq(circle.memberInfo(people[1]).claimable, 300e6);
        assertEq(circle.memberInfo(people[2]).claimable, 300e6);
        assertEq(factory.reputation().stats(RESTRICTED).circlesDefaulted, 1);
        for (uint256 i; i < 3; ++i) {
            _withdraw(circle, i, INITIAL);
        }
        _balance(address(circle), 0);
    }
}
