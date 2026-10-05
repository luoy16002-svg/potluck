import { useCallback, useEffect, useRef, useState } from 'react';
import { createWalletClient, maxUint256, type Address, type Chain, type WalletClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PotluckCircleAbi } from './abi/PotluckCircle';
import { PotluckFactoryAbi } from './abi/PotluckFactory';
import { TestUSDGAbi } from './abi/TestUSDG';
import { chainById, deployments, gasFor, isNetworkHiccup, publicClient, sendTransport } from './chain';
import { net } from './net';
import { PHASES, readCircle, readWallet, short, usd, type Circle } from './data';
import { ArrowRight, ArrowUpRight, Check, CheckCircle, Wallet } from '@phosphor-icons/react';
import { Showcase } from './ui/Showcase';
import { Guard } from './ui/Guard';
import { BigRing } from './ui/BigRing';
import { chainName } from './ui/labels';

/**
 * Practice circle: the visitor plus two bot members that live in this browser tab.
 * The bots are throwaway wallets (keys kept in localStorage for this chain only), funded with a little
 * test ETH from the visitor. They join, pay every round, open the bidding and settle rounds, so one person
 * can go through a whole auction circle on the real testnet in about three minutes.
 */
const BOT_NAMES = ['Ana', 'Ben'];

type Send = (label: string, req: { address: Address; abi: readonly unknown[]; functionName: string; args?: unknown[] }) => Promise<boolean>;
type Log = { t: number; who: string; text: string };

function loadBots(chainId: number): `0x${string}`[] {
  try {
    const k = JSON.parse(localStorage.getItem(`potluck.bots.${chainId}`) || '[]');
    if (Array.isArray(k) && k.length === 2) return k;
  } catch {
    /* ignore */
  }
  const keys = [generatePrivateKey(), generatePrivateKey()];
  try {
    localStorage.setItem(`potluck.bots.${chainId}`, JSON.stringify(keys));
  } catch {
    /* ignore */
  }
  return keys;
}

type Props = { chain: Chain; account: Address | null; wallet: WalletClient | null; send: Send; connect: () => void };

export function Practice(props: Props) {
  const N = net(props.chain.id);
  return N.mainnet ? <PracticeOnTestnet chain={props.chain} /> : <PracticeCircle {...props} />;
}

/** On a mainnet every circle uses real money, so practice (with throwaway bot wallets) stays on the test network. */
function PracticeOnTestnet({ chain }: { chain: Chain }) {
  const N = net(chain.id);
  const t = N.practiceChain;
  const target = t && deployments[t] ? chainById(t) : null;
  return (
    <main className="page practice">
      <div className="practice-split">
        <div>
          <p className="eyebrow">Try it alone</p>
          <h1>Practice runs on {target ? target.name : 'a test network'}.</h1>
          <p className="lede">
            Circles on {chainName(chain)} mainnet hold real {N.sym}. The practice bots live in your browser tab with throwaway keys, so they stay on
            the test network, where the same contracts run with free test {N.sym} from Circle's faucet.
          </p>
          <p className="lede">
            In about three minutes you create a three-member auction circle, two bots join it, and you play every round: pay in, outbid the bots
            for the pot, claim what you win and take your collateral back.
          </p>
          {target && (
            <a className="btn big" href={`?chain=${target.id}#/practice`}>
              Open practice on {target.name} <ArrowRight size={18} weight="bold" aria-hidden />
            </a>
          )}
        </div>
        {N.showcase && (
          <Guard>
            <Showcase chainId={N.showcase.chainId} circle={N.showcase.circle} />
          </Guard>
        )}
      </div>
    </main>
  );
}

