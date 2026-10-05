import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isAddress, maxUint256, type Address, type Chain, type WalletClient } from 'viem';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CheckCircle,
  CircleNotch,
  Coins,
  Flask,
  Gavel,
  GasPump,
  GithubLogo,
  HandCoins,
  Info,
  Lightning,
  ListNumbers,
  LockKey,
  SealCheck,
  UsersThree,
  Wallet,
  WarningCircle,
} from '@phosphor-icons/react';
import { PotluckCircleAbi } from './abi/PotluckCircle';
import { PotluckFactoryAbi } from './abi/PotluckFactory';
import { TestUSDGAbi } from './abi/TestUSDG';
import { Practice } from './Practice';
import { chainById, chains, connectWallet, demoAccountIndex, deployments, explorerAddress, explorerTx, gasFor, isNetworkHiccup, publicClient } from './chain';
import { net } from './net';
import { useLiveEvents, type LiveEvent } from './live';
import {
  MODES,
  PHASES,
  circleCount,
  listCircles,
  money,
  readCircle,
  readReputation,
  readWallet,
  short,
  toUnits,
  usd,
  type Circle,
  type Stats,
} from './data';
import { Avatar } from './ui/Avatar';
import { HeroStory } from './ui/HeroStory';
import { NetworkPicker } from './ui/NetworkPicker';
import { chainName, isLive } from './ui/labels';
import { Showcase } from './ui/Showcase';
import { BigRing } from './ui/BigRing';
import { Guard } from './ui/Guard';

type Route = { page: 'home' } | { page: 'practice' } | { page: 'circle'; address: Address } | { page: 'score'; address?: Address };

const REPO = 'https://github.com/luoy16002-svg/potluck';
const sourcifyUrl = (chainId: number, address: string) => `https://repo.sourcify.dev/${chainId}/${address}`;

function parseRoute(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const [p, a] = h.split('/');
  if (p === 'c' && a && isAddress(a)) return { page: 'circle', address: a };
  if (p === 'score') return { page: 'score', address: a && isAddress(a) ? a : undefined };
  if (p === 'practice') return { page: 'practice' };
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

type Toast = { text: string; link?: string | null; kind: 'pending' | 'ok' | 'err' };

export default function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const [chain, setChain] = useState<Chain>(() => chainById(Number(new URLSearchParams(location.search).get('chain')) || Number(localStorage.getItem('potluck.chain')) || chains[0]?.id));
  const [account, setAccount] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<WalletClient | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const f = () => {
      setRoute(parseRoute());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('potluck.chain', String(chain.id));
    } catch {
      /* storage may be unavailable */
    }
    // Keep the address bar in step with the network, so a copied link opens the same network.
    const url = new URL(location.href);
    if (url.searchParams.get('chain') !== String(chain.id)) {
      url.searchParams.set('chain', String(chain.id));
      history.replaceState(null, '', url);
    }
    setWallet(null);
    setAccount(null);
    if (demoAccountIndex() !== null) void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.id]);

  useEffect(() => {
    if (toast?.kind !== 'ok') return;
    const t = setTimeout(() => setToast((x) => (x === toast ? null : x)), 6000);
    return () => clearTimeout(t);
  }, [toast]);

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
        setToast({ text: `${label}: confirm in your wallet`, kind: 'pending' });
        const from = wallet.account ?? account;
        const gas = await gasFor(chain, req, from);
        const hash = await wallet.writeContract({ ...req, account: from, chain, gas } as never);
        setToast({ text: `${label}: waiting for the block`, link: explorerTx(chain, hash), kind: 'pending' });
        const rc = await publicClient(chain).waitForTransactionReceipt({ hash });
        if (rc.status !== 'success') throw new Error('Transaction reverted');
        setToast({ text: `${label}: done`, link: explorerTx(chain, hash), kind: 'ok' });
        setTick((t) => t + 1);
        return true;
      } catch (e) {
        setToast({ text: `${label} failed: ${explain(e)}`, kind: 'err' });
        return false;
      }
    },
    [wallet, account, chain, connect],
  );

  if (!chains.length) return <div className="page"><p>No deployment found.</p></div>;
  const d = deployments[chain.id];
  const N = net(chain.id);

  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <a className="brand" href="#/" aria-label="Potluck home">
          <Logo /> <span>Potluck</span>
        </a>
        <nav aria-label="Main">
          <a href="#/" className={route.page === 'home' ? 'on' : ''}>Circles</a>
          <a href="#/practice" className={route.page === 'practice' ? 'on' : ''}>Try it alone</a>
          <a href={`#/score${account ? '/' + account : ''}`} className={route.page === 'score' ? 'on' : ''}>Savings score</a>
        </nav>
        <div className="right">
          <NetworkPicker chain={chain} chains={chains} onChange={setChain} />
          {account ? (
            <span className="acct" title={account}>
              <Avatar address={account} size={18} /> {short(account)}
            </span>
          ) : (
            <button className="btn connect" onClick={connect}>
              <Wallet size={18} weight="bold" aria-hidden />
              <span className="lg">Connect wallet</span>
              <span className="sm">Connect</span>
            </button>
          )}
        </div>
      </header>

      <div id="main">
        {route.page === 'home' && <Home key={chain.id} chain={chain} tick={tick} send={send} account={account} />}
        {route.page === 'circle' && <CirclePage key={`${chain.id}:${route.address}`} chain={chain} address={route.address} account={account} send={send} tick={tick} />}
        {route.page === 'score' && <ScorePage key={`${chain.id}:${route.address ?? account ?? ''}`} chain={chain} address={route.address ?? account ?? undefined} />}
        {route.page === 'practice' && <Practice chain={chain} account={account} wallet={wallet} send={send} connect={connect} />}
      </div>

      {toast && (
        <div className={`toast ${toast.kind}`} role="status" onClick={() => setToast(null)}>
          {toast.kind === 'pending' ? <CircleNotch size={18} weight="bold" className="spin" aria-hidden /> : toast.kind === 'ok' ? <CheckCircle size={18} weight="fill" aria-hidden /> : <WarningCircle size={18} weight="fill" aria-hidden />}
          <span>{toast.text}</span>
          {toast.link && (
            <a href={toast.link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              view tx <ArrowUpRight size={13} weight="bold" aria-hidden />
            </a>
          )}
        </div>
      )}
      <footer>
        <div className="foot-links">
          <span>
            Contracts on {chainName(chain)}:{' '}
            <a href={explorerAddress(chain, d.factory) ?? '#'} target="_blank" rel="noreferrer">
              factory {short(d.factory)} <ArrowUpRight size={12} weight="bold" aria-hidden />
            </a>
          </span>
          {N.verified && (
            <a href={sourcifyUrl(chain.id, d.factory)} target="_blank" rel="noreferrer">
              verified on Sourcify <ArrowUpRight size={12} weight="bold" aria-hidden />
            </a>
          )}
          <a href={REPO} target="_blank" rel="noreferrer">
            source, MIT <ArrowUpRight size={12} weight="bold" aria-hidden />
          </a>
        </div>
        <p>No admin keys and no custody: funds move only by the circle's rules.</p>
      </footer>
    </div>
  );
}

