# Potluck — savings circles onchain

[![ci](https://github.com/luoy16002-svg/potluck/actions/workflows/ci.yml/badge.svg)](https://github.com/luoy16002-svg/potluck/actions/workflows/ci.yml)

Over a billion people save in **rotating savings circles**: *hui* (会) in China, *arisan* in Indonesia, *tanda* in Mexico, *susu* in Ghana, *chit funds* in India, *paluwagan* in the Philippines. A group agrees on an amount, everyone pays in each round, and each round one member takes the whole pot. For people without access to credit, it is how a first motorbike, a shop's stock or school fees get paid for.

It runs on trust, and it fails the same way everywhere: someone takes the pot early and stops paying.

**Potluck puts the circle in a contract**, denominated in a dollar stablecoin, with no operator in the middle. It runs on **Monad** with Agora's **AUSD**, on **Robinhood Chain** (Arbitrum Orbit) with Paxos **USDG**, and on **Arc** with **USDC**:

- **Collateral instead of trust.** Every member locks a small collateral when joining. A missed payment is covered from it automatically, up to the collateral available.
- **A winner's bond.** Whoever takes the pot early has part of it held back (capped at what they still owe) and gets it back at the end. A winner who walks away is covered by their collateral first, then their bond.
- **Auction mode, the way *hui* and chit funds actually work.** Members who need money now bid a discount to take this round's pot; the discount is paid to everyone else. People who can wait earn interest, people who can't pay a fair, market-set price.
- **A portable savings record.** When a circle ends, each member's on-time payments, missed payments and defaults are written to `PotluckReputation`, an open on-chain registry any lender, merchant or new circle can read.
- **No admin keys, pull payments.** There is no owner and no function that moves funds outside the rules. Settlement only credits balances and each member claims their own money, so one frozen or broken address can never lock the circle. Circles are minimal-proxy clones of one implementation.

**Live on Arc mainnet:** https://luoy16002-svg.github.io/potluck/?chain=5042 · [85-second demo video](https://youtu.be/IX9n1fUS7I8) (a real practice circle on Arc Testnet, sped up while it waits for round deadlines)

<p>
  <img src="docs/arc-home.png" width="49%" alt="The home page on Arc mainnet: six members around a pot, one of them takes it each round">
  <img src="docs/arc-practice.png" width="49%" alt="A practice circle on Arc Testnet: the visitor outbids a bot while the circle beside the steps shows who has paid">
</p>
<p>
  <img src="docs/arc-finished-circle.png" width="49%" alt="A finished three-member auction circle with every pot paid out">
  <img src="docs/arc-score.png" width="49%" alt="The savings record written for a member when the circle ended">
</p>

## Try it in three minutes on Monad (for judges)

1. Open **https://luoy16002-svg.github.io/potluck/?chain=10143#/practice** and connect MetaMask or Rabby. The app adds **Monad Testnet** for you. Get test MON from the [Monad faucet](https://faucet.monad.xyz).
2. Click **Get 10,000 test AUSD** (Agora's testnet faucet), then **Fund the bots**: two bot members that live in your browser tab get a little MON for gas and 50 AUSD each. From then on they join, pay, open the bidding and settle rounds on their own.
3. Create the practice circle and play three one-minute rounds: pay each round, outbid the bots to take the pot early, claim your payout, and withdraw your collateral at the end.
4. Open the circle page while it runs: the **Live** feed shows every payment, bid and payout about half a second after it is sent. Your savings score updates on chain under **Savings score**.

Every step is a real transaction on Monad Testnet.

## Try it on Robinhood Chain

1. Open **https://luoy16002-svg.github.io/potluck/#/practice** and connect MetaMask or Rabby. The app adds **Robinhood Chain Testnet** for you. Get test ETH from the [Robinhood Chain faucet](https://faucet.testnet.chain.robinhood.com/).
2. Click **Send gas to the bots**. Two bot members live in your browser tab and join, pay, open the bidding and settle rounds on their own.
3. Create the practice circle, take test USDG from the built-in faucet, join, and play three one-minute rounds. Pay each round, outbid the bots to take the pot early, claim your payout, and withdraw your collateral at the end.
4. Your savings score updates on chain. Look it up under **Savings score**.

Every step is a real transaction on Robinhood Chain Testnet. The finished circles on the home page were run the same way.

## Try it on Arc

1. Open **https://luoy16002-svg.github.io/potluck/?chain=5042002#/practice** and connect MetaMask or Rabby. The app adds **Arc Testnet** for you. Get 20 test USDC from [Circle's faucet](https://faucet.circle.com) (pick Arc Testnet). On Arc that one balance pays the gas too.
2. Click **Fund the bots**: each bot gets 5.10 test USDC in one transfer, enough for its collateral, three rounds and its gas.
3. Create the practice circle (1 USDC a round), play the three one-minute rounds, outbid the bots for a pot, claim it and withdraw at the end. 20 test USDC covers the whole run.

## How it works

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

Collateral and bond reduce but do not remove the risk that a winner stops paying, and the last recipients bear any shortfall.

## Supported tokens

Only plain ERC-20s without transfer fees or rebasing are supported. `join()` and `contribute()` check that the circle's balance increases by exactly the nominal amount and revert with `BadConfig()` otherwise. This incoming check does not make tokens with outgoing fees, later rebases, or dishonest balance reporting compatible.

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

45 tests, including 3 invariant tests and a regression suite for the 2026-10-02 review. The fuzz test (512 runs) plays random circles with random sizes, bond ratios, bids and ~20% missed payments to completion, and asserts that **no token is created or stranded**. The invariant suite fires 15,000+ random calls (join, pay, bid, settle, claim, withdraw, time jumps) and checks after every call that the circle holds exactly what it owes. One test freezes a member's address in a USDG-like token and shows the rest of the circle still settles and pays out. Details, the review findings and the Slither results: [SECURITY.md](SECURITY.md).

Covered: frozen-member isolation, full fixed-order cycle with net-zero outcome, bond cap at remaining obligation, early settlement rules, collateral coverage, default and skip, bond-first coverage for winners who stop paying, auction ordering, discount sharing with rounding dust, bid rules, cancel/refund, config validation, registry access control, and the implementation's disabled initializer.

## On Monad

Monad makes a savings circle feel like a group chat: a payment, a bid or a payout shows up for every member about half a second after it is sent.

- **Agora AUSD.** Circles on Monad are denominated in AUSD, Agora's dollar, using Agora's own testnet token and faucet (`requestFunds`). The practice flow has the visitor hand the bots their AUSD, because the testnet faucet serves one request a minute for everyone.
- **Live circle feed.** Each circle page subscribes to Monad's `monadLogs` stream over WebSocket, which delivers a log as soon as its block is proposed. A bid or payment shows up for every member about half a second after it is sent, marked *proposed*, and turns *finalized* under a second later. An HTTP reader backfills the last 100 blocks (the public RPC limit for `eth_getLogs`) and covers the other chains.
- **Send it on.** After a payout, a member can send part of it straight to another wallet, such as family in another country. Most savings circles span borders: a *tanda* between Los Angeles and Guadalajara, a *hui* between Sydney and Ho Chi Minh City.
- **Gas limits sized for Monad.** Monad charges the gas limit, not the gas used, so the app adds 10% headroom there instead of the 30% it needs on Arbitrum chains.

| Contract (Monad Testnet, chain id 10143) | Address |
|---|---|
| PotluckFactory | [`0xE688A98Ee9d9780E7Bd80FAD3a18630F2edEBDcF`](https://testnet.monadvision.com/address/0xE688A98Ee9d9780E7Bd80FAD3a18630F2edEBDcF) |
| PotluckCircle (implementation) | [`0xa4A4d2938c652010ef054f3670c0Be13Ef071B7d`](https://testnet.monadvision.com/address/0xa4A4d2938c652010ef054f3670c0Be13Ef071B7d) |
| PotluckReputation | [`0x8eb42A9D5881A3f0C8c8104030524a9bd833b9FD`](https://testnet.monadvision.com/address/0x8eb42A9D5881A3f0C8c8104030524a9bd833b9FD) |
| AUSD (Agora testnet token) | [`0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`](https://testnet.monadvision.com/address/0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC) |

Contracts are verified (Sourcify exact match, shown on MonadVision). This deployment runs the reviewed contracts (see [SECURITY.md](SECURITY.md#review-2026-10-02)); the first Monad deployment is archived in `deployments/archive/`. Circles run on it:

- **Studio rent pool**, fixed order, 3 members, completed and recorded in the savings score: [`0xeDE9bE5A1f436bEd5c83D98d3c744630BFEd522d`](https://luoy16002-svg.github.io/potluck/?chain=10143#/c/0xeDE9bE5A1f436bEd5c83D98d3c744630BFEd522d)
- **Friday lunch circle**, auction, 5 members, 100 AUSD a round, two-week rounds: [`0x87cdCE7B0526FD2d4c9B773b6f24D7C84D0e6ADd`](https://luoy16002-svg.github.io/potluck/?chain=10143#/c/0x87cdCE7B0526FD2d4c9B773b6f24D7C84D0e6ADd)

Deploy: `USDG=0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC forge script script/Deploy.s.sol --rpc-url https://testnet-rpc.monad.xyz --broadcast`. The Robinhood Chain deployment below predates the review.

## Deployments on Robinhood Chain

Live on **Robinhood Chain Testnet** (chain id 46630), an Arbitrum Orbit chain. App: https://luoy16002-svg.github.io/potluck/?chain=46630

| Contract | Address |
|---|---|
| PotluckFactory | [`0x1A88423eaE02fE8DF120019D99c859679F20bA0C`](https://explorer.testnet.chain.robinhood.com/address/0x1A88423eaE02fE8DF120019D99c859679F20bA0C) |
| PotluckCircle (implementation) | [`0x88E3827D5049022EEb5E31Dc2E2e54f7015C11d1`](https://explorer.testnet.chain.robinhood.com/address/0x88E3827D5049022EEb5E31Dc2E2e54f7015C11d1) |
| PotluckReputation | [`0x03B0A468460Ea1D21aabEeBc3B1333f86AA3F37C`](https://explorer.testnet.chain.robinhood.com/address/0x03B0A468460Ea1D21aabEeBc3B1333f86AA3F37C) |
| TestUSDG | [`0x7877413D96C2AEa83DeC6A858248d580fDad509C`](https://explorer.testnet.chain.robinhood.com/address/0x7877413D96C2AEa83DeC6A858248d580fDad509C) |

All verified on the explorer. Circles run on this deployment (`script/seed-testnet.sh` + `script/run_circle.py`):

- **Studio rent pool**, fixed order, 3 members, completed and recorded in the savings score: [`0xE0Da5F23FE743c53d2b76Ea663744115dccf01dd`](https://explorer.testnet.chain.robinhood.com/address/0xE0Da5F23FE743c53d2b76Ea663744115dccf01dd)
- **Friday lunch circle**, auction, 5 members, a bid in every round: [`0xFb4B994917167F1bce4B31A5664D5F9AA3cD9E8b`](https://explorer.testnet.chain.robinhood.com/address/0xFb4B994917167F1bce4B31A5664D5F9AA3cD9E8b)

An earlier version that paid winners directly (push payments) is archived in `deployments/archive/`. The current version credits payouts and lets each member claim them. See [SECURITY.md](SECURITY.md) for why.

The same contracts deploy unchanged to Arbitrum One or Arbitrum Sepolia (`forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast`, with `USDG=<address>` to use native USDG).

## On Arc

Arc is Circle's chain with **USDC as the gas token**, which suits a savings circle: members hold one asset and nothing else. Contributions, collateral, payouts and gas all come out of the same USDC balance, so nobody has to buy a volatile token before they can save.

- **One balance.** Circles use USDC through Arc's ERC-20 interface at `0x3600000000000000000000000000000000000000` (6 decimals), which moves the same balance as the native USDC (18 decimals) that pays gas. The app shows one USDC figure, and the practice flow funds each bot with a single USDC transfer that covers both its stake and its gas.
- **Fees too small to matter in a circle.** On Arc Testnet a member's transaction costs about 0.003 USDC; the visitor's twelve transactions in a full practice circle (funding the bots, create, approve, join, three payments, a bid, two claims, the final withdrawal) cost 0.034 USDC together. The whole deployment cost 0.14 USDC.
- **The same reviewed contracts.** No code changes were needed: Potluck's incoming-balance check holds for the system USDC (a transfer of X raises the ERC-20 view by exactly X), and pull payments keep working if Arc's USDC blocklist freezes a member.
- **Fork tests on both Arc networks.** [`test/ArcFork.t.sol`](test/ArcFork.t.sol) runs real circles against the live USDC system contract: fixed and auction circles to completion, a missed payment covered from collateral, and a blocklisted member (Arc Testnet's seeded address) who cannot pay while the other two finish. After every step it checks both views of every balance (6-decimal ERC-20 and 18-decimal native) and that the circle holds exactly what it owes. Arc's USDC is backed by protocol precompiles, so these need [Arc Foundry](https://github.com/circlefin/arc-foundry): `arc-forge test --match-path test/ArcFork.t.sol --fork-url arc_testnet` (6 pass; on `arc_mainnet` 5 pass and the blocklist test is skipped). Plain `forge test` skips them and runs the offline suite.

| Contract (Arc mainnet, chain id 5042) | Address |
|---|---|
| PotluckFactory | [`0x7d20e02E0D57083D81b881FEE928BDa3D27802E6`](https://explorer.arc.io/address/0x7d20e02E0D57083D81b881FEE928BDa3D27802E6) |
| PotluckCircle (implementation) | [`0x8E54bB8AB72f949D55476d2642cDC512D6019C98`](https://explorer.arc.io/address/0x8E54bB8AB72f949D55476d2642cDC512D6019C98) |
| PotluckReputation | [`0x2574ae5D36c4Cb4D6C522ed63D7c76eCa3267a9b`](https://explorer.arc.io/address/0x2574ae5D36c4Cb4D6C522ed63D7c76eCa3267a9b) |
| USDC (Arc system contract) | [`0x3600000000000000000000000000000000000000`](https://explorer.arc.io/address/0x3600000000000000000000000000000000000000) |

Deployed on Arc mainnet on 5 October 2026 in one transaction, [`0x77d0d510…f4fd71330`](https://explorer.arc.io/tx/0x77d0d51051b7c8f108addd992efbdc4ebde01700a4ff9ae17534260f4fd71330) (block 24,337,851), for 0.084 USDC of gas. All three contracts are verified on [Sourcify](https://sourcify.dev/#/lookup/0x7d20e02E0D57083D81b881FEE928BDa3D27802E6) with an exact match. The addresses are the same as on Arc Testnet because the same deployer made the same first transaction on both networks. Mainnet circles hold real USDC, so the app's practice mode stays on Arc Testnet.

| Contract (Arc Testnet, chain id 5042002) | Address |
|---|---|
| PotluckFactory | [`0x7d20e02E0D57083D81b881FEE928BDa3D27802E6`](https://testnet.arcscan.app/address/0x7d20e02E0D57083D81b881FEE928BDa3D27802E6) |
| PotluckCircle (implementation) | [`0x8E54bB8AB72f949D55476d2642cDC512D6019C98`](https://testnet.arcscan.app/address/0x8E54bB8AB72f949D55476d2642cDC512D6019C98) |
| PotluckReputation | [`0x2574ae5D36c4Cb4D6C522ed63D7c76eCa3267a9b`](https://testnet.arcscan.app/address/0x2574ae5D36c4Cb4D6C522ed63D7c76eCa3267a9b) |
| USDC (Arc system contract) | [`0x3600000000000000000000000000000000000000`](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000) |

Verified on Sourcify (exact match). A full practice circle (auction, 3 members, 1 USDC a round) ran to completion on it: [`0x58961Ac01FF484194832059E9e8D8c36667964E7`](https://luoy16002-svg.github.io/potluck/?chain=5042002#/c/0x58961Ac01FF484194832059E9e8D8c36667964E7).

Deploy: `forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast` (or `arc_mainnet`). On both Arc networks the script uses the USDC system contract by default and never deploys a test token.

## Frontend

`web/` is a Vite + React + viem app with no backend: it reads circles straight from the factory and talks to any injected wallet (MetaMask, Rabby). Test AUSD (Monad) or test USDG (Robinhood Chain) can be claimed from the circle page; on Arc Testnet the page links to Circle's faucet. `?chain=10143`, `?chain=46630`, `?chain=5042` (Arc mainnet, real USDC) or `?chain=5042002` (Arc Testnet) picks the network.

```
cd web && npm install && npm run dev
```

For local work: `anvil`, then `forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast` with an Anvil key in `DEPLOYER_KEY`, then `bash script/seed-local.sh` for three demo circles. Opening the app with `?demo=0`…`?demo=4` on the local chain uses Anvil's test accounts instead of a browser wallet.

## Roadmap

- Sealed-bid auctions (commit–reveal) so bids can't be front-run.
- Circles for groups that already exist: invite links, allow-lists, WhatsApp/LINE reminders.
- Collateral that scales down with a member's savings score, so good savers need less capital to join.
- Mainnet launch on Monad with AUSD, and on Arbitrum One and Robinhood Chain with native USDG.
- Payout addresses set at join time, so a member abroad can have every pot sent straight home.

## License

MIT
