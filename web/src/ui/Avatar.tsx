import { useId } from 'react';

/** Bright brand swatches for generated avatars: clay, apricot, saffron, jade, mint, sky, plum, rose, slate. */
const SWATCH = ['#d2563b', '#f0a35e', '#e8bd4a', '#2f8f6b', '#8cc7a8', '#6aa3d5', '#8e5c8a', '#e47e93', '#2f4858'];

/** Three distinct colours and two offsets, fixed for an address, so a member looks the same on every screen. */
function avatarStyle(address: string) {
  const h = address.toLowerCase().replace(/^0x/, '').padEnd(12, '0');
  const byte = (i: number) => parseInt(h.slice(i * 2, i * 2 + 2), 16);
  const pick: string[] = [];
  for (let i = 0; pick.length < 3; i++) {
    const c = SWATCH[(byte(i % 6) + i * 7) % SWATCH.length];
    if (!pick.includes(c)) pick.push(c);
  }
  const off = (b: number) => ((b / 255) * 2 - 1) * 0.42;
  const ax = off(byte(3)), ay = off(byte(4));
  return { c1: pick[0], c2: pick[1], c3: pick[2], ax, ay, bx: -ax * 1.15 + off(byte(5)) * 0.25, by: -ay * 1.15 };
}

/**
 * A member's avatar inside another SVG (the circle ring), centred on (cx, cy): a flat disc with a large and a small
 * circle of contrasting colours, clipped to the disc.
 */
export function AvatarG({ address, cx, cy, r }: { address: string; cx: number; cy: number; r: number }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const s = avatarStyle(address);
  return (
    <g>
      <defs>
        <clipPath id={`avc${id}`}>
          <circle cx={cx} cy={cy} r={r} />
        </clipPath>
      </defs>
      <circle cx={cx} cy={cy} r={r} fill={s.c1} />
      <g clipPath={`url(#avc${id})`}>
        <circle cx={cx + s.ax * r} cy={cy + s.ay * r} r={r * 0.64} fill={s.c2} />
        <circle cx={cx + s.bx * r} cy={cy + s.by * r} r={r * 0.28} fill={s.c3} />
      </g>
      <circle cx={cx} cy={cy} r={r - 0.5} fill="none" stroke="rgba(23, 20, 15, 0.12)" strokeWidth="1" />
    </g>
  );
}

/** A standalone avatar for tables, lists and the live feed. */
export function Avatar({ address, size = 22 }: { address: string; size?: number }) {
  return (
    <svg className="avatar" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <AvatarG address={address} cx={12} cy={12} r={12} />
    </svg>
  );
}