const FRIENDLY: Record<string, string> = {
  WrongPhase: 'the circle is not in the right stage for this',
  JoinClosed: 'the join window has closed',
  AlreadyMember: 'you are already a member',
  NotMember: 'this wallet is not a member of the circle',
  AlreadyPaid: 'you already paid this round',
  NotEligible: 'you cannot bid: you already took a pot or defaulted',
  MustContributeFirst: 'pay this round before bidding',
  BiddingClosed: 'bidding for this round has closed',
  DiscountTooHigh: 'that discount is above the maximum for this circle',
  BidTooLow: 'someone already offered that much or more',
  RoundStillOpen: 'the round is still open',
  NotCancellable: 'only the creator can cancel before the join window ends',
  NothingToWithdraw: 'nothing left to withdraw',
  Cooldown: 'the test faucet is on cooldown; try again later',
  MaxFrequencyExceeded: 'the AUSD test faucet serves one request a minute for everyone; try again in a minute',
  ERC20InsufficientBalance: 'not enough stablecoin in your wallet',
  ERC20InsufficientAllowance: 'approve the token first',
};

/** Turn wallet and contract errors into one plain sentence. */
function explain(e: unknown): string {
  const raw = `${(e as { shortMessage?: string }).shortMessage ?? ''} ${(e as Error).message ?? ''}`;
  const name = raw.match(/Error: (\w+)\(/)?.[1] ?? raw.match(/reverted with the following reason:\s*(\w+)/)?.[1];
  if (name && FRIENDLY[name]) return FRIENDLY[name];
  if (/User rejected|denied/i.test(raw)) return 'you rejected the request in your wallet';
  if (/insufficient funds/i.test(raw)) return 'not enough gas in this wallet (test networks: the Try it page links to a faucet)';
  if (isNetworkHiccup(e)) return 'the network did not answer in time; please try again';
  return ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? 'unknown error').split('\n')[0];
}

type Send = (label: string, req: { address: Address; abi: readonly unknown[]; functionName: string; args?: unknown[] }) => Promise<boolean>;

