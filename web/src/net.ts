import { parseEther, type Address } from 'viem';
import { TestUSDGAbi } from './abi/TestUSDG';

/** What differs between the networks Potluck runs on: the dollar token, its test faucet, the gas token, timings. */
export type Net = {
  /** Symbol of the circle's dollar stablecoin. */
  sym: string;
  /** Native gas token. */
  gasSym: string;
  /** Where visitors get test gas. */
  gasFaucet?: string;
  /** Contract call that gives `to` test stablecoins, and its button label. */
  stableFaucet?: (token: Address, to: Address) => { address: Address; abi: readonly unknown[]; functionName: string; args?: unknown[] };
  stableFaucetLabel?: string;
  /** A faucet website instead of a faucet contract (Circle's faucet for Arc). */
  stableFaucetUrl?: string;
  /** Gas is paid in the circle's stablecoin (Arc: USDC is the native gas token, one balance for both). */
  gasIsStable?: boolean;
  /** A production network: no faucets, no practice bots, real money. */
  mainnet?: boolean;
  /** Where practice circles run when this network has none (a mainnet points at its testnet). */
  practiceChain?: number;
  /** Practice circle contribution per round (6 decimals). */
  practiceContribution?: bigint;
  /** Gas sent to each practice bot. */
  botGas: bigint;
  /** The visitor hands the practice bots their stablecoins too (the faucet is rate-limited for everyone). */
  visitorFundsBots: boolean;
  /** Practice round length in seconds. */
  practiceRound: number;
  /** How often open pages re-read the chain, in ms. */
  pollMs: number;
  /** One-line description shown above the home page title. */
  tagline: string;
  /** A finished circle (on this network or its test network) shown to visitors when this network has none yet. */
  showcase?: { chainId: number; circle: Address; member: Address };
  /** The contracts on this network are verified on Sourcify. */
  verified?: boolean;
};

/** A practice circle that ran to completion on Arc Testnet from the web app: auction mode, 3 members, 3 rounds. */
const ARC_SHOWCASE = {
  chainId: 5042002,
  circle: '0x58961Ac01FF484194832059E9e8D8c36667964E7',
  member: '0x739bB2b0eCEa6f02b226B490a5797C2069621931',
} as const;

/** Agora's AUSD faucet on Monad testnet: anyone may call requestFunds(to); 10,000 AUSD per drip. */
const AGORA_FAUCET: Address = '0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C';
const AgoraFaucetAbi = [
  { type: 'function', name: 'requestFunds', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }], outputs: [] },
  { type: 'error', name: 'MaxFrequencyExceeded', inputs: [] },
] as const;

const testUsdg: Net['stableFaucet'] = (token) => ({ address: token, abi: TestUSDGAbi, functionName: 'faucet' });

const NETS: Record<number, Net> = {
  10143: {
    sym: 'AUSD',
    gasSym: 'MON',
    gasFaucet: 'https://faucet.monad.xyz',
    stableFaucet: (_token, to) => ({ address: AGORA_FAUCET, abi: AgoraFaucetAbi, functionName: 'requestFunds', args: [to] }),
    stableFaucetLabel: 'Get 10,000 test AUSD',
    botGas: parseEther('0.5'),
    visitorFundsBots: true,
    practiceRound: 60,
    pollMs: 1000,
    tagline: 'Savings circles on Monad · AUSD',
  },
  46630: {
    sym: 'USDG',
    gasSym: 'ETH',
    gasFaucet: 'https://faucet.testnet.chain.robinhood.com/',
    stableFaucet: testUsdg,
    stableFaucetLabel: 'Get 1,000 test USDG',
    botGas: parseEther('0.00005'),
    visitorFundsBots: false,
    practiceRound: 60,
    pollMs: 6000,
    tagline: 'Savings circles on Arbitrum · USDG',
  },
  421614: {
    sym: 'USDG',
    gasSym: 'ETH',
    gasFaucet: 'https://www.alchemy.com/faucets/arbitrum-sepolia',
    stableFaucet: testUsdg,
    stableFaucetLabel: 'Get 1,000 test USDG',
    botGas: parseEther('0.00005'),
    visitorFundsBots: false,
    practiceRound: 60,
    pollMs: 6000,
    tagline: 'Savings circles on Arbitrum · USDG',
  },
  5042: {
    sym: 'USDC',
    gasSym: 'USDC',
    gasIsStable: true,
    mainnet: true,
    practiceChain: 5042002,
    botGas: 0n,
    visitorFundsBots: false,
    practiceRound: 60,
    pollMs: 2000,
    tagline: 'Savings circles on Arc · USDC',
    showcase: ARC_SHOWCASE,
    verified: true,
  },
  5042002: {
    sym: 'USDC',
    gasSym: 'USDC',
    gasIsStable: true,
    gasFaucet: 'https://faucet.circle.com',
    stableFaucetUrl: 'https://faucet.circle.com',
    // Circle's faucet gives 20 test USDC every two hours, so the practice circle is sized to fit in one drip.
    practiceContribution: 1_000_000n,
    botGas: parseEther('0.1'),
    visitorFundsBots: true,
    practiceRound: 60,
    pollMs: 1500,
    tagline: 'Savings circles on Arc · USDC',
    showcase: ARC_SHOWCASE,
    verified: true,
  },
};

// Anvil's base fee is far above Robinhood Chain's, so local practice bots get more gas.
const LOCAL: Net = { ...NETS[46630], gasFaucet: undefined, botGas: parseEther('0.01'), pollMs: 2000, tagline: 'Savings circles · local chain' };

export function net(chainId: number): Net {
  return NETS[chainId] ?? LOCAL;
}
