/**
 * Vaipakam keeper bot — quote orchestrator.
 *
 * Mirror of `ops/hf-watcher/src/serverQuotes.ts` and
 * `frontend/src/lib/swapQuoteService.ts`. Fetches quotes from every
 * configured DEX venue in parallel, ranks by expected output, and
 * returns a ready-to-submit `AdapterCall[]` for the diamond's
 * `triggerLiquidation(loanId, calls)` entry point.
 *
 * Stand-alone: this file has no imports from the wider monorepo.
 * Third-party operators copying ops/keeper-bot out of this repo get a
 * fully self-contained implementation.
 *
 * Adapter slot indices follow the documented production registration
 * order: 0=ZeroEx, 1=OneInch, 2=UniV3, 3=BalancerV2. Operators on
 * chains where one of these isn't deployed should still register a
 * placeholder address so the indices stay stable across chains.
 */

import {
  type Address,
  type Hex,
  type PublicClient,
  encodeAbiParameters,
  encodeFunctionData,
} from 'viem';

export interface QuoteRequest {
  chainId: number;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  taker: Address;
  slippageBps?: number;
}

export interface AdapterCall {
  adapterIdx: bigint;
  data: Hex;
}

export type AdapterKind = 'zeroex' | 'oneinch' | 'univ3' | 'balancerv2';

export interface RankedQuote {
  kind: AdapterKind;
  expectedOutput: bigint;
  call: AdapterCall;
}

export interface OrchestrationResult {
  ranked: RankedQuote[];
  calls: AdapterCall[];
  failed: AdapterKind[];
}

interface ChainSwapMeta {
  uniV3Quoter: Address | null;
  uniV3FeeTiers: readonly number[];
  balancerSubgraphUrl: string | null;
  adapters: { zeroex: number; oneinch: number; univ3: number | null; balancerv2: number };
}

const COMMON_FEE_TIERS = [500, 3000, 10000] as const;

const CHAIN_META: Record<number, ChainSwapMeta> = {
  1: {
    uniV3Quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    uniV3FeeTiers: COMMON_FEE_TIERS,
    balancerSubgraphUrl:
      'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-v2',
    adapters: { zeroex: 0, oneinch: 1, univ3: 2, balancerv2: 3 },
  },
  8453: {
    uniV3Quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    uniV3FeeTiers: COMMON_FEE_TIERS,
    balancerSubgraphUrl:
      'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-base-v2',
    adapters: { zeroex: 0, oneinch: 1, univ3: 2, balancerv2: 3 },
  },
  42161: {
    uniV3Quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    uniV3FeeTiers: COMMON_FEE_TIERS,
    balancerSubgraphUrl:
      'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-arbitrum-v2',
    adapters: { zeroex: 0, oneinch: 1, univ3: 2, balancerv2: 3 },
  },
  10: {
    uniV3Quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    uniV3FeeTiers: COMMON_FEE_TIERS,
    balancerSubgraphUrl:
      'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-optimism-v2',
    adapters: { zeroex: 0, oneinch: 1, univ3: 2, balancerv2: 3 },
  },
  1101: {
    uniV3Quoter: null,
    uniV3FeeTiers: COMMON_FEE_TIERS,
    balancerSubgraphUrl:
      'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-polygon-zk-v2',
    adapters: { zeroex: 0, oneinch: 1, univ3: null, balancerv2: 3 },
  },
  56: {
    uniV3Quoter: null,
    uniV3FeeTiers: COMMON_FEE_TIERS,
    balancerSubgraphUrl: null, // Balancer V2 not deployed on BNB Chain.
    adapters: { zeroex: 0, oneinch: 1, univ3: null, balancerv2: 3 },
  },
};

interface ZeroExResp {
  transaction?: { data?: string };
  buyAmount?: string;
}
interface OneInchResp {
  tx?: { data?: string };
  dstAmount?: string;
  toAmount?: string;
}

export interface OrchestrateInput extends QuoteRequest {
  client: PublicClient;
  zeroExApiKey: string | null;
  oneInchApiKey: string | null;
}

