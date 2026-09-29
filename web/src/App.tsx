import { useCallback, useEffect, useMemo, useState } from 'react';
import { isAddress, maxUint256, type Address, type Chain, type WalletClient } from 'viem';
import { PotluckCircleAbi } from './abi/PotluckCircle';
import { PotluckFactoryAbi } from './abi/PotluckFactory';
import { TestUSDGAbi } from './abi/TestUSDG';
import { chainById, chains, connectWallet, demoAccountIndex, deployments, explorerAddress, explorerTx, publicClient } from './chain';
import {
  MODES,
  PHASES,
  circleCount,
  listCircles,
  readCircle,
  readReputation,
  readWallet,
  short,
  toUnits,
  usd,
  type Circle,
  type Stats,
} from './data';

type Route = { page: 'home' } | { page: 'circle'; address: Address } | { page: 'score'; address?: Address };

function parseRoute(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const [p, a] = h.split('/');
  if (p === 'c' && a && isAddress(a)) return { page: 'circle', address: a };
  if (p === 'score') return { page: 'score', address: a && isAddress(a) ? a : undefined };
  return { page: 'home' };
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function duration(s: number) {
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

const niceDuration = (s: number) =>
  s % 86400 === 0 ? `${s / 86400} day${s === 86400 ? '' : 's'}` : s % 3600 === 0 ? `${s / 3600} h` : `${Math.round(s / 60)} min`;

export default function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const [chain, setChain] = useState<Chain>(() => chainById(Number(localStorage.getItem('potluck.chain')) || chains[0]?.id));
  const [account, setAccount] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<WalletClient | null>(null);
  const [toast, setToast] = useState<{ text: string; link?: string | null; kind?: 'err' } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const f = () => setRoute(parseRoute());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('potluck.chain', String(chain.id));
    } catch {
      /* storage may be unavailable */
    }
    setWallet(null);
    setAccount(null);
    if (demoAccountIndex() !== null) void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.id]);

  const connect = useCallback(async () => {
    try {
      const r = await connectWallet(chain);
      setWallet(r.wallet);
      setAccount(r.account);
    } catch (e) {
      setToast({ text: (e as Error).message, kind: 'err' });
    }
  }, [chain]);

  /** Send a transaction, wait for it, and refresh everything. */
  const send = useCallback(
    async (label: string, req: { address: Address; abi: readonly unknown[]; functionName: string; args?: unknown[] }) => {
      if (!wallet || !account) {
        await connect();
        return false;
      }
      try {
        setToast({ text: `${label}…` });
        const hash = await wallet.writeContract({ ...req, account, chain } as never);
        setToast({ text: `${label}: waiting for the block…`, link: explorerTx(chain, hash) });
        const rc = await publicClient(chain).waitForTransactionReceipt({ hash });
        if (rc.status !== 'success') throw new Error('Transaction reverted');
        setToast({ text: `${label}: done`, link: explorerTx(chain, hash) });
        setTick((t) => t + 1);
        return true;
      } catch (e) {
        const msg = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message;
        setToast({ text: `${label} failed: ${msg}`, kind: 'err' });
        return false;
      }
    },
    [wallet, account, chain, connect],
  );

  if (!chains.length) return <div className="page"><p>No deployment found.</p></div>;

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#/">
          <Logo /> <span>Potluck</span>
        </a>
        <nav>
          <a href="#/" className={route.page === 'home' ? 'on' : ''}>Circles</a>
          <a href={`#/score${account ? '/' + account : ''}`} className={route.page === 'score' ? 'on' : ''}>Savings score</a>
        </nav>
        <div className="right">
          <select value={chain.id} onChange={(e) => setChain(chainById(Number(e.target.value)))} aria-label="Network">
            {chains.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {account ? <span className="acct">{short(account)}</span> : <button className="btn" onClick={connect}>Connect wallet</button>}
        </div>
      </header>

      {route.page === 'home' && <Home chain={chain} tick={tick} send={send} account={account} />}
      {route.page === 'circle' && <CirclePage key={route.address} chain={chain} address={route.address} account={account} send={send} tick={tick} />}
      {route.page === 'score' && <ScorePage chain={chain} address={route.address ?? account ?? undefined} />}

      {toast && (
        <div className={`toast ${toast.kind === 'err' ? 'err' : ''}`} onClick={() => setToast(null)}>
          <span>{toast.text}</span>
          {toast.link && (
            <a href={toast.link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>view tx</a>
          )}
        </div>
      )}
      <footer>
        Contracts on {chain.name}:{' '}
        <a href={explorerAddress(chain, deployments[chain.id].factory) ?? '#'} target="_blank" rel="noreferrer">factory {short(deployments[chain.id].factory)}</a>
        {' · '}
        <a href="https://github.com/luoy16002-svg/potluck" target="_blank" rel="noreferrer">source</a>
        {' · '}no admin keys, no custody: funds move only by the circle's rules.
      </footer>
    </div>
  );
}