function Logo() {
  return (
    <svg width="26" height="26" viewBox="-2 -3 30 31" aria-hidden>
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
  const N = net(chain.id);
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

  const practiceHref = N.mainnet && N.practiceChain ? `?chain=${N.practiceChain}#/practice` : '#/practice';

  return (
    <main className="page">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">{N.tagline}</p>
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
            Potluck puts the circle in a contract. Collateral and a winner's bond cover missed payments, an optional auction lets whoever
            needs the money first pay the others interest, and every on-time payment becomes a portable savings record.
          </p>
          <div className="cta-row">
            <a className="btn big" href={practiceHref}>
              Try a whole circle in 3 minutes <ArrowRight size={18} weight="bold" aria-hidden />
            </a>
            {N.showcase && (
              <a className="btn big ghost" href={`?chain=${N.showcase.chainId}#/c/${N.showcase.circle}`}>
                See a finished circle
              </a>
            )}
          </div>
        </div>
        <Guard>
          <HeroStory sym={N.sym} />
        </Guard>
      </section>

      <TrustStrip chain={chain} />

      <section className="steps" aria-label="How a circle works">
        {[
          { n: '01', t: 'Join', d: 'Lock a small collateral. The circle starts when every seat is filled.', Icon: UsersThree },
          { n: '02', t: 'Pay each round', d: 'Everyone puts the same amount in. Miss a round and your collateral pays it for you.', Icon: Coins },
          { n: '03', t: 'Take the pot', d: 'In join order, or by auction: the highest discount wins and the discount is shared by everyone else.', Icon: HandCoins },
          { n: '04', t: 'Build a record', d: 'When the circle ends, on-time payments and defaults are written to an open, on-chain savings score.', Icon: SealCheck },
        ].map(({ n, t, d, Icon }) => (
          <div key={n} className="step">
            <span className="step-icon"><Icon size={22} weight="duotone" aria-hidden /></span>
            <span className="num">{n}</span>
            <h3>{t}</h3>
            <p>{d}</p>
          </div>
        ))}
      </section>

      <section className="list">
        <div className="list-head">
          <h2>Circles on {chainName(chain)}</h2>
          {circles && <span className="count">{count} created</span>}
        </div>
        {!circles && (
          <div className="cards">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card skeleton" aria-hidden><i style={{ width: '40%' }} /><i style={{ width: '70%' }} /><i style={{ width: '90%' }} /></div>
            ))}
          </div>
        )}
        {circles && circles.length === 0 && (
          N.showcase && isLive(chain) ? (
            <div className="empty-showcase">
              <div className="empty-copy">
                <h3>No circles on {chainName(chain)} mainnet yet.</h3>
                <p>
                  Circles here hold real {N.sym}, so the first ones will be real groups saving together. To see what a whole circle looks like,
                  open one that ran to the end on Arc Testnet with the same contracts, or run your own practice circle in about three minutes.
                </p>
                <a className="btn ghost" href={practiceHref}>
                  Practice on Arc Testnet <ArrowRight size={16} weight="bold" aria-hidden />
                </a>
              </div>
              <Guard>
                <Showcase chainId={N.showcase.chainId} circle={N.showcase.circle} />
              </Guard>
            </div>
          ) : (
            <div className="empty">
              <p>No circles on {chainName(chain)} yet. Start the first one below.</p>
            </div>
          )
        )}
        {circles && circles.length > 0 && (
          <div className="cards">
            {circles.map((c) => (
              <a key={c.address} className="card" href={`#/c/${c.address}`}>
                <div className="card-top">
                  <span className={`pill p${c.phase}`}>{PHASES[c.phase]}</span>
                  <span className="muted small mode">
                    {c.config.mode === 1 ? <Gavel size={14} aria-hidden /> : <ListNumbers size={14} aria-hidden />} {MODES[c.config.mode]}
                  </span>
                </div>
                <h3>{c.name}</h3>
                <div className="card-nums">
                  <div><b>{usd(c.config.contribution, 0)}</b><span>{N.sym} a round</span></div>
                  <div><b>{c.members.length}/{c.config.size}</b><span>members</span></div>
                  <div><b>{usd(c.config.contribution * BigInt(c.config.size), 0)}</b><span>pot</span></div>
                </div>
                <SeatStack circle={c} />
              </a>
            ))}
          </div>
        )}
      </section>

      <CreateForm chain={chain} send={send} account={account} />
    </main>
  );
}