async function fetchZeroEx(
  apiKey: string | null,
  req: QuoteRequest,
  meta: ChainSwapMeta,
): Promise<RankedQuote | null> {
  if (!apiKey) return null;
  const url = new URL('https://api.0x.org/swap/allowance-holder/quote');
  url.searchParams.set('chainId', String(req.chainId));
  url.searchParams.set('sellToken', req.sellToken);
  url.searchParams.set('buyToken', req.buyToken);
  url.searchParams.set('sellAmount', req.sellAmount.toString());
  url.searchParams.set('taker', req.taker);
  url.searchParams.set('slippageBps', String(req.slippageBps ?? 600));
  try {
    const res = await fetch(url.toString(), {
      headers: {
        '0x-api-key': apiKey,
        '0x-version': 'v2',
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as ZeroExResp;
    const data = body.transaction?.data;
    const out = body.buyAmount;
    if (!data?.startsWith('0x') || !out) return null;
    return {
      kind: 'zeroex',
      expectedOutput: BigInt(out),
      call: {
        adapterIdx: BigInt(meta.adapters.zeroex),
        data: data as Hex,
      },
    };
  } catch {
    return null;
  }
}

async function fetchOneInch(
  apiKey: string | null,
  req: QuoteRequest,
  meta: ChainSwapMeta,
): Promise<RankedQuote | null> {
  if (!apiKey) return null;
  const url = new URL(`https://api.1inch.dev/swap/v6.0/${req.chainId}/swap`);
  url.searchParams.set('src', req.sellToken);
  url.searchParams.set('dst', req.buyToken);
  url.searchParams.set('amount', req.sellAmount.toString());
  url.searchParams.set('from', req.taker);
  url.searchParams.set('slippage', String((req.slippageBps ?? 600) / 100));
  url.searchParams.set('disableEstimate', 'true');
  try {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as OneInchResp;
    const data = body.tx?.data;
    const amount = body.dstAmount ?? body.toAmount;
    if (!data?.startsWith('0x') || !amount) return null;
    return {
      kind: 'oneinch',
      expectedOutput: BigInt(amount),
      call: { adapterIdx: BigInt(meta.adapters.oneinch), data: data as Hex },
    };
  } catch {
    return null;
  }
}

const QUOTER_V2_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'quoteExactInputSingle',
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

async function fetchUniV3(
  client: PublicClient,
  req: QuoteRequest,
  meta: ChainSwapMeta,
): Promise<RankedQuote | null> {
  if (!meta.uniV3Quoter || meta.adapters.univ3 == null) return null;
  let best: { fee: number; out: bigint } | null = null;
  for (const fee of meta.uniV3FeeTiers) {
    try {
      const data = encodeFunctionData({
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn: req.sellToken,
            tokenOut: req.buyToken,
            amountIn: req.sellAmount,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      const result = await client.call({ to: meta.uniV3Quoter, data });
      if (!result.data) continue;
      const out = BigInt('0x' + result.data.slice(2, 66));
      if (out > 0n && (!best || out > best.out)) best = { fee, out };
    } catch {
      continue;
    }
  }
  if (!best) return null;
  return {
    kind: 'univ3',
    expectedOutput: best.out,
    call: {
      adapterIdx: BigInt(meta.adapters.univ3),
      data: encodeAbiParameters([{ type: 'uint24' }], [best.fee]) as Hex,
    },
  };
}

async function fetchBalancerV2(
  req: QuoteRequest,
  meta: ChainSwapMeta,
): Promise<RankedQuote | null> {
  if (!meta.balancerSubgraphUrl) return null;
  const sellLower = req.sellToken.toLowerCase();
  const buyLower = req.buyToken.toLowerCase();
  const query = `
    query {
      pools(
        where: {
          tokensList_contains: ["${sellLower}", "${buyLower}"]
          totalLiquidity_gt: "10000"
        }
        orderBy: totalLiquidity
        orderDirection: desc
        first: 1
      ) {
        id
        tokens { address balance decimals }
      }
    }
  `;
  let resJson: unknown;
  try {
    const res = await fetch(meta.balancerSubgraphUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return null;
    resJson = await res.json();
  } catch {
    return null;
  }
  const pools = (resJson as { data?: { pools?: unknown[] } })?.data?.pools;
  if (!Array.isArray(pools) || pools.length === 0) return null;
  const pool = pools[0] as {
    id?: string;
    tokens?: Array<{ address?: string; balance?: string; decimals?: number }>;
  };
  if (!pool.id || !pool.id.startsWith('0x') || pool.id.length < 66) return null;
  const tokens = pool.tokens ?? [];
  const sellEntry = tokens.find(
    (t) => (t.address ?? '').toLowerCase() === sellLower,
  );
  const buyEntry = tokens.find(
    (t) => (t.address ?? '').toLowerCase() === buyLower,
  );
  if (!sellEntry || !buyEntry) return null;
  const sellBal = decimalStringToBigInt(
    sellEntry.balance ?? '0',
    sellEntry.decimals ?? 18,
  );
  const buyBal = decimalStringToBigInt(
    buyEntry.balance ?? '0',
    buyEntry.decimals ?? 18,
  );
  if (sellBal === 0n || buyBal === 0n) return null;
  const out = (req.sellAmount * buyBal) / sellBal;
  if (out === 0n) return null;
  const data = encodeAbiParameters(
    [{ type: 'bytes32' }],
    [pool.id as `0x${string}`],
  ) as Hex;
  return {
    kind: 'balancerv2',
    expectedOutput: out,
    call: { adapterIdx: BigInt(meta.adapters.balancerv2), data },
  };
}

function decimalStringToBigInt(s: string, decimals: number): bigint {
  if (!s) return 0n;
  const trimmed = s.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return 0n;
  const negative = trimmed.startsWith('-');
  const abs = negative ? trimmed.slice(1) : trimmed;
  const dot = abs.indexOf('.');
  const intPart = dot === -1 ? abs : abs.slice(0, dot);
  let fracPart = dot === -1 ? '' : abs.slice(dot + 1);
  if (fracPart.length > decimals) fracPart = fracPart.slice(0, decimals);
  const padded = fracPart.padEnd(decimals, '0');
  try {
    const v = BigInt((intPart + padded) || '0');
    return negative ? -v : v;
  } catch {
    return 0n;
  }
}

export async function orchestrateQuotes(
  input: OrchestrateInput,
): Promise<OrchestrationResult> {
  const meta = CHAIN_META[input.chainId];
  if (!meta) {
    return { ranked: [], calls: [], failed: ['zeroex', 'oneinch', 'univ3', 'balancerv2'] };
  }
  const settled = await Promise.allSettled([
    fetchZeroEx(input.zeroExApiKey, input, meta),
    fetchOneInch(input.oneInchApiKey, input, meta),
    fetchUniV3(input.client, input, meta),
    fetchBalancerV2(input, meta),
  ]);
  const kinds: AdapterKind[] = ['zeroex', 'oneinch', 'univ3', 'balancerv2'];
  const ranked: RankedQuote[] = [];
  const failed: AdapterKind[] = [];
  for (let i = 0; i < settled.length; ++i) {
    const r = settled[i];
    if (r.status === 'fulfilled' && r.value) ranked.push(r.value);
    else failed.push(kinds[i]);
  }
  ranked.sort((a, b) => (b.expectedOutput > a.expectedOutput ? 1 : -1));
  return { ranked, calls: ranked.map((q) => q.call), failed };
}
