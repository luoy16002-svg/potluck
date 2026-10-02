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
  stableFaucet: (token: Address, to: Address) => { address: Address; abi: readonly unknown[]; functionName: string; args?: unknown[] };
  stableFaucetLabel: string;
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
};

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
    botGas: parseEther('0.2'),
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
};

const LOCAL: Net = { ...NETS[46630], gasFaucet: undefined, pollMs: 2000, tagline: 'Savings circles · local chain' };

export function net(chainId: number): Net {
  return NETS[chainId] ?? LOCAL;
}
