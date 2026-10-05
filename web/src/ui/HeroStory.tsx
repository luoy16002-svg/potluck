import { useEffect, useState } from 'react';

/**
 * The home page illustration: a six-person circle playing out. Each round everyone pays 100 into the pot, the pot
 * goes to one member, and that member keeps paying until the end. After six rounds everyone has taken the pot once.
 */
const MEMBERS = [
  { name: 'Mei', color: '#d2563b' },
  { name: 'Budi', color: '#2f4858' },
  { name: 'Lucía', color: '#c99a2e' },
  { name: 'Ama', color: '#1e6b52' },
  { name: 'Arjun', color: '#6b4e71' },
  { name: 'Linh', color: '#9c3f2b' },
];
/** Who takes the pot in each round. */
const ORDER = [0, 3, 1, 4, 2, 5];
const N = MEMBERS.length;
const PAY = 100;
const ROUND = 3.6; // seconds per round
const HOLD = 2.6; // pause on the finished circle
const LOOP = ROUND * N + HOLD;
const C = 200, R = 136, AV = 23;

const ease = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
const seat = (i: number) => {
  const a = -Math.PI / 2 + (i / N) * Math.PI * 2;
  return { x: C + R * Math.cos(a), y: C + R * Math.sin(a), dx: Math.cos(a), dy: Math.sin(a) };
};
/** A point on a gentle curve from p to q (the coin's flight). */
function along(p: { x: number; y: number }, q: { x: number; y: number }, k: number, bend = 22) {
  const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const cx = mx - ((q.y - p.y) / len) * bend, cy = my + ((q.x - p.x) / len) * bend;
  const u = 1 - k;
  return { x: u * u * p.x + 2 * u * k * cx + k * k * q.x, y: u * u * p.y + 2 * u * k * cy + k * k * q.y };
}

