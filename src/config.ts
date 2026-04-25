/**
 * Vaipakam keeper bot — configuration parser.
 *
 * Reads .env via `dotenv`, validates structure, and produces a
 * typed `BotConfig` for the rest of the codebase. Fails LOUD at
 * startup on malformed input — the bot operates with the keeper's
 * private key and gas budget, so silent fallback to bad defaults is
 * worse than a clear startup crash.
 */

import 'dotenv/config';
import { isAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface ChainConfig {
  chainId: number;
  diamond: Address;
  rpcUrl: string;
  /** Optional whitelist of loan IDs to monitor on this chain. Empty
   *  = "all active loans" (heavier RPC load). */
  loanIds: number[] | null;
}

export interface BotConfig {
  keeperKey: Hex;
  /** Computed keeper EOA address from the private key. */
  keeperAddress: Address;
  chains: readonly ChainConfig[];
  zeroExApiKey: string | null;
  oneInchApiKey: string | null;
  pollIntervalSeconds: number;
  slippageBps: number;
  minProfitUsd8Dec: bigint;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

class ConfigError extends Error {}

function reqString(key: string): string {
  const v = process.env[key];
  if (v == null || v.trim() === '') {
    throw new ConfigError(`Missing required env var: ${key}`);
  }
  return v.trim();
}

function optString(key: string): string | null {
  const v = process.env[key];
  if (v == null || v.trim() === '') return null;
  return v.trim();
}

function parseLogLevel(s: string): BotConfig['logLevel'] {
  switch (s.toLowerCase()) {
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
      return s.toLowerCase() as BotConfig['logLevel'];
    default:
      throw new ConfigError(
        `LOG_LEVEL must be one of debug|info|warn|error, got: ${s}`,
      );
  }
}

export function loadConfig(): BotConfig {
  const keeperKey = reqString('KEEPER_PRIVATE_KEY');
  if (!keeperKey.startsWith('0x') || keeperKey.length !== 66) {
    throw new ConfigError(
      'KEEPER_PRIVATE_KEY must be 0x-prefixed 32-byte hex string',
    );
  }
  // viem's privateKeyToAccount is in `viem/accounts` — imported in
  // index.ts. The config layer just keeps the raw key + types.

  const chainIdsRaw = reqString('CHAIN_IDS');
  const chainIds = chainIdsRaw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (chainIds.length === 0) {
    throw new ConfigError('CHAIN_IDS must list at least one positive integer');
  }

  const chains: ChainConfig[] = chainIds.map((id) => {
    const diamond = reqString(`CHAIN_${id}_DIAMOND`);
    if (!isAddress(diamond)) {
      throw new ConfigError(
        `CHAIN_${id}_DIAMOND is not a valid address: ${diamond}`,
      );
    }
    const rpcUrl = reqString(`CHAIN_${id}_RPC_URL`);
    if (!/^https?:\/\//.test(rpcUrl)) {
      throw new ConfigError(
        `CHAIN_${id}_RPC_URL must be http(s) URL: ${rpcUrl}`,
      );
    }
    const loanIdsRaw = optString(`CHAIN_${id}_LOAN_IDS`);
    let loanIds: number[] | null = null;
    if (loanIdsRaw) {
      loanIds = loanIdsRaw
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 0);
      if (loanIds.length === 0) loanIds = null;
    }
    return {
      chainId: id,
      diamond: diamond as Address,
      rpcUrl,
      loanIds,
    };
  });

  const pollIntervalSeconds = Number(process.env.POLL_INTERVAL_SECONDS ?? '60');
  if (
    !Number.isInteger(pollIntervalSeconds) ||
    pollIntervalSeconds < 5 ||
    pollIntervalSeconds > 3600
  ) {
    throw new ConfigError(
      'POLL_INTERVAL_SECONDS must be integer in [5, 3600]',
    );
  }

  const slippageBps = Number(process.env.SLIPPAGE_BPS ?? '600');
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > 10_000
  ) {
    throw new ConfigError('SLIPPAGE_BPS must be integer in [0, 10000]');
  }

  const minProfitUsd8DecRaw = process.env.MIN_PROFIT_USD_8DEC ?? '0';
  let minProfitUsd8Dec: bigint;
  try {
    minProfitUsd8Dec = BigInt(minProfitUsd8DecRaw);
  } catch {
    throw new ConfigError(
      `MIN_PROFIT_USD_8DEC must be parseable as bigint: ${minProfitUsd8DecRaw}`,
    );
  }

  const logLevel = parseLogLevel(process.env.LOG_LEVEL ?? 'info');

  // Compute keeper address eagerly so startup logs can show it.
  const account = privateKeyToAccount(keeperKey as Hex);

  return {
    keeperKey: keeperKey as Hex,
    keeperAddress: account.address,
    chains,
    zeroExApiKey: optString('ZEROEX_API_KEY'),
    oneInchApiKey: optString('ONEINCH_API_KEY'),
    pollIntervalSeconds,
    slippageBps,
    minProfitUsd8Dec,
    logLevel,
  };
}
