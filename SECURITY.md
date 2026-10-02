# Security notes

Potluck holds members' money for the whole life of a circle, so the design keeps the attack surface small and the rules explicit.

## Design choices

- **No owner, no admin, no upgrades.** Circles are EIP-1167 clones of one implementation whose initializer is disabled. After `createCircle`, nobody can change a circle's rules or move its funds outside them.
- **Pull payments.** Settling a round only credits balances. Winners and dividend receivers take their money with `claim()` at any time, and everyone calls `withdraw()` at the end. A member who cannot receive tokens — for example because the stablecoin issuer froze their address, which USDG supports — cannot block settlement for the rest of the circle. This is covered by `test_frozenMemberCannotBlockTheCircle`.
- **Reentrancy.** Every state-changing function that moves tokens is `nonReentrant` and follows checks-effects-interactions.
- **Bounded loops.** Circles have at most 20 members, so the per-member loops in settlement and completion are bounded.
- **Anyone can settle.** A round cannot be held hostage by an inactive creator: after the deadline, any address can call `settleRound()`.
- **Default handling cannot strand funds.** Missed payments are covered from collateral, then from the winner's bond. A member who can no longer be covered is marked defaulted and excluded. If every remaining member defaults, the pot is split so nothing stays locked.

## Evidence

- `forge test`: 45 tests in 4 suites: unit and fuzz tests, 3 invariant tests (256 runs × 60 random calls: join, contribute, bid, settle, claim, withdraw, time jumps), and the review and regression suites in `test/review/`.
  - `invariant_balanceMatchesObligations`: the circle's balance always equals unreturned collateral + bonds + unclaimed payouts + the open round's pot.
  - `invariant_noValueCreated`: tokens are never created or destroyed across members and the circle.
  - `testFuzz_moneyIsConserved`: random full circles with ~20% missed payments and random bids end with the circle holding exactly zero after everyone withdraws.
- Slither 0.11.5 (`--exclude-informational --exclude-optimization`) reports 8 findings, all reviewed:
  - 7 × `timestamp`: rounds are time-based by design. Block-time drift of a few seconds does not matter for deadlines measured in minutes to weeks.
  - 1 × `calls-loop` in `_recordReputation`: the callee is the reputation registry deployed by the factory itself. The loop is bounded by `MAX_SIZE = 20` and runs once per circle.
- Contracts are verified on the Robinhood Chain testnet explorer and, for Monad testnet, on Sourcify (exact match).

## Known limitations

- **Open bids.** Auction bids are public, so a member can see and outbid the current best bid. Sealed commit–reveal bids are on the roadmap.
- **Token assumptions.** Only plain ERC-20s without transfer fees or rebasing are supported. USDG and AUSD meet this. Incoming payments must arrive in full or the call reverts; outgoing fees and later rebases are not handled.
- **Frozen members.** A frozen member keeps a claimable balance that only unfreezing can release. Everyone else is unaffected.
- **Mild reputation weight.** The savings score is a transparent record, not a credit decision. Integrators should read the raw `stats` and weigh them themselves.
- **Collateral reduces risk, it does not remove it.** If a winner stops paying and their collateral and bond run out, the members paid last receive less.
- **Reputation is best effort.** A circle submits each member's record when it completes; a failure inside the registry skips that record and never blocks withdrawals.
- **No external audit.** This is hackathon code without a third-party audit.

## Review, 2026-10-02

An internal review of the contracts at `42c396e` found 1 high, 5 medium and 3 informational issues. All are fixed or documented in the version deployed on Monad testnet; the compiled ABIs did not change.

| Finding | Fix |
|---|---|
| H-01 A reputation counter overflow could revert the final settlement and lock funds | Counters saturate; each record runs in its own `try` with a 250k gas budget, and settling with too little gas to give every record its full budget reverts instead of skipping records |
| M-01 A late settlement opened rounds whose deadline had already passed | Every opened round gets at least a full `roundDuration` window |
| M-02 A winning discount larger than the collected pot was waived | Bids above the collected pot are rejected; settlement caps the discount at the pot |
| M-03 Very large amounts could overflow internal accounting | `initialize` bounds collateral plus lifetime pot credits to `uint128` |
| M-04 Credits assumed exact-transfer tokens | Incoming transfers are checked by balance delta |
| M-05, I-03 Docs overstated what collateral guarantees and the order of coverage | README, NatSpec and test names now match the code |

Regression tests are in `test/review/PotluckFix.t.sol`.
