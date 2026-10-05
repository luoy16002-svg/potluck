import type { Chain } from 'viem';

/** Production networks hold real money; everything else is a test network. */
export const isLive = (chain: Chain) => !chain.testnet;

/** Short name for the network picker, where a Mainnet or Testnet tag sits next to it. */
export const chainLabel = (chain: Chain) => (chain.id === 5042 ? 'Arc' : chain.name.replace(/ Testnet$/, ''));

/** Full name for headings and sentences ("Arc", "Arc Testnet", "Monad Testnet"). */
export const chainName = (chain: Chain) => (chain.id === 5042 ? 'Arc' : chain.name);