function useStoryClock(): number {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [t, setT] = useState(reduced ? ROUND * 2 + 3 : 0);
  useEffect(() => {
    if (reduced) return;
    let raf = 0, visible = true, last = performance.now(), acc = 0;
    const io = 'IntersectionObserver' in window ? new IntersectionObserver(([e]) => (visible = e.isIntersecting)) : null;
    const el = document.querySelector('.story');
    if (io && el) io.observe(el);
    const frame = (now: number) => {
      // A frame's timestamp can be slightly earlier than the clock read when the effect started, so the step is
      // clamped to [0, 0.1] s: never negative, and no jump after the tab comes back.
      const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
      last = Math.max(last, now);
      if (visible) {
        acc = (acc + dt) % LOOP;
        setT(acc);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      io?.disconnect();
    };
  }, [reduced]);
  return t;
}

export function HeroStory({ sym }: { sym: string }) {
  const t = Math.max(0, useStoryClock());
  const done = t >= ROUND * N;
  const r = done ? N - 1 : Math.min(N - 1, Math.floor(t / ROUND));
  const rt = done ? ROUND : t - r * ROUND; // time inside the round
  const winner = ORDER[r];
  const pot = { x: C, y: C };

  // Collection: coin i leaves at 0.12 s * i and lands 0.8 s later.
  const coins = MEMBERS.map((_, i) => {
    const k = ease((rt - i * 0.12) / 0.8);
    return { i, k, landed: rt >= i * 0.12 + 0.8 };
  });
  const collected = coins.filter((c) => c.landed).length * PAY;
  const payK = done ? 1 : ease((rt - 1.8) / 0.8);
  const paying = !done && rt >= 1.8 && rt < 2.6;
  const paid = done || rt >= 2.6;
  const pulse = !done && rt >= 1.4 && rt < 1.8 ? 1 + 0.05 * Math.sin(((rt - 1.4) / 0.4) * Math.PI) : 1;
  const winners = new Set(ORDER.slice(0, paid ? r + 1 : r));

  const line = done
    ? `Six rounds, six pots. Every payment is now on the record.`
    : rt < 1.8
      ? `Everyone pays ${PAY} ${sym} into the pot`
      : `${MEMBERS[winner].name} takes the ${PAY * N} ${sym} pot`;

  return (
    <figure className="story" aria-label="Animation: a six-person savings circle paying out one pot per round">
      <svg viewBox="0 0 400 400" role="img">
        <defs>
          <radialGradient id="potFill" cx="0.38" cy="0.32" r="0.75">
            <stop offset="0" stopColor="#e7bf5c" />
            <stop offset="0.6" stopColor="#c99a2e" />
            <stop offset="1" stopColor="#a87b1c" />
          </radialGradient>
          <radialGradient id="coinFill" cx="0.35" cy="0.3" r="0.8">
            <stop offset="0" stopColor="#f6d77c" />
            <stop offset="0.7" stopColor="#d6a63a" />
            <stop offset="1" stopColor="#a87b1c" />
          </radialGradient>
          <radialGradient id="seatShine" cx="0.34" cy="0.28" r="0.75">
            <stop offset="0" stopColor="#fff" stopOpacity="0.32" />
            <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="3" stdDeviation="3.5" floodColor="#3b2b05" floodOpacity="0.18" />
          </filter>
        </defs>

        <circle cx={C} cy={C} r={R} className="story-track" />
        {MEMBERS.map((_, i) => {
          const s = seat(i);
          return <line key={i} x1={s.x} y1={s.y} x2={C} y2={C} className={`story-spoke ${!done && rt < 1.4 ? 'flow' : ''}`} />;
        })}

        {/* coins in flight: drawn under the pot, so they sink into it */}
        {!done && rt < 1.8 &&
          coins.map(({ i, k, landed }) => {
            if (k <= 0 || landed) return null;
            const p = along(seat(i), pot, k);
            return <circle key={i} cx={p.x} cy={p.y} r={7.5} fill="url(#coinFill)" stroke="#a87b1c" strokeWidth="1" />;
          })}
        {/* the pot */}
        <g filter="url(#soft)" transform={`translate(${C} ${C}) scale(${pulse}) translate(${-C} ${-C})`}>
          <circle cx={C} cy={C} r={58} fill="url(#potFill)" />
          <circle cx={C} cy={C} r={50} fill="none" stroke="#fff" strokeOpacity="0.32" strokeWidth="1.5" />
        </g>
        <text x={C} y={C - 16} textAnchor="middle" className="story-pot-t">{done ? 'COMPLETE' : `ROUND ${r + 1}`}</text>
        <text x={C} y={C + 13} textAnchor="middle" className="story-pot-v">{done ? N : rt < 1.8 ? collected : PAY * N}</text>
        <text x={C} y={C + 31} textAnchor="middle" className="story-pot-s">{done ? 'pots paid' : rt < 1.8 ? sym : `${sym} to ${MEMBERS[winner].name}`}</text>

        {paying && (() => {
          // The payout leaves from the pot's rim, so it never crosses the amount printed on the pot.
          const w = seat(winner);
          const d = Math.hypot(w.x - C, w.y - C) || 1;
          const rim = { x: C + ((w.x - C) / d) * 58, y: C + ((w.y - C) / d) * 58 };
          const p = along(rim, w, payK, -26);
          return (
            <g filter="url(#soft)">
              <circle cx={p.x} cy={p.y} r={13} fill="url(#coinFill)" stroke="#a87b1c" strokeWidth="1.2" />
              <circle cx={p.x} cy={p.y} r={8.5} fill="none" stroke="#fff" strokeOpacity="0.45" strokeWidth="1.2" />
            </g>
          );
        })()}

        {/* members */}
        {MEMBERS.map((m, i) => {
          const s = seat(i);
          const isWinner = !done && i === winner && rt >= 1.8;
          const lx = s.x + s.dx * 42, ly = s.y + s.dy * 42 + 4;
          const anchor = Math.abs(s.dx) < 0.3 ? 'middle' : s.dx > 0 ? 'start' : 'end';
          return (
            <g key={m.name}>
              {isWinner && <circle cx={s.x} cy={s.y} r={AV + 6} className="story-halo" />}
              <g filter="url(#soft)">
                <circle cx={s.x} cy={s.y} r={AV} fill={m.color} />
              </g>
              <circle cx={s.x} cy={s.y} r={AV} fill="url(#seatShine)" />
              <text x={s.x} y={s.y + 5.5} textAnchor="middle" className="story-initial">{m.name[0]}</text>
              <text x={Math.abs(s.dx) < 0.3 ? s.x : lx} y={Math.abs(s.dx) < 0.3 ? s.y + s.dy * 44 + 4 : ly} textAnchor={anchor} className="story-name">
                {m.name}
              </text>
              {winners.has(i) && (
                <g transform={`translate(${s.x + 17} ${s.y - 17})`} className="story-badge">
                  <circle r="9" />
                  <path d="M-4 0.5 L-1.2 3.2 L4.2 -2.6" />
                </g>
              )}
            </g>
          );
        })}

      </svg>
      <figcaption>
        <span className="story-round">{done ? 'Circle complete' : `Round ${r + 1} of ${N}`}</span>
        <span className="story-line">{line}</span>
      </figcaption>
    </figure>
  );
}