/** The facts a reviewer or a careful saver checks first, each linked to its proof. */
function TrustStrip({ chain }: { chain: Chain }) {
  const N = net(chain.id);
  const d = deployments[chain.id];
  const live = isLive(chain);
  const items: { Icon: typeof LockKey; text: string; href?: string | null }[] = [
    live
      ? { Icon: Lightning, text: `Live on ${chainName(chain)} mainnet`, href: explorerAddress(chain, d.factory) }
      : { Icon: Flask, text: `${chainName(chain)}: free test ${N.sym}` },
    ...(N.verified ? [{ Icon: SealCheck, text: 'Contracts verified on Sourcify', href: sourcifyUrl(chain.id, d.factory) }] : []),
    { Icon: LockKey, text: 'No admin keys, no custody' },
    ...(N.gasIsStable ? [{ Icon: GasPump, text: `Gas paid in ${N.sym}` }] : []),
    { Icon: GithubLogo, text: 'Open source, MIT', href: REPO },
  ];
  return (
    <ul className="trust" aria-label="Facts about the contracts">
      {items.map(({ Icon, text, href }) => (
        <li key={text}>
          {href ? (
            <a href={href} target="_blank" rel="noreferrer">
              <Icon size={17} weight="duotone" aria-hidden /> {text} <ArrowUpRight size={11} weight="bold" className="ext" aria-hidden />
            </a>
          ) : (
            <span><Icon size={17} weight="duotone" aria-hidden /> {text}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Members as a row of avatars, with open seats drawn as dashed rings. */
function SeatStack({ circle }: { circle: Circle }) {
  const n = circle.config.size;
  return (
    <div className="seat-stack" aria-label={`${circle.members.length} of ${n} seats filled`}>
      {Array.from({ length: n }, (_, i) => {
        const m = circle.members[i];
        if (!m) return <span key={i} className="seat-open" />;
        return (
          <span key={i} className={`seat-av ${m.defaulted ? 'def' : m.won ? 'won' : ''}`} title={short(m.address)}>
            <Avatar address={m.address} size={24} />
          </span>
        );
      })}
    </div>
  );
}

function Field({ label, unit, wide, children }: { label: string; unit?: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`field ${wide ? 'wide' : ''}`}>
      <span className="field-label">{label}</span>
      <span className="field-box">
        {children}
        {unit && <span className="unit">{unit}</span>}
      </span>
    </label>
  );
}

function CreateForm({ chain, send, account }: { chain: Chain; send: Send; account: Address | null }) {
  const d = deployments[chain.id];
  const N = net(chain.id);
  const sym = N.sym;
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
    <section className="create" aria-labelledby="create-title">
      <div className="create-head">
        <h2 id="create-title">Start a circle</h2>
        {N.mainnet && (
          <span className="real-money"><Info size={15} weight="bold" aria-hidden /> Real {sym} on {chainName(chain)} mainnet</span>
        )}
      </div>
      <p className="muted">You join like everyone else after creating it. The contract has no owner: once it starts, nobody can change the rules.</p>
      <div className="grid">
        <Field label="Name" wide><input value={f.name} onChange={set('name')} maxLength={48} /></Field>
        <Field label="Each round" unit={sym}><input value={f.contribution} onChange={set('contribution')} inputMode="decimal" /></Field>
        <Field label="Members"><input value={f.size} onChange={set('size')} inputMode="numeric" /></Field>
        <Field label="Round length">
          <select value={f.round} onChange={set('round')}>
            {!N.mainnet && <option value="120">2 minutes (demo)</option>}
            <option value="86400">1 day</option>
            <option value="604800">1 week</option>
            <option value="1209600">2 weeks</option>
            <option value="2592000">30 days</option>
          </select>
        </Field>
        <Field label="Who takes the pot">
          <select value={f.mode} onChange={set('mode')}>
            <option value="0">In join order</option>
            <option value="1">Auction (highest discount)</option>
          </select>
        </Field>
        <Field label="Collateral" unit={sym}><input value={f.collateral} onChange={set('collateral')} inputMode="decimal" /></Field>
        <Field label="Winner's bond" unit="%"><input value={f.bond} onChange={set('bond')} inputMode="decimal" /></Field>
        {auction && <Field label="Max auction discount" unit="%"><input value={f.discount} onChange={set('discount')} inputMode="decimal" /></Field>}
      </div>
      <p className="summary">
        {f.size} people × {f.contribution} {sym} = a <b>{pot.toLocaleString()} {sym}</b> pot every {niceDuration(Number(f.round))}, for {f.size} rounds.
        {auction ? ` Members bid up to ${f.discount}% of the pot to take it early; the discount is paid to the others.` : ' Paid out in the order people join.'}
      </p>
      <button className="btn big" onClick={create}>
        {account ? 'Create circle' : <><Wallet size={18} weight="bold" aria-hidden /> Connect wallet to create</>}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- circle

function CirclePage({ chain, address, account, send, tick }: { chain: Chain; address: Address; account: Address | null; send: Send; tick: number }) {
  const [c, setC] = useState<Circle | null>(null);
  const [err, setErr] = useState('');
  const [walletInfo, setWalletInfo] = useState<{ owner: Address; v: { balance: bigint; allowance: bigint; eth: bigint } } | null>(null);
  const [bid, setBid] = useState('');
  const wallNow = useNow();
  const [poll, setPoll] = useState(0);
  const live = useLiveEvents(chain, address, net(chain.id).pollMs);

  useEffect(() => {
    const t = setInterval(() => setPoll((p) => p + 1), Math.min(6000, net(chain.id).pollMs * 3));
    return () => clearInterval(t);
  }, [chain.id]);
  useEffect(() => {
    readCircle(chain, address).then(setC, (e) => setErr((e as Error).message));
  }, [chain, address, tick, poll, live.events.length]);
  useEffect(() => {
    if (!account || !c) return;
    let off = false;
    readWallet(chain, c.config.token, account, address).then((v) => !off && setWalletInfo({ owner: account, v }));
    return () => {
      off = true;
    };
  }, [chain, account, c, address, tick]);
  const me = walletInfo && account && walletInfo.owner === account ? walletInfo.v : null;

  const mine = useMemo(() => c?.members.find((m) => account && m.address.toLowerCase() === account.toLowerCase()), [c, account]);
  if (err)
    return (
      <main className="page">
        <a href="#/" className="back"><ArrowLeft size={15} weight="bold" aria-hidden /> All circles</a>
        <div className="empty">
          <p>This circle could not be loaded on {chainName(chain)}. Check that the link uses the right network.</p>
        </div>
      </main>
    );
  if (!c)
    return (
      <main className="page">
        <div className="skeleton page-skeleton" aria-busy="true"><i style={{ width: '30%' }} /><i style={{ width: '60%', height: 44 }} /><i style={{ width: '80%' }} /></div>
      </main>
    );

  const now = wallNow + c.clockSkew;
  const cfg = c.config;
  const pot = cfg.contribution * BigInt(cfg.size);
  const token = cfg.token;
  const isTestToken = token.toLowerCase() === deployments[chain.id].usdg.toLowerCase();
  const N = net(chain.id);
  const sym = N.sym;
  const needsApproval = (amount: bigint) => !me || me.allowance < amount;
  const approve = () => send(`Approve ${sym}`, { address: token, abi: TestUSDGAbi, functionName: 'approve', args: [address, maxUint256] });
  const call = (label: string, functionName: string, args: unknown[] = []) => send(label, { address, abi: PotluckCircleAbi, functionName, args });
  const auction = cfg.mode === 1;
  const left = c.deadline - now;
  const allActivePaid = c.members.every((m) => m.defaulted || m.paidThisRound);
  const canSettle = c.phase === 1 && (left < 0 || (!auction && allActivePaid));
  const nextInLine = c.members.find((m) => !m.won && !m.defaulted);

  return (
    <main className="page circle-page">
      <a href="#/" className="back"><ArrowLeft size={15} weight="bold" aria-hidden /> All circles</a>
      <section className="circle-head">
        <div>
          <p className="eyebrow">
            {auction ? <Gavel size={14} weight="bold" aria-hidden /> : <ListNumbers size={14} weight="bold" aria-hidden />} {MODES[cfg.mode]} · {cfg.size} members · rounds every {niceDuration(cfg.roundDuration)}
          </p>
          <h1>{c.name}</h1>
          <div className="facts">
            <div><span>Each round</span><b>{money(cfg.contribution)} {sym}</b></div>
            <div><span>Pot</span><b>{money(pot)} {sym}</b></div>
            <div><span>Collateral</span><b>{money(cfg.collateral)} {sym}</b></div>
            <div><span>Winner's bond</span><b>{cfg.bondBps / 100}%</b></div>
            {auction && <div><span>Max discount</span><b>{cfg.maxDiscountBps / 100}%</b></div>}
          </div>
        </div>
        <div className={`status s${c.phase}`}>
          <span className={`pill p${c.phase}`}>{c.phase === 2 && <CheckCircle size={13} weight="fill" aria-hidden />} {PHASES[c.phase]}</span>
          {c.phase === 0 && <p>{c.members.length} of {cfg.size} seats filled · joining closes in <b>{duration(c.joinDeadline - now)}</b></p>}
          {c.phase === 1 && (
            <>
              <p className="round">Round {c.currentRound} <span>of {cfg.size}</span></p>
              <p>{left > 0 ? <>Closes in <b>{duration(left)}</b></> : 'Round closed · ready to settle'}</p>
              <div className="meter" aria-label={`Collected ${usd(c.collected)} of ${usd(pot)}`}><i style={{ width: `${Number((c.collected * 100n) / (pot || 1n))}%` }} /></div>
              <p className="muted small">Collected {money(c.collected)} of {money(pot)} {sym}</p>
            </>
          )}
          {c.phase === 2 && (
            <>
              <p>All {cfg.size} rounds paid out.</p>
              <p className="muted small">Every member's record is written to the savings score.</p>
            </>
          )}
          {c.phase === 3 && <p>Cancelled before it started. Members can take their collateral back.</p>}
        </div>
      </section>

      <section className="circle-body">
        <div className="ring-wrap">
          <Guard>
            <BigRing c={c} account={account} sym={sym} />
          </Guard>
          <ul className="legend" aria-label="Legend">
            {c.phase === 1 && <li><i className="lg-paid" /> Paid this round</li>}
            <li><i className="lg-won" /> Took the pot</li>
            {c.members.some((m) => m.defaulted) && <li><i className="lg-def" /> Defaulted</li>}
            {c.members.length < cfg.size && <li><i className="lg-open" /> Open seat</li>}
          </ul>
        </div>
        <div className="panel">
          <h3>Your seat</h3>
          {!account && <p className="muted">Connect a wallet to join or pay.</p>}
          {account && me && (
            <p className="muted small">
              Wallet: {usd(me.balance)} {sym} · {N.gasIsStable ? `gas is paid in ${sym}` : Number(me.eth) / 1e18 < 0.0001 ? 'no gas' : `${(Number(me.eth) / 1e18).toFixed(4)} ${N.gasSym}`}
            </p>
          )}
          {account && isTestToken && !N.mainnet && me && me.balance < cfg.collateral + cfg.contribution && (
            N.stableFaucet ? (
              <button className="btn ghost" onClick={() => send(N.stableFaucetLabel ?? `Get test ${sym}`, N.stableFaucet!(token, account!))}>
                {N.stableFaucetLabel ?? `Get test ${sym}`}
              </button>
            ) : N.stableFaucetUrl ? (
              <a className="btn ghost" href={N.stableFaucetUrl} target="_blank" rel="noreferrer">Get test {sym} <ArrowUpRight size={14} weight="bold" aria-hidden /></a>
            ) : null
          )}
          {c.phase === 0 && account && !mine && (
            needsApproval(cfg.collateral) ? (
              <button className="btn" onClick={approve}>Approve {sym}</button>
            ) : (
              <button className="btn" onClick={() => call('Join circle', 'join')}>Join · lock {money(cfg.collateral)} {sym}</button>
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
          {mine && mine.claimable > 0n && (
            <button className="btn" onClick={() => call('Claim payout', 'claim')}>Claim {usd(mine.claimable)} {sym}</button>
          )}
          {c.phase === 1 && mine && !mine.defaulted && !mine.paidThisRound && (
            needsApproval(cfg.contribution) ? (
              <button className="btn" onClick={approve}>Approve {sym}</button>
            ) : (
              <button className="btn" onClick={() => call(`Pay round ${c.currentRound}`, 'contribute')}>Pay round {c.currentRound} · {money(cfg.contribution)} {sym}</button>
            )
          )}
          {c.phase === 1 && mine?.paidThisRound && <p className="ok"><CheckCircle size={17} weight="fill" aria-hidden /> Paid for round {c.currentRound}</p>}
          {c.phase === 1 && auction && mine && !mine.won && !mine.defaulted && mine.paidThisRound && left > 0 && (
            <div className="bid">
              <p className="small">
                Want this round's pot? Offer a discount (max {usd(c.maxDiscount)}). The highest offer wins and the discount goes to the other members.
                {c.topBidder && <> Current best: <b>{usd(c.topDiscount)}</b> by {c.topBidder.toLowerCase() === account?.toLowerCase() ? 'you' : short(c.topBidder)}.</>}
              </p>
              <div className="row">
                <input value={bid} onChange={(e) => setBid(e.target.value)} placeholder={`discount in ${sym}`} inputMode="decimal" aria-label={`Discount in ${sym}`} />
                <button className="btn" onClick={() => call('Place bid', 'bid', [toUnits(bid)]).then((ok) => ok && setBid(''))}>Bid</button>
              </div>
            </div>
          )}
          {canSettle && (
            <button className="btn dark" onClick={() => call(`Settle round ${c.currentRound}`, 'settleRound')}>
              Settle round {c.currentRound} → pay {auction && c.topBidder ? short(c.topBidder) : nextInLine ? short(nextInLine.address) : 'members'}
            </button>
          )}
          {(c.phase === 2 || c.phase === 3) && mine && mine.collateralLeft + mine.bond > 0n && (
            <button className="btn" onClick={() => call('Withdraw collateral and bond', 'withdraw')}>
              Withdraw {usd(mine.collateralLeft + mine.bond + mine.claimable)} {sym}
            </button>
          )}
          {c.phase === 0 && account?.toLowerCase() === c.creator.toLowerCase() && (
            <button className="btn ghost" onClick={() => call('Cancel circle', 'cancel')}>Cancel before it starts</button>
          )}
          {mine && me && me.balance > 0n && c.phase >= 1 && <SendHome token={token} sym={sym} balance={me.balance} send={send} />}
        </div>
      </section>

      <Guard>
        <LiveFeed chain={chain} live={live} c={c} account={account} sym={sym} />
      </Guard>

      <section className="members">
        <h3>Members</h3>
        <table className="rtable">
          <thead>
            <tr><th>#</th><th>Member</th><th>This round</th><th>On time</th><th>Missed</th><th>Pot</th><th>Collateral</th><th>Bond</th></tr>
          </thead>
          <tbody>
            {c.members.map((m, i) => (
              <tr key={m.address} className={m.address.toLowerCase() === account?.toLowerCase() ? 'me' : ''}>
                <td data-label="#">{i + 1}</td>
                <td data-label="Member" className="who"><a href={`#/score/${m.address}`}><Avatar address={m.address} size={20} /> {short(m.address)}</a></td>
                <td data-label="This round">{c.phase !== 1 ? '—' : m.defaulted ? <span className="bad">defaulted</span> : m.paidThisRound ? <span className="good">paid</span> : <span className="muted">not yet</span>}</td>
                <td data-label="On time">{m.onTime}</td>
                <td data-label="Missed">{m.missed || '—'}</td>
                <td data-label="Pot">{m.won ? `round ${m.wonRound}` : '—'}</td>
                <td data-label="Collateral">{usd(m.collateralLeft)}</td>
                <td data-label="Bond">{usd(m.bond)}</td>
              </tr>
            ))}
            {Array.from({ length: cfg.size - c.members.length }, (_, i) => (
              <tr key={`e${i}`} className="empty-row"><td data-label="#">{c.members.length + i + 1}</td><td colSpan={7}>open seat</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      {c.results.length > 0 && (
        <section className="members">
          <h3>Payout history</h3>
          <table className="rtable">
            <thead><tr><th>Round</th><th>Winner</th><th>Pot</th><th>Discount shared</th><th>Paid out</th><th>Bond held</th></tr></thead>
            <tbody>
              {[...c.results].reverse().map((r) => (
                <tr key={r.round}>
                  <td data-label="Round">{r.round}</td>
                  <td data-label="Winner" className="who"><a href={`#/score/${r.winner}`}><Avatar address={r.winner} size={20} /> {short(r.winner)}</a></td>
                  <td data-label="Pot">{usd(r.pot)}</td>
                  <td data-label="Discount shared">{r.discount ? usd(r.discount) : '—'}</td>
                  <td data-label="Paid out">{usd(r.payout)}</td>
                  <td data-label="Bond held">{r.bondHeld ? usd(r.bondHeld) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <p className="muted small contract-line">
        Circle contract{' '}
        <a href={explorerAddress(chain, address) ?? '#'} target="_blank" rel="noreferrer">
          <span className="addr-full">{address}</span><span className="addr-short">{short(address)}</span> <ArrowUpRight size={12} weight="bold" aria-hidden />
        </a>
      </p>
    </main>
  );
}

/** Sending part of a payout on to another wallet: family abroad, a second account, a shop. */
function SendHome({ token, sym, balance, send }: { token: Address; sym: string; balance: bigint; send: Send }) {
  const [to, setTo] = useState(() => {
    try {
      return localStorage.getItem('potluck.sendTo') ?? '';
    } catch {
      return '';
    }
  });
  const [amt, setAmt] = useState('');
  const amount = toUnits(amt.replace(/,/g, '') || '0');
  const ok = isAddress(to, { strict: false }) && amount > 0n && amount <= balance;
  async function go() {
    try {
      localStorage.setItem('potluck.sendTo', to);
    } catch {
      /* ignore */
    }
    if (await send(`Send ${amt} ${sym}`, { address: token, abi: TestUSDGAbi, functionName: 'transfer', args: [to.toLowerCase(), amount] })) setAmt('');
  }
  return (
    <div className="send-home">
      <p className="small"><b>Send it on.</b> Pay part of your {sym} straight to family in another country or to a second wallet. It arrives in seconds.</p>
      <div className="row">
        <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x… address" aria-label="Recipient address" />
        <input value={amt} onChange={(e) => setAmt(e.target.value)} placeholder={`max ${usd(balance)}`} inputMode="decimal" aria-label={`Amount in ${sym}`} />
        <button className="btn ghost" disabled={!ok} onClick={go}>Send</button>
      </div>
    </div>
  );
}

function ago(seen: number, now: number): string {
  if (!seen) return 'earlier';
  const s = Math.max(0, Math.round((now - seen) / 1000));
  return s < 2 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

function LiveFeed({ chain, live, c, account, sym }: { chain: Chain; live: { events: LiveEvent[]; head: bigint | null; streaming: boolean }; c: Circle; account: Address | null; sym: string }) {
  const now = useNow() * 1000;
  const who = (a: unknown) => (typeof a === 'string' && account && a.toLowerCase() === account.toLowerCase() ? 'You' : short(String(a)));
  const amt = (v: unknown) => `${usd(BigInt(v as bigint))} ${sym}`;
  const line = (e: LiveEvent): string => {
    const a = e.args;
    switch (e.name) {
      case 'Joined': return `${who(a.member)} joined (${a.memberCount}/${c.config.size})`;
      case 'Started': return 'All seats filled: round 1 is open';
      case 'Contributed': return `${who(a.member)} paid round ${a.round}: ${amt(a.amount)}${a.onTime ? '' : ' (late)'}`;
      case 'BidPlaced': return `${who(a.member)} bid ${amt(a.discount)} to take round ${a.round}'s pot`;
      case 'MissedCovered': return `${who(a.member)} missed round ${a.round}; ${amt(a.covered)} covered from collateral${a.defaulted ? ', now defaulted' : ''}`;
      case 'RoundSettled': return `Round ${a.round} settled: ${who(a.winner)} takes ${amt(a.payout)}${BigInt(a.discount as bigint) > 0n ? ` after a ${amt(a.discount)} discount` : ''}`;
      case 'DividendPaid': return `${who(a.member)} got ${amt(a.amount)} from the round ${a.round} discount`;
      case 'Claimed': return `${who(a.member)} claimed ${amt(a.amount)}`;
      case 'Withdrawn': return `${who(a.member)} withdrew ${amt(a.amount)}`;
      case 'Completed': return 'Circle complete: savings records written on chain';
      case 'Cancelled': return 'Circle cancelled';
      case 'Initialized': return 'Circle created';
      default: return e.name;
    }
  };
  const actor = (e: LiveEvent) => {
    const a = (e.args.member ?? e.args.winner) as string | undefined;
    return typeof a === 'string' ? a : null;
  };
  const connected = live.head !== null;
  return (
    <section className="live" aria-live="polite">
      <h3>
        <span className={`live-dot ${connected ? 'on' : ''}`} aria-hidden /> Live
        <span className="muted small live-sub">
          {connected ? `up to date at block ${live.head!.toLocaleString()}` : 'connecting to the network'}
          {live.streaming ? ' · streaming as blocks are proposed' : ` · checks every ${net(chain.id).pollMs / 1000}s`}
        </span>
      </h3>
      {live.events.length === 0 ? (
        <p className="muted small">
          {c.phase >= 2
            ? 'This circle has finished. Its whole history is in the tables below.'
            : 'Nothing in the last few blocks. Payments, bids and payouts appear here as they land.'}
        </p>
      ) : (
        <ul>
          {live.events.map((e) => {
            const who = actor(e);
            return (
              <li key={e.key} className={e.seen ? 'fresh' : ''}>
                <span className="when">{ago(e.seen, now)}</span>
                <span className="what">{who && <Avatar address={who} size={18} />}{line(e)}</span>
                <span className="tail">
                  {e.state && <span className={`state ${e.state === 'Finalized' || e.state === 'Verified' ? 'final' : 'pending'}`}>{e.state === 'Verified' ? 'finalized' : e.state.toLowerCase()}</span>}
                  <a href={explorerTx(chain, e.tx) ?? '#'} target="_blank" rel="noreferrer" className="muted small" aria-label="Transaction">tx <ArrowUpRight size={11} weight="bold" aria-hidden /></a>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------------------------- score

function ScoreGauge({ score }: { score: number }) {
  const k = Math.max(0, Math.min(1, score / 1000));
  const r = 90, cx = 110, cy = 104;
  const arc = (to: number) => {
    const a = Math.PI * (1 - to);
    return `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r * Math.cos(a)} ${cy - r * Math.sin(a)}`;
  };
  return (
    <svg className="gauge" viewBox="0 0 220 120" role="img" aria-label={`Score ${score} of 1000`}>
      <defs>
        <linearGradient id="gaugeFill" x1="0" x2="1">
          <stop offset="0" stopColor="#d2563b" />
          <stop offset="0.5" stopColor="#c99a2e" />
          <stop offset="1" stopColor="#1e6b52" />
        </linearGradient>
      </defs>
      <path d={arc(1)} className="gauge-track" />
      {k > 0 && <path d={arc(k)} className="gauge-fill" />}
      <text x={cx} y={cy - 14} textAnchor="middle" className="gauge-v">{score}</text>
      <text x={cx} y={cy + 6} textAnchor="middle" className="gauge-s">of 1000</text>
    </svg>
  );
}

function ScorePage({ chain, address }: { chain: Chain; address?: Address }) {
  const [q, setQ] = useState(address ?? '');
  const [res, setRes] = useState<{ stats: Stats; score: number } | null>(null);
  const [loading, setLoading] = useState(!!address);
  const N = net(chain.id);
  useEffect(() => {
    if (!address) return;
    let off = false;
    readReputation(chain, address)
      .then((r) => !off && setRes(r), () => !off && setRes(null))
      .finally(() => !off && setLoading(false));
    return () => {
      off = true;
    };
  }, [chain, address]);
  const look = () => isAddress(q) && (location.hash = `#/score/${q}`);
  const s = res?.stats;
  const empty = s && s.circlesCompleted === 0 && s.circlesDefaulted === 0 && s.onTimePayments === 0;
  const ex = N.showcase;
  const exampleHref = ex ? (ex.chainId === chain.id ? `#/score/${ex.member}` : `?chain=${ex.chainId}#/score/${ex.member}`) : null;
  return (
    <main className="page score-page">
      <p className="eyebrow">Open savings record</p>
      <h1>Savings score</h1>
      <p className="lede">
        Every finished circle writes each member's on-time payments, missed payments and defaults to <code>PotluckReputation</code>. Any protocol can
        read it: a lender deciding on a first loan, a new circle choosing its collateral, a merchant offering pay-later.
      </p>
      <form
        className="row search"
        onSubmit={(e) => {
          e.preventDefault();
          look();
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value.trim())} placeholder="0x… address" aria-label="Address" spellCheck={false} />
        <button className="btn" type="submit" disabled={!isAddress(q)}>Look up</button>
      </form>
      {exampleHref && ex && (
        <p className="example small">
          Try one:{' '}
          <a href={exampleHref}>
            <Avatar address={ex.member} size={18} /> {short(ex.member)}
          </a>
          , a member of a finished practice circle{ex.chainId !== chain.id ? ' on Arc Testnet' : ''}.
        </p>
      )}
      {loading && <div className="score-card skeleton" aria-busy="true"><i style={{ width: '30%', height: 60 }} /><i style={{ width: '80%' }} /></div>}
      {!loading && res && s && (
        empty ? (
          <div className="empty">
            <p>No finished circles for {short(address)} on {chainName(chain)} yet. A record appears once a circle this address belongs to ends.</p>
          </div>
        ) : (
          <div className="score-card">
            <div className="score-top">
              <ScoreGauge score={res.score} />
              <div className="score-who">
                <Avatar address={address!} size={40} />
                <div>
                  <b>{short(address)}</b>
                  <span className="muted small">on {chainName(chain)}</span>
                </div>
              </div>
            </div>
            <div className="facts">
              <div><span>Circles completed</span><b>{s.circlesCompleted}</b></div>
              <div><span>On-time payments</span><b>{s.onTimePayments}</b></div>
              <div><span>Missed payments</span><b>{s.missedPayments}</b></div>
              <div><span>Defaults</span><b>{s.circlesDefaulted}</b></div>
              <div><span>Total saved</span><b>{money(s.totalContributed)} {N.sym}</b></div>
            </div>
          </div>
        )
      )}
    </main>
  );
}