function PracticeCircle({ chain, account, wallet, send, connect }: Props) {
  const d = deployments[chain.id];
  const N = net(chain.id);
  const sym = N.sym;
  const CONTRIBUTION = N.practiceContribution ?? 10_000_000n; // 6-decimal stablecoin
  /** What a bot needs for a 3-round practice circle: collateral plus three contributions, with room to spare. */
  const BOT_STAKE = CONTRIBUTION * 5n;
  const BOT_GAS = N.botGas;
  /** On Arc one USDC transfer gives a bot its stake and its gas (native USDC has 18 decimals, the ERC-20 view 6). */
  const BOT_FUNDS = N.gasIsStable ? BOT_STAKE + BOT_GAS / 10n ** 12n : BOT_STAKE;
  const ROUND = N.practiceRound;
  const pc = publicClient(chain);
  const [bots] = useState(() => loadBots(chain.id).map((k) => privateKeyToAccount(k)));
  const botWallets = useRef(bots.map((a) => createWalletClient({ account: a, chain, transport: sendTransport(chain) })));
  const [circleAddr, setCircleAddr] = useState<Address | null>(() => (localStorage.getItem(`potluck.practice.${chain.id}`) as Address) || null);
  const [c, setC] = useState<Circle | null>(null);
  const [me, setMe] = useState<{ balance: bigint; allowance: bigint; eth: bigint } | null>(null);
  const [botEth, setBotEth] = useState<bigint[]>([0n, 0n]);
  const [botTok, setBotTok] = useState<bigint[]>([0n, 0n]);
  const [log, setLog] = useState<Log[]>([]);
  const [bid, setBid] = useState(() => String(Number(CONTRIBUTION) / 5e6));
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const say = (who: string, text: string) => setLog((l) => [{ t: Date.now(), who, text }, ...l].slice(0, 40));

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const refresh = useCallback(async () => {
    setBotEth(await Promise.all(bots.map((b) => pc.getBalance({ address: b.address }))));
    if (N.visitorFundsBots) setBotTok(await Promise.all(bots.map(async (b) => (await readWallet(chain, d.usdg, b.address)).balance)));
    if (account) setMe(await readWallet(chain, d.usdg, account, circleAddr ?? undefined));
    if (circleAddr) setC(await readCircle(chain, circleAddr));
  }, [account, bots, chain, circleAddr, d.usdg, pc, N.visitorFundsBots]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), Math.min(4000, N.pollMs * 2));
    return () => clearInterval(t);
  }, [refresh, N.pollMs]);

  /** A bot action: send once, wait, log. Each action has a key so it is never sent twice; failures unlock it
   * again after a few seconds (the public RPC sometimes drops a request). Returns true once the action is done. */
  const sent = useRef(new Set<string>());
  const done = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const bot = useCallback(
    async (i: number, key: string, did: string, todo: string, req: { address: Address; abi: readonly unknown[]; functionName: string; args?: unknown[] }) => {
      if (done.current.has(key)) return true;
      if (sent.current.has(key)) return false;
      sent.current.add(key);
      try {
        const gas = await gasFor(chain, req, bots[i]);
        const hash = await botWallets.current[i].writeContract({ ...req, account: bots[i], chain, gas } as never);
        const rc = await pc.waitForTransactionReceipt({ hash });
        if (rc.status !== 'success') throw new Error('transaction reverted');
        done.current.add(key);
        say(`Bot ${BOT_NAMES[i]}`, did);
        return true;
      } catch (e) {
        // One line per stuck action; the quiet retries that follow usually succeed within seconds.
        if (!failed.current.has(key)) {
          failed.current.add(key);
          const msg = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? '';
          const why = isNetworkHiccup(e) ? 'the network was busy' : /revert/i.test(msg) ? 'the transaction was reverted' : msg.split('\n')[0];
          say(`Bot ${BOT_NAMES[i]}`, `could not ${todo} yet (${why}), trying again`);
        }
        setTimeout(() => sent.current.delete(key), 6000);
        return false;
      }
    },
    [bots, chain, pc],
  );

  // The bots' autopilot: join, pay, open the bidding, settle, withdraw.
  useEffect(() => {
    if (!c || acting.current) return;
    const skew = c.clockSkew;
    const chainNow = now + skew;
    const run = async () => {
      acting.current = true;
      const before = sent.current.size;
      try {
        for (let i = 0; i < 2; i++) {
          const a = bots[i].address.toLowerCase();
          const m = c.members.find((x) => x.address.toLowerCase() === a);
          if (c.phase === 0 && !m && botEth[i] > 0n) {
            const bal = (await readWallet(chain, d.usdg, bots[i].address, c.address)).balance;
            if (bal < c.config.collateral + c.config.contribution * BigInt(c.config.size) &&
              (!N.stableFaucet || !(await bot(i, `${c.address}:${i}:faucet`, `took test ${sym} from the faucet`, 'use the faucet', N.stableFaucet(d.usdg, bots[i].address))))) return;
            if (!(await bot(i, `${c.address}:${i}:approve`, `approved the circle to take ${sym}`, `approve ${sym}`, { address: d.usdg, abi: TestUSDGAbi, functionName: 'approve', args: [c.address, maxUint256] }))) return;
            await bot(i, `${c.address}:${i}:join`, `joined and locked ${usd(c.config.collateral)} ${sym} collateral`, 'join', { address: c.address, abi: PotluckCircleAbi, functionName: 'join' });
            return;
          }
          if (c.phase === 1 && m && !m.paidThisRound && !m.defaulted) {
            await bot(i, `${c.address}:${c.currentRound}:${i}:pay`, `paid round ${c.currentRound}: ${usd(c.config.contribution)} ${sym}`, `pay round ${c.currentRound}`, { address: c.address, abi: PotluckCircleAbi, functionName: 'contribute' });
            return;
          }
          if (c.phase === 1 && m && m.claimable > 0n) {
            await bot(i, `${c.address}:${c.currentRound}:${i}:claim`, `claimed ${usd(m.claimable)} ${sym}`, 'claim', { address: c.address, abi: PotluckCircleAbi, functionName: 'claim' });
            return;
          }
          if (c.phase === 2 && m && m.collateralLeft + m.bond + m.claimable > 0n) {
            await bot(i, `${c.address}:${i}:withdraw`, `withdrew ${usd(m.collateralLeft + m.bond + m.claimable)} ${sym}`, 'withdraw', { address: c.address, abi: PotluckCircleAbi, functionName: 'withdraw' });
            return;
          }
        }
        if (c.phase !== 1) return;
        // Open the bidding with a small bid, so there is something to beat.
        const opener = [0, 1].find((i) => {
          const m = c.members.find((x) => x.address.toLowerCase() === bots[i].address.toLowerCase());
          return m && !m.won && !m.defaulted && m.paidThisRound;
        });
        const eligible = c.members.filter((m) => !m.won && !m.defaulted).length;
        if (!c.topBidder && opener !== undefined && eligible > 1 && c.deadline - chainNow > 12) {
          await bot(opener, `${c.address}:${c.currentRound}:bid`, `bid ${usd(CONTRIBUTION / 10n)} ${sym} for round ${c.currentRound}'s pot`, 'bid', { address: c.address, abi: PotluckCircleAbi, functionName: 'bid', args: [CONTRIBUTION / 10n] });
          return;
        }
        if (chainNow > c.deadline + 2) {
          await bot(0, `${c.address}:${c.currentRound}:settle`, `settled round ${c.currentRound}`, `settle round ${c.currentRound}`, { address: c.address, abi: PotluckCircleAbi, functionName: 'settleRound' });
        }
      } finally {
        acting.current = false;
        // Only re-read the chain when a bot actually sent something; the 4-second poll covers the rest.
        if (sent.current.size !== before) void refresh();
      }
    };
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, now]);

  async function fundBots() {
    if (!wallet || !account) return connect();
    setBusy(true);
    try {
      const from = wallet.account ?? account;
      for (let i = 0; !N.gasIsStable && i < 2; i++) {
        if (botEth[i] >= (circleAddr ? BOT_GAS / 10n : BOT_GAS / 2n)) continue;
        const gas = ((await pc.estimateGas({ account: from, to: bots[i].address, value: BOT_GAS })) * 13n) / 10n;
        const hash = await wallet.sendTransaction({ account: from, chain, to: bots[i].address, value: BOT_GAS, gas } as never);
        const rc = await pc.waitForTransactionReceipt({ hash });
        if (rc.status !== 'success') throw new Error('transaction reverted');
        say('You', `sent gas to Bot ${BOT_NAMES[i]}`);
      }
      for (let i = 0; N.visitorFundsBots && i < 2; i++) {
        if (botTok[i] >= BOT_STAKE || circleAddr) continue;
        const req = { address: d.usdg, abi: TestUSDGAbi, functionName: 'transfer', args: [bots[i].address, BOT_FUNDS] };
        const gas = await gasFor(chain, req, from);
        const hash = await wallet.writeContract({ ...req, account: from, chain, gas } as never);
        const rc = await pc.waitForTransactionReceipt({ hash });
        if (rc.status !== 'success') throw new Error('transaction reverted');
        say('You', `sent ${usd(BOT_FUNDS)} ${sym} to Bot ${BOT_NAMES[i]}`);
      }
    } catch (e) {
      const err = e as { shortMessage?: string; details?: string; message?: string };
      const why = /insufficient (balance|funds)/i.test(`${err.details} ${err.message}`)
        ? `not enough test ${N.gasSym} or ${sym} in your wallet`
        : isNetworkHiccup(e)
          ? 'the network did not take the transaction; press the button again'
          : (err.shortMessage ?? err.message ?? '').split('\n')[0];
      say('You', `funding failed: ${why}`);
    } finally {
      // Refresh first, so the button cannot be pressed again while the old balances are still shown.
      await refresh().catch(() => undefined);
      setBusy(false);
    }
  }

  async function createCircle() {
    setBusy(true);
    const cfg = { token: d.usdg, contribution: CONTRIBUTION, collateral: CONTRIBUTION, size: 3, roundDuration: ROUND, joinWindow: 3600, bondBps: 2000, maxDiscountBps: 1000, mode: 1 };
    const ok = await send('Create practice circle', { address: d.factory, abi: PotluckFactoryAbi, functionName: 'createCircle', args: ['Practice circle', cfg] });
    if (ok && account) {
      // This visitor's newest circle (the factory's global newest could be someone else's practice circle).
      const created = (await pc.readContract({ address: d.factory, abi: PotluckFactoryAbi, functionName: 'circlesCreatedBy', args: [account] })) as Address[];
      const latest = created[created.length - 1];
      setCircleAddr(latest);
      try {
        localStorage.setItem(`potluck.practice.${chain.id}`, latest);
      } catch {
        /* ignore */
      }
      say('You', `created a 3-member auction circle: ${usd(CONTRIBUTION, 0)} ${sym} a round, ${ROUND}-second rounds`);
      // Load it before unlocking the page, so the create button cannot be pressed twice.
      setC(await readCircle(chain, latest).catch(() => null));
    }
    setBusy(false);
  }

  const reset = () => {
    setCircleAddr(null);
    setC(null);
    setLog([]);
    try {
      localStorage.removeItem(`potluck.practice.${chain.id}`);
    } catch {
      /* ignore */
    }
  };

  const mine = c?.members.find((m) => account && m.address.toLowerCase() === account.toLowerCase());
  // Before the circle exists the bots need their full allowance; afterwards they spend it, so only an almost empty
  // gas balance brings the funding step back.
  const botsFunded = circleAddr
    ? botEth.every((b) => b >= BOT_GAS / 10n)
    : botEth.every((b) => b >= BOT_GAS / 2n) && (!N.visitorFundsBots || botTok.every((t) => t >= BOT_STAKE));
  // Short means: less than the bots still waiting for funds, plus the visitor's own collateral and contributions. Counting
  // only unfunded bots keeps the faucet link from flashing up halfway through funding.
  const unfundedBots = N.visitorFundsBots ? botTok.filter((t) => t < BOT_STAKE).length : 0;
  const visitorShort = N.visitorFundsBots && !busy && !!me && me.balance < BigInt(unfundedBots) * BOT_FUNDS + CONTRIBUTION * 5n;
  const needUsdg = !!me && me.balance < CONTRIBUTION * 5n;
  const needApproval = !!me && !!circleAddr && me.allowance < CONTRIBUTION * 4n;
  const left = c ? c.deadline - (now + c.clockSkew) : 0;
  const call = (label: string, functionName: string, args: unknown[] = []) => send(label, { address: circleAddr!, abi: PotluckCircleAbi, functionName, args });
  const step = !account ? 0 : !botsFunded ? 1 : !circleAddr || !c ? 2 : c.phase === 0 ? 3 : c.phase === 1 ? 4 : 5;
  const faucet = (label: string) =>
    N.stableFaucet
      ? <button className="btn ghost" onClick={() => send(label, N.stableFaucet!(d.usdg, account!))}>{label}</button>
      : N.stableFaucetUrl
        ? <a className="btn ghost" href={N.stableFaucetUrl} target="_blank" rel="noreferrer">{label}</a>
        : null;

  return (
    <main className="page practice">
      <p className="eyebrow">Try it alone · live on {chain.name}</p>
      <h1>{ROUND <= 40 ? 'A whole circle in two minutes.' : 'A whole circle in three minutes.'}</h1>
      <p className="lede">
        You and two bot members who live in this browser tab. They join, pay every round, open the bidding and settle rounds on their own.
        You pay, try to outbid them for the pot, claim what you win, and take your collateral back at the end. Every step is a real transaction on {chain.name}.
      </p>

      <div className="practice-grid">
      <div className="pg-steps">
      <ol className="steps-list">
        <li className={step > 0 ? 'done' : step === 0 ? 'now' : ''}>
          <StepMark n={1} done={step > 0} />
          <b>Connect a wallet</b> with a little test {N.gasSym} for gas.{' '}
          {N.gasFaucet && (
            <a className="inline-link" href={N.gasFaucet} target="_blank" rel="noreferrer">
              Get test {N.gasSym} <ArrowUpRight size={12} weight="bold" aria-hidden />
            </a>
          )}
          {account && me && me.eth === 0n && <span className="bad"> Your wallet has no test {N.gasSym} on this network yet.</span>}
          {!account && (
            <div className="step-actions">
              <button className="btn" onClick={connect}><Wallet size={17} weight="bold" aria-hidden /> Connect wallet</button>
            </div>
          )}
        </li>
        <li className={step > 1 ? 'done' : step === 1 ? 'now' : ''}>
          <StepMark n={2} done={step > 1} />
          {N.gasIsStable
            ? <><b>Fund the bots.</b> Send {BOT_NAMES.join(' and ')} {usd(BOT_FUNDS)} test {sym} each. On {chain.name} the same {sym} pays their gas.</>
            : N.visitorFundsBots
              ? <><b>Fund the bots.</b> Send {BOT_NAMES.join(' and ')} {Number(BOT_GAS) / 1e18} test {N.gasSym} for gas and {usd(BOT_STAKE, 0)} test {sym} each.</>
              : <><b>Give the bots gas.</b> Two small transfers of {Number(BOT_GAS) / 1e18} test {N.gasSym} to {BOT_NAMES.join(' and ')}.</>}
          <span className="muted small"> ({bots.map((b) => short(b.address)).join(', ')})</span>
          {step === 1 && (
            <div className="step-actions">
              {visitorShort && faucet(N.stableFaucetLabel ?? `Get test ${sym}`)}
              <button className="btn" disabled={busy || visitorShort} onClick={fundBots}>{N.visitorFundsBots ? 'Fund the bots' : 'Send gas to the bots'}</button>
            </div>
          )}
        </li>
        <li className={step > 2 ? 'done' : step === 2 ? 'now' : ''}>
          <StepMark n={3} done={step > 2} />
          <b>Create the practice circle</b>: 3 members, {usd(CONTRIBUTION, 0)} {sym} a round, auction mode, {ROUND}-second rounds.
          {step === 2 && !circleAddr && (
            <div className="step-actions">
              <button className="btn" disabled={busy} onClick={createCircle}>Create practice circle</button>
            </div>
          )}
          {step === 2 && circleAddr && <span className="muted small"> Loading the circle…</span>}
        </li>
        <li className={step > 3 ? 'done' : step === 3 ? 'now' : ''}>
          <StepMark n={4} done={step > 3} />
          <b>Join</b> by locking {usd(CONTRIBUTION, 0)} {sym} collateral. The bots join on their own.
          {((step >= 3 && needUsdg) || (step === 3 && !mine)) && (
            <div className="step-actions">
              {step >= 3 && needUsdg && faucet(`Get test ${sym}`)}
              {step === 3 && !mine && (needApproval
                ? <button className="btn" onClick={() => send(`Approve ${sym}`, { address: d.usdg, abi: TestUSDGAbi, functionName: 'approve', args: [circleAddr, maxUint256] })}>Approve {sym}</button>
                : <button className="btn" onClick={() => call('Join circle', 'join')}>Join</button>)}
            </div>
          )}
        </li>
        <li className={step > 4 ? 'done' : step === 4 ? 'now' : ''}>
          <StepMark n={5} done={step > 4} />
          <b>Play the rounds.</b> Pay each round; while it is open, beat the bots' bid to take the pot early.
          {step === 4 && c && mine && (
            <div className="round-box">
              <div className="round-head">
                <span>Round {c.currentRound} of 3</span>
                <span>{left > 0 ? `closes in ${left}s` : 'closing…'}</span>
                <span>pot {usd(c.collected, 0)} / {usd(c.config.contribution * 3n, 0)}</span>
              </div>
              {!mine.paidThisRound && !mine.defaulted && (needApproval
                ? <button className="btn" onClick={() => send(`Approve ${sym}`, { address: d.usdg, abi: TestUSDGAbi, functionName: 'approve', args: [circleAddr, maxUint256] })}>Approve {sym}</button>
                : <button className="btn" onClick={() => call(`Pay round ${c.currentRound}`, 'contribute')}>Pay {usd(CONTRIBUTION, 0)} {sym}</button>)}
              {mine.paidThisRound && <span className="ok"><CheckCircle size={17} weight="fill" aria-hidden /> Paid this round</span>}
              {mine.claimable > 0n && (
                <button className="btn" onClick={() => call('Claim payout', 'claim')}>Claim {usd(mine.claimable)} {sym}</button>
              )}
              {mine.won ? (
                <p className="small">You took the pot in round {mine.wonRound}. Keep paying: your bond is released at the end.</p>
              ) : (
                mine.paidThisRound && left > 3 && (
                  <div className="row">
                    <input value={bid} onChange={(e) => setBid(e.target.value)} inputMode="decimal" />
                    <button className="btn" onClick={() => call('Place bid', 'bid', [BigInt(Math.round(Number(bid) * 1e6))])}>Bid {sym}</button>
                    <span className="small muted">best: {c.topBidder ? `${usd(c.topDiscount)} by ${c.topBidder.toLowerCase() === account?.toLowerCase() ? 'you' : 'a bot'}` : 'none yet'} · max {usd(c.maxDiscount)}</span>
                  </div>
                )
              )}
            </div>
          )}
        </li>
        <li className={step === 5 && mine && mine.collateralLeft + mine.bond + mine.claimable === 0n ? 'done' : step === 5 ? 'now' : ''}>
          <StepMark n={6} done={step === 5 && !!mine && mine.collateralLeft + mine.bond + mine.claimable === 0n} />
          <b>Take your collateral and bond back</b>, then see the record written to your savings score.
          {step === 5 && mine && mine.collateralLeft + mine.bond + mine.claimable === 0n && (
            <p className="ok"><CheckCircle size={17} weight="fill" aria-hidden /> All settled: your collateral and bond are back in your wallet.</p>
          )}
          {step === 5 && account && (
            <div className="step-actions">
              {mine && mine.collateralLeft + mine.bond + mine.claimable > 0n && (
                <button className="btn" onClick={() => call('Withdraw', 'withdraw')}>Withdraw {usd(mine.collateralLeft + mine.bond + mine.claimable)} {sym}</button>
              )}
              <a className="btn ghost" href={`#/score/${account}`}>See your savings score</a>
            </div>
          )}
        </li>
      </ol>

      {c && (
        <p className="small pg-summary">
          Circle <a href={`#/c/${c.address}`}>{short(c.address)}</a> · {c.results.length} of 3 rounds paid out
          {c.results.map((r) => ` · R${r.round}: ${r.winner.toLowerCase() === account?.toLowerCase() ? 'you' : 'a bot'} got ${usd(r.payout)}${r.discount ? ` (bid ${usd(r.discount)})` : ''}`)}
          {' · '}<a href="#/practice" onClick={reset}>start over</a>
        </p>
      )}

      </div>

      <aside className="pg-side" aria-label="Your practice circle">
        <div className="side-card">
          <div className="side-head">
            <h3>Your practice circle</h3>
            <span className={`pill ${c ? `p${c.phase}` : 'p0'}`}>
              {c?.phase === 2 && <CheckCircle size={13} weight="fill" aria-hidden />} {c ? PHASES[c.phase] : 'Not created'}
            </span>
          </div>
          <Guard>
            <BigRing
              c={c}
              account={account}
              sym={sym}
              names={Object.fromEntries(bots.map((b, i) => [b.address.toLowerCase(), BOT_NAMES[i]]))}
              preview={{ size: 3, seats: [account, bots[0].address, bots[1].address], pot: CONTRIBUTION * 3n }}
            />
          </Guard>
          <p className="side-status">
            {!c && <>You, {BOT_NAMES.join(' and ')}: three seats, {usd(CONTRIBUTION, 0)} {sym} each round.</>}
            {c?.phase === 0 && <>{c.members.length} of 3 seats taken. The circle starts when the last seat fills.</>}
            {c?.phase === 1 && (
              <>
                Round {c.currentRound} of 3 · {left > 0 ? `closes in ${left}s` : 'closing'} · {c.members.filter((m) => m.paidThisRound).length} of 3 paid
                {c.topBidder && <> · best bid {usd(c.topDiscount)} by {c.topBidder.toLowerCase() === account?.toLowerCase() ? 'you' : BOT_NAMES[bots.findIndex((b) => b.address.toLowerCase() === c.topBidder!.toLowerCase())] ?? 'a bot'}</>}
              </>
            )}
            {c && c.phase >= 2 && <>{c.results.length} of 3 pots paid out.</>}
          </p>
          {c && (
            <ul className="legend" aria-label="Legend">
              {c.phase === 1 && <li><i className="lg-paid" /> Paid this round</li>}
              <li><i className="lg-won" /> Took the pot</li>
            </ul>
          )}
        </div>
      </aside>

      {log.length > 0 && (
        <div className="log pg-log">
          {log.map((l) => (
            <div key={l.t + l.text}><span className="muted">{new Date(l.t).toLocaleTimeString()}</span> <b>{l.who}</b> {l.text}</div>
          ))}
        </div>
      )}
      </div>
    </main>
  );
}


function StepMark({ n, done }: { n: number; done: boolean }) {
  return <span className="step-n" aria-hidden>{done ? <Check size={15} weight="bold" /> : n}</span>;
}
