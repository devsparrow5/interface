// Source: https://docs.near-intents.org/near-intents/integration/distribution-channels/1click-api

import { zeroAddress, erc20Abi } from 'viem';
import { sendTransaction, writeContract } from 'wagmi/actions';
import { config } from '../../../WalletProvider';
import { chainsMap } from '../../constants';

export const chainToId = {
	ethereum: 'eth',
	arbitrum: 'arb',
	base: 'base',
	optimism: 'op',
	polygon: 'pol',
	bsc: 'bsc',
	avax: 'avax',
	gnosis: 'gnosis'
};

export const name = 'NEAR Intents';
export const token = 'NEAR';
export const referral = true;

export function approvalAddress() {
	return null;
}

const API_BASE = 'https://1click.chaindefuser.com';
const nativeToken = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

interface TokenInfo {
	assetId: string;
	decimals: number;
	blockchain: string;
	symbol: string;
	price: number;
	contractAddress?: string;
}

let tokensCache: TokenInfo[] | null = null;
let tokensCacheTime = 0;

const CACHE_TTL = 60_000;
const POLL_INTERVAL = 5_000;
const POLL_INITIAL_DELAY = 10_000;
const MAX_POLL_ATTEMPTS = 120;
const DEADLINE_MINUTES = 30;

async function getTokens(): Promise<TokenInfo[]> {
	const now = Date.now();
	if (tokensCache && now - tokensCacheTime < CACHE_TTL) {
		return tokensCache;
	}

	const response = await fetch(`${API_BASE}/v0/tokens`);
	if (!response.ok) {
		throw new Error('Failed to fetch 1Click tokens');
	}

	tokensCache = await response.json();
	tokensCacheTime = now;
	return tokensCache!;
}

function isNativeToken(address: string): boolean {
	return address === zeroAddress || address.toLowerCase() === nativeToken.toLowerCase();
}

function findToken(chain: string, tokenAddress: string, tokens: TokenInfo[]): TokenInfo | null {
	const blockchain = chainToId[chain];
	if (!blockchain) return null;

	const isNative = isNativeToken(tokenAddress);

	return (
		tokens.find((t) => {
			if (t.blockchain !== blockchain) return false;
			if (isNative) return !t.contractAddress;
			return t.contractAddress?.toLowerCase() === tokenAddress.toLowerCase();
		}) ?? null
	);
}

const waitForOrder =
	({ depositAddress }) =>
	(onSuccess) => {
		let attempts = 0;

		const poll = async () => {
			if (attempts >= MAX_POLL_ATTEMPTS) return;
			attempts++;

			try {
				const response = await fetch(`${API_BASE}/v0/status?depositAddress=${depositAddress}`);
				if (!response.ok) {
					setTimeout(poll, POLL_INTERVAL);
					return;
				}

				const status = await response.json();

				if (status.status === 'SUCCESS') {
					onSuccess();
					return;
				}

				if (status.status === 'FAILED' || status.status === 'REFUNDED') {
					return;
				}

				setTimeout(poll, POLL_INTERVAL);
			} catch {
				setTimeout(poll, POLL_INTERVAL);
			}
		};

		setTimeout(poll, POLL_INITIAL_DELAY);
	};

export async function getQuote(chain: string, from: string, to: string, amount: string, extra) {
	const tokens = await getTokens();

	const fromToken = findToken(chain, from, tokens);
	const toToken = findToken(chain, to, tokens);

	if (!fromToken || !toToken) {
		return null;
	}

	const userAddr = extra.userAddress?.toLowerCase() ?? zeroAddress;
	const isDryRun = !extra.userAddress || extra.userAddress === zeroAddress;
	const slippageBps = Math.round(Number(extra.slippage || 1) * 100);

	const quoteRequest = {
		dry: isDryRun,
		swapType: 'EXACT_INPUT',
		slippageTolerance: slippageBps,
		originAsset: fromToken.assetId,
		destinationAsset: toToken.assetId,
		amount,
		depositType: 'ORIGIN_CHAIN',
		refundTo: isDryRun ? zeroAddress : userAddr,
		refundType: 'ORIGIN_CHAIN',
		recipient: isDryRun ? zeroAddress : userAddr,
		recipientType: 'DESTINATION_CHAIN',
		deadline: new Date(Date.now() + DEADLINE_MINUTES * 60 * 1000).toISOString(),
		referral: 'llamaswap'
	};

	const response = await fetch(`${API_BASE}/v0/quote`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(quoteRequest)
	});

	if (!response.ok) {
		return null;
	}

	const quote = await response.json();

	if (!quote?.quote?.amountOut) {
		return null;
	}

	return {
		amountReturned: quote.quote.amountOut,
		amountIn: quote.quote.amountIn || '0',
		estimatedGas: 21000,
		tokenApprovalAddress: null,
		rawQuote: {
			...quote,
			fromToken,
			toToken,
			chain,
			fromAddress: from,
			userAddress: extra.userAddress
		},
		logo: 'https://assets.coingecko.com/coins/images/10365/small/near.jpg',
		isMEVSafe: true
	};
}

export async function swap({ chain, rawQuote, from }) {
	const depositAddress = rawQuote.quote.depositAddress;
	const amount = rawQuote.quote.amountIn;

	if (!depositAddress) {
		throw { reason: 'No deposit address. Please refresh quote.' };
	}

	const isNative = isNativeToken(from);
	let txHash: string;

	if (isNative) {
		txHash = await sendTransaction(config, {
			to: depositAddress as `0x${string}`,
			value: BigInt(amount),
			chainId: chainsMap[chain]
		});
	} else {
		txHash = await writeContract(config, {
			address: from as `0x${string}`,
			abi: erc20Abi,
			functionName: 'transfer',
			args: [depositAddress as `0x${string}`, BigInt(amount)],
			chainId: chainsMap[chain]
		});
	}

	// Notify API of deposit (non-critical)
	fetch(`${API_BASE}/v0/deposit`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ txHash, depositAddress })
	}).catch(() => {});

	return {
		hash: txHash,
		waitForOrder: waitForOrder({ depositAddress })
	};
}

export const getTxData = () => '';

export const getTx = ({ rawQuote }) => {
	if (!rawQuote?.quote?.depositAddress) {
		return {};
	}

	const isNative = isNativeToken(rawQuote.fromAddress);

	if (isNative) {
		return {
			to: rawQuote.quote.depositAddress,
			value: rawQuote.quote.amountIn
		};
	}

	return {
		to: rawQuote.fromAddress,
		data: '',
		value: '0'
	};
};
