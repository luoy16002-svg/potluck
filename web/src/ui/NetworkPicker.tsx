import { CaretDown } from '@phosphor-icons/react';
import type { Chain } from 'viem';
import { chainLabel, isLive } from './labels';

/** The network switcher: a native select (keyboard and screen-reader friendly) dressed as a pill. */
export function NetworkPicker({ chain, chains, onChange }: { chain: Chain; chains: Chain[]; onChange: (c: Chain) => void }) {
  const live = isLive(chain);
  return (
    <label className={`netpick ${live ? 'net-live' : 'net-test'}`}>
      <span className="netdot" aria-hidden />
      <span className="netname">{chainLabel(chain)}</span>
      <span className="nettag">{live ? 'Mainnet' : 'Testnet'}</span>
      <CaretDown size={13} weight="bold" aria-hidden />
      <select value={chain.id} onChange={(e) => onChange(chains.find((c) => c.id === Number(e.target.value)) ?? chain)} aria-label="Network">
        {chains.map((c) => (
          <option key={c.id} value={c.id}>
            {chainLabel(c)} {isLive(c) ? '(mainnet)' : '(testnet)'}
          </option>
        ))}
      </select>
    </label>
  );
}
