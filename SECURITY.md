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

- `forge test`: 15 unit and fuzz tests, plus 3 invariant tests (256 runs × 60 random calls: join, contribute, bid, settle, claim, withdraw, time jumps).
  - `invariant_balanceMatchesObligations`: the circle's balance always equals unreturned collateral + bonds + unclaimed payouts + the open round's pot.
  - `invariant_noValueCreated`: tokens are never created or destroyed across members and the circle.
  - `testFuzz_moneyIsConserved`: random full circles with ~20% missed payments and random bids end with the circle holding exactly zero after everyone withdraws.
- Slither 0.11.5 (`--exclude-informational --exclude-optimization`) reports 8 findings, all reviewed:
  - 7 × `timestamp`: rounds are time-based by design. Block-time drift of a few seconds does not matter for deadlines measured in minutes to weeks.
  - 1 × `calls-loop` in `_recordReputation`: the callee is the reputation registry deployed by the factory itself. The loop is bounded by `MAX_SIZE = 20` and runs once per circle.
- Contracts are verified on the Robinhood Chain testnet explorer.

## Known limitations

- **Open bids.** Auction bids are public, so a member can see and outbid the current best bid. Sealed commit–reveal bids are on the roadmap.
- **Token assumptions.** The circle assumes a standard ERC-20: no fee-on-transfer and no rebasing. USDG meets this. A circle created with a fee-on-transfer token would under-collect.
- **Frozen members.** A frozen member keeps a claimable balance that only unfreezing can release. Everyone else is unaffected.
- **Mild reputation weight.** The savings score is a transparent record, not a credit decision. Integrators should read the raw `stats` and weigh them themselves.
- **No external audit.** This is hackathon code without a third-party audit.
