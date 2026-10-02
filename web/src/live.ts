import { useEffect, useRef, useState } from 'react';
import type { Address, Chain } from 'viem';
import { PotluckCircleAbi } from './abi/PotluckCircle';
import { publicClient } from './chain';

export type LiveEvent = { key: string; seen: number; block: bigint; name: string; args: Record<string, unknown>; tx: `0x${string}` };

/** Public RPCs cap eth_getLogs at 100 blocks per request (Monad testnet), so the feed reads forward in chunks. */
const SPAN = 99n;
/** After a long pause (hidden tab) only the most recent blocks are read again. */
const MAX_CATCH_UP = 500n;

/**
 * The circle's events as they land: on open it reads the last 100 blocks, then every `pollMs` it reads the blocks
 * added since. On Monad that is about a second from a member's transaction to the line in everyone's feed.
 */
export function useLiveEvents(chain: Chain, address: Address, pollMs: number): { events: LiveEvent[]; head: bigint | null } {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [head, setHead] = useState<bigint | null>(null);
  const last = useRef<bigint | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    let stopped = false;
    last.current = null;
    setEvents([]);
    const pc = publicClient(chain);
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const tip = await pc.getBlockNumber();
        let from = last.current === null ? tip - SPAN : last.current + 1n;
        if (tip - from > MAX_CATCH_UP) from = tip - MAX_CATCH_UP;
        if (from < 0n) from = 0n;
        const found: LiveEvent[] = [];
        while (from <= tip) {
          const to = from + SPAN < tip ? from + SPAN : tip;
          const logs = await pc.getContractEvents({ address, abi: PotluckCircleAbi, fromBlock: from, toBlock: to });
          for (const l of logs) {
            found.push({
              key: `${l.transactionHash}:${l.logIndex}`,
              seen: last.current === null ? 0 : Date.now(),
              block: l.blockNumber!,
              name: (l as unknown as { eventName: string }).eventName,
              args: (l as unknown as { args: Record<string, unknown> }).args,
              tx: l.transactionHash!,
            });
          }
          from = to + 1n;
        }
        last.current = tip;
        if (stopped) return;
        setHead(tip);
        if (found.length) {
          setEvents((prev) => {
            const known = new Set(prev.map((e) => e.key));
            return [...found.filter((e) => !known.has(e.key)).reverse(), ...prev].slice(0, 40);
          });
        }
      } catch {
        /* the next tick retries */
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const t = setInterval(tick, pollMs);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [chain, address, pollMs]);

  return { events, head };
}
