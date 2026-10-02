import { useEffect, useRef, useState } from 'react';
import { decodeEventLog, type Address, type Chain, type Hex } from 'viem';
import { PotluckCircleAbi } from './abi/PotluckCircle';
import { publicClient } from './chain';

/** Monad's block states for a log delivered by the `monadLogs` subscription. Logs read over HTTP are final. */
export type CommitState = 'Proposed' | 'Voted' | 'Finalized' | 'Verified';

export type LiveEvent = {
  key: string;
  seen: number;
  block: bigint;
  name: string;
  args: Record<string, unknown>;
  tx: `0x${string}`;
  state?: CommitState;
};

/** Public RPCs cap eth_getLogs at 100 blocks per request (Monad testnet), so the HTTP reader goes forward in chunks. */
const SPAN = 99n;
/** After a long pause (hidden tab) only the most recent blocks are read again. */
const MAX_CATCH_UP = 500n;
/** Chains with a WebSocket endpoint that streams logs as soon as a block is proposed. */
const MONAD_WSS: Record<number, string> = { 10143: 'wss://testnet-rpc.monad.xyz' };

const RANK: Record<string, number> = { Proposed: 0, Voted: 1, Finalized: 2, Verified: 3 };

function merge(prev: LiveEvent[], incoming: LiveEvent[]): LiveEvent[] {
  const next = [...prev];
  const fresh: LiveEvent[] = [];
  for (const e of incoming) {
    const i = next.findIndex((x) => x.key === e.key);
    if (i < 0) fresh.push(e);
    else if (e.state && (!next[i].state || RANK[e.state] > RANK[next[i].state!])) next[i] = { ...next[i], state: e.state };
    else if (!e.state && next[i].state) next[i] = { ...next[i], state: 'Finalized' };
  }
  return [...fresh.reverse(), ...next].slice(0, 40);
}

/**
 * The circle's events as they land. Every chain gets an HTTP reader: on open it reads the last 100 blocks, then
 * every `pollMs` the blocks added since. On Monad the feed also subscribes to `monadLogs` over WebSocket, which
 * delivers a log when its block is proposed (about half a second after the transaction is sent) and again as the
 * block is voted, finalized and verified.
 */
export function useLiveEvents(chain: Chain, address: Address, pollMs: number): { events: LiveEvent[]; head: bigint | null; streaming: boolean } {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [head, setHead] = useState<bigint | null>(null);
  const [streaming, setStreaming] = useState(false);
  const last = useRef<bigint | null>(null);
  const busy = useRef(false);

  // HTTP reader (backfill everywhere, and the only source where there is no stream)
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
              key: `${l.transactionHash}:${Number(l.logIndex)}`,
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
        if (found.length) setEvents((prev) => merge(prev, found));
      } catch {
        /* the next tick retries */
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const t = setInterval(tick, MONAD_WSS[chain.id] ? pollMs * 4 : pollMs);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [chain, address, pollMs]);

  // Monad stream
  useEffect(() => {
    const url = MONAD_WSS[chain.id];
    if (!url || typeof WebSocket === 'undefined') return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    const open = () => {
      ws = new WebSocket(url);
      ws.onopen = () => {
        retry = 0;
        ws!.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['monadLogs', { address }] }));
      };
      ws.onmessage = (m) => {
        let d: { id?: number; result?: unknown; params?: { result?: { data: Hex; topics: [Hex, ...Hex[]]; transactionHash: `0x${string}`; logIndex: string; blockNumber: string; commitState?: CommitState } } };
        try {
          d = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (d.id === 1) return setStreaming(!!d.result);
        const r = d.params?.result;
        if (!r) return;
        let decoded: { eventName: string; args: unknown };
        try {
          decoded = decodeEventLog({ abi: PotluckCircleAbi, data: r.data, topics: r.topics }) as { eventName: string; args: unknown };
        } catch {
          return;
        }
        const e: LiveEvent = {
          key: `${r.transactionHash}:${Number(r.logIndex)}`,
          seen: Date.now(),
          block: BigInt(r.blockNumber),
          name: decoded.eventName,
          args: decoded.args as Record<string, unknown>,
          tx: r.transactionHash,
          state: r.commitState ?? 'Proposed',
        };
        setEvents((prev) => merge(prev, [e]));
        setHead((h) => (h === null || e.block > h ? e.block : h));
      };
      ws.onclose = () => {
        setStreaming(false);
        if (!closed) setTimeout(open, Math.min(15000, 1000 * 2 ** retry++));
      };
    };
    open();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [chain.id, address]);

  return { events, head, streaming };
}
