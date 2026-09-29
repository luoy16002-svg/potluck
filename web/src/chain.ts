import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com/rpc'] } },
  blockExplorers: { default: { name: 'Explorer', url: 'https://explorer.testnet.chain.robinhood.com' } },
  testnet: true,
});

export const localChain = defineChain({
  id: 31337,
  name: 'Local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
  testnet: true,
});

export type Deployment = { factory: Address; reputation: Address; usdg: Address; block: number };

const files = import.meta.glob('../../deployments/*.json', { eager: true, import: 'default' }) as Record<
  string,
  Deployment
>;
export const deployments: Record<number, Deployment> = {};
for (const [path, d] of Object.entries(files)) {
  const id = Number(path.split('/').pop()!.replace('.json', ''));
  deployments[id] = d;
}

const allChains: Chain[] = [arbitrumSepolia, robinhoodTestnet, localChain];
export const chains = allChains.filter(
  (c) => deployments[c.id] && (c.id !== localChain.id || location.hostname === 'localhost' || location.hostname === '127.0.0.1'),
);

export function chainById(id: number): Chain {
  return allChains.find((c) => c.id === id) ?? chains[0];
}

const publicClients = new Map<number, PublicClient>();
export function publicClient(chain: Chain): PublicClient {
  if (!publicClients.has(chain.id)) {
    publicClients.set(chain.id, createPublicClient({ chain, transport: http(undefined, { retryCount: 6, retryDelay: 800 }) }) as PublicClient);
  }
  return publicClients.get(chain.id)!;
}

declare global {
  interface Window {
    ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown>; on?: (e: string, f: (...a: unknown[]) => void) => void };
  }
}

/** Local demo accounts (Anvil's well-known test keys) so flows can be recorded without a browser wallet. */
const DEMO_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
] as const;

export function demoAccountIndex(): number | null {
  const m = location.search.match(/demo=(\d)/);
  return m ? Number(m[1]) : null;
}

export async function connectWallet(chain: Chain): Promise<{ wallet: WalletClient; account: Address }> {
  const demo = demoAccountIndex();
  // Recording mode: Anvil keys on the local chain, or keys from web/.env.local (never committed, dev server only)
  // on a testnet, so product walkthroughs can be captured without a browser wallet.
  const envKeys = ((import.meta.env.VITE_DEMO_KEYS as string | undefined) ?? '').split(',').filter(Boolean) as `0x${string}`[];
  const key = demo === null ? null : chain.id === localChain.id ? DEMO_KEYS[demo] : import.meta.env.DEV ? envKeys[demo] : null;
  if (key) {
    const account = privateKeyToAccount(key);
    return { wallet: createWalletClient({ account, chain, transport: http() }), account: account.address };
  }
  if (!window.ethereum) throw new Error('No browser wallet found. Install MetaMask or Rabby to continue.');
  const [account] = (await window.ethereum.request({ method: 'eth_requestAccounts' })) as Address[];
  const hexId = `0x${chain.id.toString(16)}`;
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
  } catch {
    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hexId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
          blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : [],
        },
      ],
    });
  }
  return { wallet: createWalletClient({ account, chain, transport: custom(window.ethereum) }), account };
}

export function explorerTx(chain: Chain, hash: string): string | null {
  return chain.blockExplorers ? `${chain.blockExplorers.default.url}/tx/${hash}` : null;
}

export function explorerAddress(chain: Chain, addr: string): string | null {
  return chain.blockExplorers ? `${chain.blockExplorers.default.url}/address/${addr}` : null;
}
