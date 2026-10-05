import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle } from '@phosphor-icons/react';
import type { Address } from 'viem';
import { chains, deployments } from '../chain';
import { MODES, readCircle, short, usd, type Circle } from '../data';
import { net } from '../net';
import { Avatar } from './Avatar';
import { chainName } from './labels';

/** A finished circle read live from its network: what a whole circle looks like once every round has paid out. */
export function Showcase({ chainId, circle }: { chainId: number; circle: Address }) {
  const chain = chains.find((c) => c.id === chainId);
  const [c, setC] = useState<Circle | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!chain || !deployments[chainId]) return;
    let off = false;
    readCircle(chain, circle).then(
      (x) => !off && setC(x),
      () => !off && setFailed(true),
    );
    return () => {
      off = true;
    };
  }, [chain, chainId, circle]);
  if (!chain || failed) return null;
  const sym = net(chainId).sym;
  const href = `?chain=${chainId}#/c/${circle}`;

  return (
    <article className="showcase">
      <div className="showcase-top">
        <span className="pill p2"><CheckCircle size={13} weight="fill" aria-hidden /> Completed</span>
        <span className="muted small">on {chainName(chain)}</span>
      </div>
      {!c ? (
        <div className="skeleton" aria-busy="true">
          <i style={{ width: '55%' }} />
          <i style={{ width: '80%' }} />
          <i style={{ width: '70%' }} />
          <i style={{ width: '75%' }} />
        </div>
      ) : (
        <>
          <h3>{c.name}</h3>
          <p className="muted small">
            {MODES[c.config.mode]} · {c.config.size} members · {usd(c.config.contribution, 0)} {sym} a round · {c.results.length} of {c.config.size} pots paid
          </p>
          <ol className="payouts">
            {c.results.map((r) => (
              <li key={r.round}>
                <span className="round-no">R{r.round}</span>
                <Avatar address={r.winner} size={20} />
                <span className="addr">{short(r.winner)}</span>
                <span className="amt">
                  {usd(r.payout)} {sym}
                  {r.discount > 0n && <span className="muted"> · bid {usd(r.discount)}</span>}
                </span>
              </li>
            ))}
          </ol>
          <a className="btn" href={href}>
            Open the finished circle <ArrowRight size={16} weight="bold" aria-hidden />
          </a>
        </>
      )}
    </article>
  );
}