type Send = (label: string, req: { address: Address; abi: readonly unknown[]; functionName: string; args?: unknown[] }) => Promise<boolean>;

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
      <circle cx="13" cy="13" r="11" fill="none" stroke="currentColor" strokeWidth="2.2" />
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
        return <circle key={i} cx={13 + 11 * Math.cos(a)} cy={13 + 11 * Math.sin(a)} r={i === 0 ? 3.2 : 2.2} fill={i === 0 ? 'var(--accent)' : 'currentColor'} />;
      })}
    </svg>
  );
}

// ------------------------------------------------------------------------------------------------ home

function Home({ chain, tick, send, account }: { chain: Chain; tick: number; send: Send; account: Address | null }) {
  const [circles, setCircles] = useState<Circle[] | null>(null);
  const [count, setCount] = useState(0);
  useEffect(() => {
    let off = false;
    (async () => {
      const [addrs, n] = await Promise.all([listCircles(chain, 12), circleCount(chain)]);
      const cs = await Promise.all(addrs.map((a) => readCircle(chain, a)));
      if (!off) {
        setCircles(cs);
        setCount(n);
      }
    })().catch(() => !off && setCircles([]));
    return () => {
      off = true;
    };
  }, [chain, tick]);

  return (
    <main className="page">
      <section className="hero">
        <div>
          <p className="eyebrow">Savings circles on Arbitrum · USDG</p>
          <h1>
            Save together.
            <br />
            Get the pot <em>in turns.</em>
          </h1>
          <p className="lede">
            Over a billion people save in rotating circles: <b>hui</b> in China, <b>arisan</b> in Indonesia, <b>tanda</b> in Mexico,
            <b> susu</b> in Ghana, <b>chit funds</b> in India. Everyone pays in each round and one member takes the whole pot.
            It works on trust, and it breaks when someone takes the pot and disappears.
          </p>
          <p className="lede">
            Potluck puts the circle in a contract: collateral and a winner's bond cover missed payments, an optional auction lets whoever
            needs the money first pay the others interest, and every on-time payment becomes a portable savings record.
          </p>
        </div>
        <HeroRing />
      </section>

      <section className="steps">
        {[
          ['01', 'Join', 'Lock a small collateral. The circle starts when every seat is filled.'],
          ['02', 'Pay each round', 'Everyone puts the same amount in. Miss a round and your collateral pays it for you.'],
          ['03', 'Take the pot', 'In join order, or by auction: the highest discount wins and the discount is shared by everyone else.'],
          ['04', 'Build a record', 'When the circle ends, on-time payments and defaults are written to an open, on-chain savings score.'],
        ].map(([n, t, d]) => (
          <div key={n} className="step">
            <span className="num">{n}</span>
            <h3>{t}</h3>
            <p>{d}</p>
          </div>
        ))}
      </section>

      <section className="list">
        <div className="list-head">
          <h2>Circles on {chain.name}</h2>
          <span className="muted">{count} created</span>
        </div>
        {!circles && <p className="muted">Loading…</p>}
        {circles && circles.length === 0 && <p className="muted">No circles yet. Start the first one below.</p>}
        <div className="cards">
          {circles?.map((c) => (
            <a key={c.address} className="card" href={`#/c/${c.address}`}>
              <div className="card-top">
                <span className={`pill p${c.phase}`}>{PHASES[c.phase]}</span>
                <span className="muted">{MODES[c.config.mode]}</span>
              </div>
              <h3>{c.name}</h3>
              <div className="card-nums">
                <div><b>{usd(c.config.contribution, 0)}</b><span>USDG / round</span></div>
                <div><b>{c.members.length}/{c.config.size}</b><span>members</span></div>
                <div><b>{usd(c.config.contribution * BigInt(c.config.size), 0)}</b><span>pot</span></div>
              </div>
              <MiniRing circle={c} />
            </a>
          ))}
        </div>
      </section>

      <CreateForm chain={chain} send={send} account={account} />
    </main>
  );
}

