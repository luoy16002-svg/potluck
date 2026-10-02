import { useCallback, useEffect, useRef, useState } from 'react';
import { createWalletClient, http, maxUint256, type Address, type Chain, type WalletClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PotluckCircleAbi } from './abi/PotluckCircle';
import { PotluckFactoryAbi } from './abi/PotluckFactory';
import { TestUSDGAbi } from './abi/TestUSDG';
import { deployments, gasFor, publicClient } from './chain';
import { net } from './net';
import { readCircle, readWallet, short, usd, type Circle } from './data';

/**
 * Practice circle: the visitor plus two bot members that live in this browser tab.
 * The bots are throwaway wallets (keys kept in localStorage for this chain only), funded with a little
 * test ETH from the visitor. They join, pay every round, open the bidding and settle rounds, so one person
 * can go through a whole auction circle on the real testnet in about three minutes.
 */
const BOT_NAMES = ['Ana', 'Ben'];
const CONTRIBUTION = 10_000_000n; // 10 dollars (6-decimal stablecoin)
/** What a bot needs for a 3-round practice circle: collateral plus three contributions, with room to spare. */
const BOT_STAKE = CONTRIBUTION * 5n;

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

export function Practice({ chain, account, wallet, send, connect }: { chain: Chain; account: Address | null; wallet: WalletClient | null; send: Send; connect: () => void }) {
  const d = deployments[chain.id];
  const N = net(chain.id);
  const sym = N.sym;
  const BOT_GAS = N.botGas;
  const ROUND = N.practiceRound;
  const pc = publicClient(chain);
  const [bots] = useState(() => loadBots(chain.id).map((k) => privateKeyToAccount(k)));
  const botWallets = useRef(bots.map((a) => createWalletClient({ account: a, chain, transport: http(undefined, { retryCount: 5, retryDelay: 800 }) })));
  const [circleAddr, setCircleAddr] = useState<Address | null>(() => (localStorage.getItem(`potluck.practice.${chain.id}`) as Address) || null);
  const [c, setC] = useState<Circle | null>(null);
  const [me, setMe] = useState<{ balance: bigint; allowance: bigint; eth: bigint } | null>(null);
  const [botEth, setBotEth] = useState<bigint[]>([0n, 0n]);
  const [botTok, setBotTok] = useState<bigint[]>([0n, 0n]);
  const [log, setLog] = useState<Log[]>([]);
  const [bid, setBid] = useState('2');
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
  }, [account, bots, chain, circleAddr, d.usdg, pc]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), Math.min(4000, N.pollMs * 2));
    return () => clearInterval(t);
  }, [refresh]);

  /** A bot action: send once, wait, log. Each action has a key so it is never sent twice; failures unlock it
   * again after a few seconds (the public RPC sometimes drops a request). Returns true once the action is done. */
  const sent = useRef(new Set<string>());
  const done = useRef(new Set<string>());
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
        const why = ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).split('\n')[0];
        say(`Bot ${BOT_NAMES[i]}`, `could not ${todo} (${why}); retrying`);
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
              !(await bot(i, `${c.address}:${i}:faucet`, `took test ${sym} from the faucet`, 'use the faucet', N.stableFaucet(d.usdg, bots[i].address)))) return;
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
          await bot(opener, `${c.address}:${c.currentRound}:bid`, `bid 1.00 ${sym} for round ${c.currentRound}'s pot`, 'bid', { address: c.address, abi: PotluckCircleAbi, functionName: 'bid', args: [1_000_000n] });
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
      for (let i = 0; i < 2; i++) {
        if (botEth[i] >= (circleAddr ? BOT_GAS / 10n : BOT_GAS / 2n)) continue;
        const gas = ((await pc.estimateGas({ account: from, to: bots[i].address, value: BOT_GAS })) * 13n) / 10n;
        const hash = await wallet.sendTransaction({ account: from, chain, to: bots[i].address, value: BOT_GAS, gas } as never);
        const rc = await pc.waitForTransactionReceipt({ hash });
        if (rc.status !== 'success') throw new Error('transaction reverted');
        say('You', `sent gas to Bot ${BOT_NAMES[i]}`);
      }
      for (let i = 0; N.visitorFundsBots && i < 2; i++) {
        if (botTok[i] >= BOT_STAKE || circleAddr) continue;
        const req = { address: d.usdg, abi: TestUSDGAbi, functionName: 'transfer', args: [bots[i].address, BOT_STAKE] };
        const gas = await gasFor(chain, req, from);
        const hash = await wallet.writeContract({ ...req, account: from, chain, gas } as never);
        const rc = await pc.waitForTransactionReceipt({ hash });
        if (rc.status !== 'success') throw new Error('transaction reverted');
        say('You', `sent ${usd(BOT_STAKE, 0)} ${sym} to Bot ${BOT_NAMES[i]}`);
      }
    } catch (e) {
      const err = e as { shortMessage?: string; details?: string; message?: string };
      const why = /insufficient (balance|funds)/i.test(`${err.details} ${err.message}`) ? `not enough test ${N.gasSym} or ${sym} in your wallet` : err.shortMessage ?? err.message;
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
      say('You', `created a 3-member auction circle: 10 ${sym} a round, ${ROUND}-second rounds`);
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
  const visitorShort = N.visitorFundsBots && !!me && me.balance < BOT_STAKE * 3n;
  const needUsdg = !!me && me.balance < CONTRIBUTION * 5n;
  const needApproval = !!me && !!circleAddr && me.allowance < CONTRIBUTION * 4n;
  const left = c ? c.deadline - (now + c.clockSkew) : 0;
  const call = (label: string, functionName: string, args: unknown[] = []) => send(label, { address: circleAddr!, abi: PotluckCircleAbi, functionName, args });
  const step = !account ? 0 : !botsFunded ? 1 : !circleAddr || !c ? 2 : c.phase === 0 ? 3 : c.phase === 1 ? 4 : 5;

  return (
    <main className="page practice">
      <p className="eyebrow">Try it alone · live on {chain.name}</p>
      <h1>{ROUND <= 40 ? 'A whole circle in two minutes.' : 'A whole circle in three minutes.'}</h1>
      <p className="lede">
        You and two bot members who live in this browser tab. They join, pay every round, open the bidding and settle rounds on their own.
        You pay, try to outbid them for the pot, claim what you win, and take your collateral back at the end. Every step is a real transaction on {chain.name}.
      </p>

      <ol className="steps-list">
        <li className={step > 0 ? 'done' : step === 0 ? 'now' : ''}>
          <b>Connect a wallet</b> with a little test {N.gasSym} for gas.{' '}
          {N.gasFaucet && <a href={N.gasFaucet} target="_blank" rel="noreferrer">Get test {N.gasSym}</a>}
          {!account && <button className="btn" onClick={connect}>Connect wallet</button>}
          {account && me && me.eth === 0n && <span className="bad"> Your wallet has no test {N.gasSym} on this network yet.</span>}
        </li>
        <li className={step > 1 ? 'done' : step === 1 ? 'now' : ''}>
          {N.visitorFundsBots
            ? <><b>Fund the bots.</b> Send {BOT_NAMES.join(' and ')} {Number(BOT_GAS) / 1e18} test {N.gasSym} for gas and {usd(BOT_STAKE, 0)} test {sym} each.</>
            : <><b>Give the bots gas.</b> Two small transfers of {Number(BOT_GAS) / 1e18} test {N.gasSym} to {BOT_NAMES.join(' and ')}.</>}
          <span className="muted small"> ({bots.map((b) => short(b.address)).join(', ')})</span>
          {step === 1 && visitorShort && <button className="btn ghost" onClick={() => send(N.stableFaucetLabel, N.stableFaucet(d.usdg, account!))}>{N.stableFaucetLabel}</button>}
          {step === 1 && <button className="btn" disabled={busy || visitorShort} onClick={fundBots}>{N.visitorFundsBots ? 'Fund the bots' : 'Send gas to the bots'}</button>}
        </li>
        <li className={step > 2 ? 'done' : step === 2 ? 'now' : ''}>
          <b>Create the practice circle</b>: 3 members, 10 {sym} a round, auction mode, {ROUND}-second rounds.
          {step === 2 && !circleAddr && <button className="btn" disabled={busy} onClick={createCircle}>Create practice circle</button>}
          {step === 2 && circleAddr && <span className="muted small"> Loading the circle…</span>}
        </li>
        <li className={step > 3 ? 'done' : step === 3 ? 'now' : ''}>
          <b>Join</b> by locking 10 {sym} collateral. The bots join on their own.
          {step >= 3 && needUsdg && <button className="btn ghost" onClick={() => send(N.stableFaucetLabel, N.stableFaucet(d.usdg, account!))}>Get test {sym}</button>}
          {step === 3 && !mine && (needApproval
            ? <button className="btn" onClick={() => send(`Approve ${sym}`, { address: d.usdg, abi: TestUSDGAbi, functionName: 'approve', args: [circleAddr, maxUint256] })}>Approve {sym}</button>
            : <button className="btn" onClick={() => call('Join circle', 'join')}>Join</button>)}
        </li>
        <li className={step > 4 ? 'done' : step === 4 ? 'now' : ''}>
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
                : <button className="btn" onClick={() => call(`Pay round ${c.currentRound}`, 'contribute')}>Pay 10 {sym}</button>)}
              {mine.paidThisRound && <span className="ok">✓ paid</span>}
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
        <li className={step === 5 ? 'now' : ''}>
          <b>Take your collateral and bond back</b>, then see the record written to your savings score.
          {step === 5 && mine && mine.collateralLeft + mine.bond + mine.claimable > 0n && (
            <button className="btn" onClick={() => call('Withdraw', 'withdraw')}>Withdraw {usd(mine.collateralLeft + mine.bond + mine.claimable)} {sym}</button>
          )}
          {step === 5 && account && <a className="btn ghost" href={`#/score/${account}`}>See your savings score</a>}
        </li>
      </ol>

      {c && (
        <p className="small">
          Circle <a href={`#/c/${c.address}`}>{short(c.address)}</a> · {c.results.length} of 3 rounds paid out
          {c.results.map((r) => ` · R${r.round}: ${r.winner.toLowerCase() === account?.toLowerCase() ? 'you' : 'a bot'} got ${usd(r.payout)}${r.discount ? ` (bid ${usd(r.discount)})` : ''}`)}
          {' · '}<a href="#/practice" onClick={reset}>start over</a>
        </p>
      )}

      {log.length > 0 && (
        <div className="log">
          {log.map((l) => (
            <div key={l.t + l.text}><span className="muted">{new Date(l.t).toLocaleTimeString()}</span> <b>{l.who}</b> {l.text}</div>
          ))}
        </div>
      )}
    </main>
  );
}
