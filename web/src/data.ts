import { formatUnits, parseUnits, type Address, type Chain, type Hex } from 'viem';
import { PotluckCircleAbi } from './abi/PotluckCircle';
import { PotluckFactoryAbi } from './abi/PotluckFactory';
import { PotluckReputationAbi } from './abi/PotluckReputation';
import { TestUSDGAbi } from './abi/TestUSDG';
import { deployments, publicClient } from './chain';

export const PHASES = ['Forming', 'Active', 'Completed', 'Cancelled'] as const;
export const MODES = ['Fixed order', 'Auction'] as const;

export const usd = (v: bigint, digits = 2) =>
  Number(formatUnits(v, 6)).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const toUnits = (s: string) => parseUnits(s || '0', 6);
export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

export type Config = {
  token: Address;
  contribution: bigint;
  collateral: bigint;
  size: number;
  roundDuration: number;
  joinWindow: number;
  bondBps: number;
  maxDiscountBps: number;
  mode: number;
};

export type MemberInfo = {
  address: Address;
  joined: boolean;
  won: boolean;
  defaulted: boolean;
  withdrawn: boolean;
  wonRound: number;
  onTime: number;
  missed: number;
  collateralLeft: bigint;
  bond: bigint;
  contributed: bigint;
  received: bigint;
  claimable: bigint;
  paidThisRound: boolean;
};

export type RoundResult = { round: number; winner: Address; pot: bigint; discount: bigint; payout: bigint; bondHeld: bigint; settledAt: number };

export type Circle = {
  address: Address;
  name: string;
  creator: Address;
  config: Config;
  phase: number;
  currentRound: number;
  createdAt: number;
  startedAt: number;
  members: MemberInfo[];
  collected: bigint;
  topBidder: Address | null;
  topDiscount: bigint;
  deadline: number;
  joinDeadline: number;
  maxDiscount: bigint;
  results: RoundResult[];
  /** chain time minus wall-clock time, in seconds (local chains can be fast-forwarded) */
  clockSkew: number;
};

const ZERO = '0x0000000000000000000000000000000000000000';

export async function listCircles(chain: Chain, limit = 12): Promise<Address[]> {
  const d = deployments[chain.id];
  return (await publicClient(chain).readContract({
    address: d.factory,
    abi: PotluckFactoryAbi,
    functionName: 'latestCircles',
    args: [BigInt(limit)],
  })) as Address[];
}

export async function readCircle(chain: Chain, address: Address): Promise<Circle> {
  const c = publicClient(chain);
  const read = <T>(functionName: string, args: unknown[] = []) =>
    c.readContract({ address, abi: PotluckCircleAbi, functionName, args } as never) as Promise<T>;

  const [name, creator, config, phase, currentRound, createdAt, startedAt, memberAddrs, joinDeadline, maxDiscount, block] =
    await Promise.all([
      read<string>('name'),
      read<Address>('creator'),
      read<Config>('config'),
      read<number>('phase'),
      read<number>('currentRound'),
      read<bigint>('createdAt'),
      read<bigint>('startedAt'),
      read<Address[]>('members'),
      read<bigint>('joinDeadline'),
      read<bigint>('maxDiscount'),
      c.getBlock(),
    ]);
  const r = Number(currentRound);
  const round = BigInt(Math.max(r, 1));
  const [infos, paidFlags, collected, topBidder, topDiscount, deadline] = await Promise.all([
    Promise.all(memberAddrs.map((m) => read<Omit<MemberInfo, 'address' | 'paidThisRound'>>('memberInfo', [m]))),
    Promise.all(memberAddrs.map((m) => read<boolean>('paid', [round, m]))),
    read<bigint>('collected', [round]),
    read<Address>('topBidder', [round]),
    read<bigint>('topDiscount', [round]),
    read<bigint>('roundDeadline', [round]),
  ]);
  const settled = phase === 2 ? Number(config.size) : Math.max(r - 1, 0);
  const results = await Promise.all(
    Array.from({ length: settled }, (_, i) =>
      read<Omit<RoundResult, 'round' | 'settledAt'> & { settledAt: bigint }>('result', [BigInt(i + 1)]).then((x) => ({
        ...x,
        round: i + 1,
        settledAt: Number(x.settledAt),
      })),
    ),
  );
  return {
    address,
    name,
    creator,
    config: { ...config, size: Number(config.size), roundDuration: Number(config.roundDuration), joinWindow: Number(config.joinWindow), bondBps: Number(config.bondBps), maxDiscountBps: Number(config.maxDiscountBps), mode: Number(config.mode) },
    phase: Number(phase),
    currentRound: r,
    createdAt: Number(createdAt),
    startedAt: Number(startedAt),
    members: memberAddrs.map((a, i) => ({ ...infos[i], address: a, paidThisRound: paidFlags[i], wonRound: Number(infos[i].wonRound), onTime: Number(infos[i].onTime), missed: Number(infos[i].missed) })),
    collected,
    topBidder: topBidder === ZERO ? null : topBidder,
    topDiscount,
    deadline: Number(deadline),
    joinDeadline: Number(joinDeadline),
    maxDiscount,
    results,
    clockSkew: Number(block.timestamp) - Math.floor(Date.now() / 1000),
  };
}

export async function readWallet(chain: Chain, token: Address, owner: Address, spender?: Address) {
  const c = publicClient(chain);
  const [balance, allowance, eth] = await Promise.all([
    c.readContract({ address: token, abi: TestUSDGAbi, functionName: 'balanceOf', args: [owner] }) as Promise<bigint>,
    spender
      ? (c.readContract({ address: token, abi: TestUSDGAbi, functionName: 'allowance', args: [owner, spender] }) as Promise<bigint>)
      : Promise.resolve(0n),
    c.getBalance({ address: owner }),
  ]);
  return { balance, allowance, eth };
}

export type Stats = {
  circlesCompleted: number;
  circlesDefaulted: number;
  onTimePayments: number;
  missedPayments: number;
  totalContributed: bigint;
  lastUpdated: bigint;
};

export async function readReputation(chain: Chain, who: Address): Promise<{ stats: Stats; score: number }> {
  const d = deployments[chain.id];
  const c = publicClient(chain);
  const [stats, score] = await Promise.all([
    c.readContract({ address: d.reputation, abi: PotluckReputationAbi, functionName: 'stats', args: [who] }) as Promise<Stats>,
    c.readContract({ address: d.reputation, abi: PotluckReputationAbi, functionName: 'score', args: [who] }) as Promise<bigint>,
  ]);
  return { stats, score: Number(score) };
}

export async function circleCount(chain: Chain): Promise<number> {
  const d = deployments[chain.id];
  return Number(
    await publicClient(chain).readContract({ address: d.factory, abi: PotluckFactoryAbi, functionName: 'circleCount' }),
  );
}

export type Hash = Hex;