function HeroRing() {
  const now = useNow(1200);
  const n = 8;
  const active = now % n;
  return (
    <svg className="hero-ring" viewBox="0 0 320 320" aria-hidden>
      <circle cx="160" cy="160" r="118" className="ring-track" />
      {Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        const x = 160 + 118 * Math.cos(a), y = 160 + 118 * Math.sin(a);
        const on = i === active;
        return (
          <g key={i}>
            <line x1={x} y1={y} x2={160} y2={160} className={`spoke ${on ? 'on' : ''}`} />
            <circle cx={x} cy={y} r={on ? 17 : 12} className={`seat ${i < active ? 'won' : ''} ${on ? 'on' : ''}`} />
          </g>
        );
      })}
      <circle cx="160" cy="160" r="46" className="pot" />
      <text x="160" y="156" textAnchor="middle" className="pot-t">POT</text>
      <text x="160" y="178" textAnchor="middle" className="pot-v">800</text>
    </svg>
  );
}

function MiniRing({ circle }: { circle: Circle }) {
  const n = circle.config.size;
  return (
    <svg viewBox="0 0 200 26" className="mini">
      {Array.from({ length: n }, (_, i) => {
        const m = circle.members[i];
        const cls = !m ? 'empty' : m.defaulted ? 'def' : m.won ? 'won' : 'in';
        return <circle key={i} cx={10 + (i * 180) / Math.max(n - 1, 1)} cy={13} r={7} className={`dot ${cls}`} />;
      })}
    </svg>
  );
}

