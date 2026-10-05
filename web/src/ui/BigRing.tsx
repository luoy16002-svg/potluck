import type { Address } from 'viem';
import { PHASES, usd, type Circle } from '../data';
import { AvatarG } from './Avatar';

/** Seats for a circle that does not exist yet (the practice page before "Create"): who will sit where. */
export type RingPreview = { size: number; seats: (Address | null)[]; pot: bigint };

/** The circle drawn as seats around a pot: who paid this round, who took which pot, who leads the auction.
 * `names` labels seats by address (lower-case keys); the connected account is always "you". */
export function BigRing({ c, account, sym, names, preview }: {
  c: Circle | null;
  account: Address | null;
  sym: string;
  names?: Record<string, string>;
  preview?: RingPreview;
}) {
  const n = c ? c.config.size : (preview?.size ?? 3);
  const R = 148;
  const AV = n > 8 ? 17 : 21;
  const current = c && c.phase === 1 ? (c.config.mode === 1 ? c.topBidder : c.members.find((m) => !m.won && !m.defaulted)?.address) : null;
  const paidCount = c ? c.members.filter((m) => m.paidThisRound).length : 0;
  const pot = c ? c.config.contribution * BigInt(n) : (preview?.pot ?? 0n);
  const label = (addr: Address) => {
    const a = addr.toLowerCase();
    if (account && a === account.toLowerCase()) return { text: 'you', me: true };
    return names?.[a] ? { text: names[a], me: false } : null;
  };
  const seats = Array.from({ length: n }, (_, i) => {
    if (c) {
      const m = c.members[i];
      return m ? { address: m.address, won: m.won, wonRound: m.wonRound, defaulted: m.defaulted, paid: m.paidThisRound } : null;
    }
    const a = preview?.seats[i];
    return a ? { address: a, won: false, wonRound: 0, defaulted: false, paid: false } : null;
  });
  const top = c ? (c.phase === 1 ? `ROUND ${c.currentRound}` : PHASES[c.phase].toUpperCase()) : 'PRACTICE';
  return (
    <svg className="big-ring" viewBox="0 0 400 400" role="img" aria-label={`${seats.filter(Boolean).length} of ${n} seats around a ${usd(pot, 0)} ${sym} pot`}>
      <defs>
        <radialGradient id="ringPot" cx="0.38" cy="0.32" r="0.75">
          <stop offset="0" stopColor="#e7bf5c" />
          <stop offset="0.6" stopColor="#c99a2e" />
          <stop offset="1" stopColor="#a87b1c" />
        </radialGradient>
        <filter id="ringSoft" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="3" stdDeviation="3.5" floodColor="#3b2b05" floodOpacity="0.16" />
        </filter>
      </defs>
      <circle cx="200" cy="200" r={R} className="ring-track" />
      {c && c.phase === 1 && (
        <circle cx="200" cy="200" r={R} className="ring-progress" style={{ strokeDasharray: `${(paidCount / n) * 2 * Math.PI * R} ${2 * Math.PI * R}` }} transform="rotate(-90 200 200)" />
      )}
      {seats.map((m, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        const x = 200 + R * Math.cos(a), y = 200 + R * Math.sin(a);
        if (!m) {
          return (
            <g key={i}>
              <circle cx={x} cy={y} r={AV} className="seat-empty-ring" />
              <text x={x} y={y + 5} textAnchor="middle" className="seat-plus">+</text>
            </g>
          );
        }
        const isCurrent = current && m.address.toLowerCase() === current.toLowerCase();
        const ring = m.defaulted ? 'def' : m.paid && c?.phase === 1 ? 'paid' : '';
        const tag = label(m.address);
        return (
          <g key={i}>
            {isCurrent && <line x1={x} y1={y} x2={200} y2={200} className="spoke on" />}
            {isCurrent && <circle cx={x} cy={y} r={AV + 7} className="seat-halo" />}
            <g filter="url(#ringSoft)"><AvatarG address={m.address} cx={x} cy={y} r={AV} /></g>
            {ring && <circle cx={x} cy={y} r={AV + 2.5} className={`seat-ring ${ring}`} />}
            {m.won && (
              <g transform={`translate(${x + AV * 0.78} ${y - AV * 0.78})`} className="seat-badge">
                <rect x="-13" y="-9" width="26" height="18" rx="9" />
                <text y="4" textAnchor="middle">R{m.wonRound}</text>
              </g>
            )}
            {tag && <text x={x} y={y + (y > 200 ? AV + 20 : -AV - 10)} textAnchor="middle" className={tag.me ? 'me-t' : 'seat-name'}>{tag.text}</text>}
          </g>
        );
      })}
      <g filter="url(#ringSoft)"><circle cx="200" cy="200" r="64" fill="url(#ringPot)" /></g>
      <circle cx="200" cy="200" r="56" fill="none" stroke="#fff" strokeOpacity="0.3" strokeWidth="1.5" />
      <text x="200" y="186" textAnchor="middle" className="pot-t">{top}</text>
      <text x="200" y="215" textAnchor="middle" className="pot-v">{usd(c && c.phase === 1 ? c.collected : pot, 0)}</text>
      <text x="200" y="234" textAnchor="middle" className="pot-s">{c && c.phase === 1 ? `of ${usd(pot, 0)} ${sym}` : `${sym} pot`}</text>
    </svg>
  );
}
