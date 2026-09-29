# Potluck — savings circles on Arbitrum

Over a billion people save in **rotating savings circles**: *hui* (会) in China, *arisan* in Indonesia, *tanda* in Mexico, *susu* in Ghana, *chit funds* in India, *paluwagan* in the Philippines. A group agrees on an amount, everyone pays in each round, and each round one member takes the whole pot. For people without access to credit, it is how a first motorbike, a shop's stock or school fees get paid for.

It runs on trust, and it fails the same way everywhere: someone takes the pot early and stops paying.

**Potluck puts the circle in a contract** on Arbitrum, denominated in a dollar stablecoin (Paxos **USDG**), with no operator in the middle:

- **Collateral instead of trust.** Every member locks a small collateral when joining. A missed payment is covered from it automatically, so the pot is always whole.
- **A winner's bond.** Whoever takes the pot early has part of it held back (capped at what they still owe) and gets it back at the end. A winner who walks away is covered by their own bond first.
- **Auction mode, the way *hui* and chit funds actually work.** Members who need money now bid a discount to take this round's pot; the discount is paid to everyone else. People who can wait earn interest, people who can't pay a fair, market-set price.
- **A portable savings record.** When a circle ends, each member's on-time payments, missed payments and defaults are written to `PotluckReputation`, an open on-chain registry any lender, merchant or new circle can read.
- **No admin keys.** There is no owner and no function that moves funds outside the rules. Circles are minimal-proxy clones of one audited-by-tests implementation.

## How a circle runs

```
Forming ──(all seats filled)──► Active: round 1 … round N ──► Completed ──► withdraw collateral + bond
   │                               each round:
   │                                 contribute()  – everyone pays `contribution`
   │                                 bid(discount) – auction mode only, members who have not won yet
   │                                 settleRound() – anyone, after the deadline (fixed mode: as soon as all paid)
   │                                     1. missed payments covered from collateral, then bond
   │                                     2. winner = highest bidder, else next in join order
   │                                     3. pot − discount → winner, minus bond held back
   │                                     4. discount split equally among everyone else
   └──(join window expired / creator cancels)──► Cancelled ──► withdraw collateral
```

A member whose collateral and bond can no longer cover a round is marked **defaulted**: they can't win, are excluded from dividends, and the default is recorded on-chain.

## Contracts

| Contract | Role |
|---|---|
| [`PotluckFactory`](src/PotluckFactory.sol) | Deploys circles as EIP-1167 clones, owns the reputation registry, lists circles for the frontend. |
| [`PotluckCircle`](src/PotluckCircle.sol) | One savings circle: joining, contributions, auction bids, settlement, default coverage, withdrawals. |
| [`PotluckReputation`](src/PotluckReputation.sol) | Per-address savings stats written by completed circles; `score()` gives a simple 0–1000 view. |
| [`TestUSDG`](src/mocks/TestUSDG.sol) | 6-decimal USDG stand-in with a public faucet, only for testnets where Paxos has no USDG deployment. |

Any 6-decimal ERC-20 works as the circle's token; on Arbitrum One the frontend defaults to USDG.

### Tests

```
forge test
```

14 tests, including a fuzz test (512 runs per session) that runs random circles — random sizes, bond ratios, bids and ~20% missed payments — to completion and asserts that **no token is created or stranded**: after every member withdraws, the circle holds exactly zero and the members' total equals what they started with.

Covered: full fixed-order cycle with net-zero outcome, bond cap at remaining obligation, early settlement rules, collateral coverage, default and skip, bond-first coverage for winners who stop paying, auction ordering, discount sharing with rounding dust, bid rules, cancel/refund, config validation, registry access control, and the implementation's disabled initializer.

## Deployments

| Network | Factory | Reputation | Token |
|---|---|---|---|
| Arbitrum Sepolia | see [`deployments/421614.json`](deployments/) | | TestUSDG |
| Robinhood Chain Testnet | see [`deployments/46630.json`](deployments/) | | TestUSDG |

## Frontend

`web/` is a Vite + React + viem app with no backend: it reads circles straight from the factory and talks to any injected wallet (MetaMask, Rabby). Test USDG can be claimed from the circle page.

```
cd web && npm install && npm run dev
```

For local work: `anvil`, then `forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast` with an Anvil key in `DEPLOYER_KEY`, then `bash script/seed-local.sh` for three demo circles. Opening the app with `?demo=0`…`?demo=4` on the local chain uses Anvil's test accounts instead of a browser wallet.

## Roadmap

- Sealed-bid auctions (commit–reveal) so bids can't be front-run.
- Circles for groups that already exist: invite links, allow-lists, WhatsApp/LINE reminders.
- Collateral that scales down with a member's savings score, so good savers need less capital to join.
- Mainnet launch on Arbitrum One and Robinhood Chain with native USDG.

## License

MIT