function CreateForm({ chain, send, account }: { chain: Chain; send: Send; account: Address | null }) {
  const d = deployments[chain.id];
  const [f, setF] = useState({ name: 'Friday lunch circle', contribution: '100', size: '5', round: '604800', mode: '1', collateral: '100', bond: '20', discount: '10' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const auction = f.mode === '1';
  const pot = Number(f.contribution || 0) * Number(f.size || 0);

  async function create() {
    const cfg = {
      token: d.usdg,
      contribution: toUnits(f.contribution),
      collateral: toUnits(f.collateral),
      size: Number(f.size),
      roundDuration: Number(f.round),
      joinWindow: 7 * 86400,
      bondBps: Math.round(Number(f.bond) * 100),
      maxDiscountBps: auction ? Math.round(Number(f.discount) * 100) : 0,
      mode: Number(f.mode),
    };
    const before = await circleCount(chain);
    const ok = await send('Create circle', { address: d.factory, abi: PotluckFactoryAbi, functionName: 'createCircle', args: [f.name, cfg] });
    if (ok) {
      const [latest] = await listCircles(chain, 1);
      if (latest && (await circleCount(chain)) > before) location.hash = `#/c/${latest}`;
    }
  }

  return (
    <section className="create">
      <h2>Start a circle</h2>
      <p className="muted">You join like everyone else after creating it. The contract has no owner: once it starts, nobody can change the rules.</p>
      <div className="grid">
        <label className="wide">Name<input value={f.name} onChange={set('name')} maxLength={48} /></label>
        <label>Each round (USDG)<input value={f.contribution} onChange={set('contribution')} inputMode="decimal" /></label>
        <label>Members<input value={f.size} onChange={set('size')} inputMode="numeric" /></label>
        <label>Round length
          <select value={f.round} onChange={set('round')}>
            <option value="120">2 minutes (demo)</option>
            <option value="86400">1 day</option>
            <option value="604800">1 week</option>
            <option value="1209600">2 weeks</option>
            <option value="2592000">30 days</option>
          </select>
        </label>
        <label>Who takes the pot
          <select value={f.mode} onChange={set('mode')}>
            <option value="0">In join order</option>
            <option value="1">Auction (highest discount)</option>
          </select>
        </label>
        <label>Collateral (USDG)<input value={f.collateral} onChange={set('collateral')} inputMode="decimal" /></label>
        <label>Winner's bond (%)<input value={f.bond} onChange={set('bond')} inputMode="decimal" /></label>
        {auction && <label>Max auction discount (%)<input value={f.discount} onChange={set('discount')} inputMode="decimal" /></label>}
      </div>
      <p className="summary">
        {f.size} people × {f.contribution} USDG = a <b>{pot.toLocaleString()} USDG</b> pot every {niceDuration(Number(f.round))}, for {f.size} rounds.
        {auction ? ` Members bid up to ${f.discount}% of the pot to take it early; the discount is paid to the others.` : ' Paid out in the order people join.'}
      </p>
      <button className="btn big" onClick={create}>{account ? 'Create circle' : 'Connect wallet to create'}</button>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- circle

function CirclePage({ chain, address, account, send, tick }: { chain: Chain; address: Address; account: Address | null; send: Send; tick: number }) {
  const [c, setC] = useState<Circle | null>(null);
  const [err, setErr] = useState('');
  const [me, setMe] = useState<{ balance: bigint; allowance: bigint; eth: bigint } | null>(null);
  const [bid, setBid] = useState('');
  const wallNow = useNow();
  const [poll, setPoll] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setPoll((p) => p + 1), 6000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    readCircle(chain, address).then(setC, (e) => setErr((e as Error).message));
  }, [chain, address, tick, poll]);
  useEffect(() => {
    if (!account || !c) return setMe(null);
    readWallet(chain, c.config.token, account, address).then(setMe);
  }, [chain, account, c, address, tick]);

  const mine = useMemo(() => c?.members.find((m) => account && m.address.toLowerCase() === account.toLowerCase()), [c, account]);
  if (err) return <main className="page"><p className="muted">Could not load this circle on {chain.name}: {err}</p></main>;
  if (!c) return <main className="page"><p className="muted">Loading circle…</p></main>;

  const now = wallNow + c.clockSkew;
  const cfg = c.config;
  const pot = cfg.contribution * BigInt(cfg.size);
  const token = cfg.token;
  const isTestToken = token.toLowerCase() === deployments[chain.id].usdg.toLowerCase();
  const needsApproval = (amount: bigint) => !me || me.allowance < amount;
  const approve = () => send('Approve USDG', { address: token, abi: TestUSDGAbi, functionName: 'approve', args: [address, maxUint256] });
  const call = (label: string, functionName: string, args: unknown[] = []) => send(label, { address, abi: PotluckCircleAbi, functionName, args });
  const auction = cfg.mode === 1;
  const left = c.deadline - now;
  const allActivePaid = c.members.every((m) => m.defaulted || m.paidThisRound);
  const canSettle = c.phase === 1 && (left < 0 || (!auction && allActivePaid));
  const nextInLine = c.members.find((m) => !m.won && !m.defaulted);

  return (
    <main className="page circle-page">
      <a href="#/" className="back">← All circles</a>
      <section className="circle-head">
        <div>
          <p className="eyebrow">{MODES[cfg.mode]} · {cfg.size} members · rounds every {niceDuration(cfg.roundDuration)}</p>
          <h1>{c.name}</h1>
          <div className="facts">
            <div><span>Each round</span><b>{usd(cfg.contribution)} USDG</b></div>
            <div><span>Pot</span><b>{usd(pot)} USDG</b></div>
            <div><span>Collateral</span><b>{usd(cfg.collateral)}</b></div>
            <div><span>Winner's bond</span><b>{cfg.bondBps / 100}%</b></div>
            {auction && <div><span>Max discount</span><b>{cfg.maxDiscountBps / 100}%</b></div>}
          </div>
        </div>
        <div className="status">
          <span className={`pill p${c.phase}`}>{PHASES[c.phase]}</span>
          {c.phase === 0 && <p>{c.members.length} of {cfg.size} joined · closes in {duration(c.joinDeadline - now)}</p>}
          {c.phase === 1 && (
            <>
              <p className="round">Round {c.currentRound} <span>of {cfg.size}</span></p>
              <p>{left > 0 ? <>Closes in <b>{duration(left)}</b></> : 'Round closed · ready to settle'}</p>
              <p className="muted">Collected {usd(c.collected)} of {usd(pot)}</p>
            </>
          )}
          {c.phase === 2 && <p>All {cfg.size} rounds paid out.</p>}
        </div>
      </section>

      <section className="circle-body">
        <BigRing c={c} account={account} />
        <div className="panel">
          <h3>Your seat</h3>
          {!account && <p className="muted">Connect a wallet to join or pay.</p>}
          {account && me && (
            <p className="muted small">
              Wallet: {usd(me.balance)} USDG · {Number(me.eth) / 1e18 < 0.0001 ? 'no gas' : `${(Number(me.eth) / 1e18).toFixed(4)} ETH`}
            </p>
          )}
          {account && isTestToken && me && me.balance < cfg.collateral + cfg.contribution && (
            <button className="btn ghost" onClick={() => send('Get 1,000 test USDG', { address: token, abi: TestUSDGAbi, functionName: 'faucet' })}>
              Get 1,000 test USDG
            </button>
          )}
          {c.phase === 0 && account && !mine && (
            needsApproval(cfg.collateral) ? (
              <button className="btn" onClick={approve}>Approve USDG</button>
            ) : (
              <button className="btn" onClick={() => call('Join circle', 'join')}>Join · lock {usd(cfg.collateral)} USDG</button>
            )
          )}
          {mine && (
            <div className="seat-facts">
              <div><span>Status</span><b>{mine.defaulted ? 'Defaulted' : mine.won ? `Took the pot in round ${mine.wonRound}` : 'Waiting for the pot'}</b></div>
              <div><span>Paid on time</span><b>{mine.onTime}</b></div>
              <div><span>Missed</span><b>{mine.missed}</b></div>
              <div><span>Collateral left</span><b>{usd(mine.collateralLeft)}</b></div>
              <div><span>Bond held</span><b>{usd(mine.bond)}</b></div>
              <div><span>Received</span><b>{usd(mine.received)}</b></div>
            </div>
          )}
          {c.phase === 1 && mine && !mine.defaulted && !mine.paidThisRound && (
            needsApproval(cfg.contribution) ? (
              <button className="btn" onClick={approve}>Approve USDG</button>
            ) : (
              <button className="btn" onClick={() => call(`Pay round ${c.currentRound}`, 'contribute')}>Pay round {c.currentRound} · {usd(cfg.contribution)} USDG</button>
            )
          )}
          {c.phase === 1 && mine?.paidThisRound && <p className="ok">✓ Paid for round {c.currentRound}</p>}
          {c.phase === 1 && auction && mine && !mine.won && !mine.defaulted && mine.paidThisRound && left > 0 && (
            <div className="bid">
              <p className="small">
                Want this round's pot? Offer a discount (max {usd(c.maxDiscount)}). The highest offer wins and the discount goes to the other members.
                {c.topBidder && <> Current best: <b>{usd(c.topDiscount)}</b> by {c.topBidder.toLowerCase() === account?.toLowerCase() ? 'you' : short(c.topBidder)}.</>}
              </p>
              <div className="row">
                <input value={bid} onChange={(e) => setBid(e.target.value)} placeholder="discount in USDG" inputMode="decimal" />
                <button className="btn" onClick={() => call('Place bid', 'bid', [toUnits(bid)]).then((ok) => ok && setBid(''))}>Bid</button>
              </div>
            </div>
          )}
          {canSettle && (
            <button className="btn dark" onClick={() => call(`Settle round ${c.currentRound}`, 'settleRound')}>
              Settle round {c.currentRound} → pay {auction && c.topBidder ? short(c.topBidder) : nextInLine ? short(nextInLine.address) : 'members'}
            </button>
          )}
          {(c.phase === 2 || c.phase === 3) && mine && !mine.withdrawn && mine.collateralLeft + mine.bond > 0n && (
            <button className="btn" onClick={() => call('Withdraw collateral and bond', 'withdraw')}>
              Withdraw {usd(mine.collateralLeft + mine.bond)} USDG
            </button>
          )}
          {c.phase === 0 && account?.toLowerCase() === c.creator.toLowerCase() && (
            <button className="btn ghost" onClick={() => call('Cancel circle', 'cancel')}>Cancel before it starts</button>
          )}
        </div>
      </section>

      <section className="members">
        <h3>Members</h3>
        <table>
          <thead>
            <tr><th>#</th><th>Member</th><th>This round</th><th>On time</th><th>Missed</th><th>Pot</th><th>Collateral</th><th>Bond</th></tr>
          </thead>
          <tbody>
            {c.members.map((m, i) => (
              <tr key={m.address} className={m.address.toLowerCase() === account?.toLowerCase() ? 'me' : ''}>
                <td>{i + 1}</td>
                <td><a href={`#/score/${m.address}`}>{short(m.address)}</a></td>
                <td>{c.phase !== 1 ? '—' : m.defaulted ? <span className="bad">defaulted</span> : m.paidThisRound ? <span className="good">paid</span> : <span className="muted">not yet</span>}</td>
                <td>{m.onTime}</td>
                <td>{m.missed || '—'}</td>
                <td>{m.won ? `round ${m.wonRound}` : '—'}</td>
                <td>{usd(m.collateralLeft)}</td>
                <td>{usd(m.bond)}</td>
              </tr>
            ))}
            {Array.from({ length: cfg.size - c.members.length }, (_, i) => (
              <tr key={`e${i}`} className="empty"><td>{c.members.length + i + 1}</td><td colSpan={7}>open seat</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      {c.results.length > 0 && (
        <section className="members">
          <h3>Payout history</h3>
          <table>
            <thead><tr><th>Round</th><th>Winner</th><th>Pot</th><th>Discount shared</th><th>Paid out</th><th>Bond held</th></tr></thead>
            <tbody>
              {[...c.results].reverse().map((r) => (
                <tr key={r.round}>
                  <td>{r.round}</td><td>{short(r.winner)}</td><td>{usd(r.pot)}</td><td>{r.discount ? usd(r.discount) : '—'}</td><td>{usd(r.payout)}</td><td>{r.bondHeld ? usd(r.bondHeld) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <p className="muted small">
        Circle contract <a href={explorerAddress(chain, address) ?? '#'} target="_blank" rel="noreferrer">{address}</a>
      </p>
    </main>
  );
}

function BigRing({ c, account }: { c: Circle; account: Address | null }) {
  const n = c.config.size;
  const R = 150;
  const current = c.phase === 1 ? (c.config.mode === 1 ? c.topBidder : c.members.find((m) => !m.won && !m.defaulted)?.address) : null;
  const paidCount = c.members.filter((m) => m.paidThisRound).length;
  const pot = c.config.contribution * BigInt(n);
  return (
    <svg className="big-ring" viewBox="0 0 400 400">
      <circle cx="200" cy="200" r={R} className="ring-track" />
      {c.phase === 1 && (
        <circle cx="200" cy="200" r={R} className="ring-progress" style={{ strokeDasharray: `${(paidCount / n) * 2 * Math.PI * R} ${2 * Math.PI * R}` }} transform="rotate(-90 200 200)" />
      )}
      {Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        const x = 200 + R * Math.cos(a), y = 200 + R * Math.sin(a);
        const m = c.members[i];
        const isCurrent = m && current && m.address.toLowerCase() === current.toLowerCase();
        const isMe = m && account && m.address.toLowerCase() === account.toLowerCase();
        const cls = !m ? 'empty' : m.defaulted ? 'def' : m.won ? 'won' : m.paidThisRound ? 'paid' : 'in';
        return (
          <g key={i}>
            {isCurrent && <line x1={x} y1={y} x2={200} y2={200} className="spoke on" />}
            <circle cx={x} cy={y} r={isCurrent ? 24 : 18} className={`seat ${cls} ${isCurrent ? 'on' : ''}`} />
            <text x={x} y={y + 4} textAnchor="middle" className="seat-t">{m ? (m.won ? `R${m.wonRound}` : i + 1) : '+'}</text>
            {isMe && <text x={x} y={y + (y > 200 ? 40 : -30)} textAnchor="middle" className="me-t">you</text>}
          </g>
        );
      })}
      <circle cx="200" cy="200" r="62" className="pot" />
      <text x="200" y="190" textAnchor="middle" className="pot-t">{c.phase === 1 ? `ROUND ${c.currentRound}` : PHASES[c.phase].toUpperCase()}</text>
      <text x="200" y="218" textAnchor="middle" className="pot-v">{usd(c.phase === 1 ? c.collected : pot, 0)}</text>
      <text x="200" y="238" textAnchor="middle" className="pot-s">{c.phase === 1 ? `of ${usd(pot, 0)} USDG` : 'USDG pot'}</text>
    </svg>
  );
}

// ----------------------------------------------------------------------------------------------- score

function ScorePage({ chain, address }: { chain: Chain; address?: Address }) {
  const [q, setQ] = useState(address ?? '');
  const [res, setRes] = useState<{ stats: Stats; score: number } | null>(null);
  useEffect(() => {
    if (address) {
      setQ(address);
      readReputation(chain, address).then(setRes);
    }
  }, [chain, address]);
  const look = () => isAddress(q) && (location.hash = `#/score/${q}`);
  const s = res?.stats;
  return (
    <main className="page score-page">
      <p className="eyebrow">Open savings record</p>
      <h1>Savings score</h1>
      <p className="lede">
        Every finished circle writes each member's on-time payments, missed payments and defaults to <code>PotluckReputation</code>. Any protocol can
        read it: a lender deciding on a first loan, a new circle choosing its collateral, a merchant offering pay-later.
      </p>
      <div className="row search">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="0x… address" />
        <button className="btn" onClick={look}>Look up</button>
      </div>
      {res && s && (
        <div className="score-card">
          <div className="score-num">
            <b>{res.score}</b>
            <span>/ 1000</span>
          </div>
          <div className="score-bar"><i style={{ width: `${res.score / 10}%` }} /></div>
          <div className="facts">
            <div><span>Circles completed</span><b>{s.circlesCompleted}</b></div>
            <div><span>On-time payments</span><b>{s.onTimePayments}</b></div>
            <div><span>Missed payments</span><b>{s.missedPayments}</b></div>
            <div><span>Defaults</span><b>{s.circlesDefaulted}</b></div>
            <div><span>Total saved</span><b>{usd(s.totalContributed)} USDG</b></div>
          </div>
        </div>
      )}
    </main>
  );
}
