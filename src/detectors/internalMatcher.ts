/**
 * Vaipakam keeper bot — internal-liquidation match detector.
 *
 * Companion to `offerMatcher.ts`. Per tick:
 *   1. Read `getInternalMatchConfigBundle()` — short-circuit when the
 *      kill-switch is off (no log, no work).
 *   2. Page through `getMatchEligibleLoans(minLtvBps, maxLtvBps,
 *      startIdx, pageSize)` to gather every active loan whose
 *      current LTV is at or above its snapshotted per-tier
 *      liquidation threshold.
 *   3. Hydrate each ID via `getLoanDetails(loanId)` to get the
 *      principal/collateral asset directions + current sizes.
 *   4. Bucket by `(principalAsset, collateralAsset)` and pair each
 *      bucket with its opposing `(collateralAsset, principalAsset)`
 *      bucket — every (A, B) where the assets cross-clear.
 *   5. Submit `triggerInternalMatchLiquidation(loanIdA, loanIdB, 0)`
 *      for each candidate pair. Match fee (1% per leg by default)
 *      lands in the bot's wallet synchronously on success — see
 *      `RiskFacet._settleLeg`.
 *
 * Three-way A→B→C→A chain matching (PR5.5 on-chain support) is
 * tracked but the bot only does 2-way today. A future tick can
 * extend with a second pass over leftover loans that didn't pair
 * up 2-way.
 *
 * Per-tick caps on RPC reads + submit count keep gas predictable.
 * Master kill-switch detection mirrors the offerMatcher pattern:
 * the entry point's `InternalMatchDisabled` revert is logged at
 * most once per chain per session.
 */

import {
  type Address,
  type Abi,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { log } from '../log.ts';
import configAbi from '../abis/ConfigFacet.json' with { type: 'json' };
import loanAbi from '../abis/LoanFacet.json' with { type: 'json' };
import metricsAbi from '../abis/MetricsFacet.json' with { type: 'json' };
import riskAbi from '../abis/RiskFacet.json' with { type: 'json' };

const DETECTOR_ABI: Abi = [
  ...(configAbi as Abi),
  ...(loanAbi as Abi),
  ...(metricsAbi as Abi),
  ...(riskAbi as Abi),
];

/** Pagination chunk on `getMatchEligibleLoans`. The view performs
 *  one `RiskFacet.calculateLTV` per row inside its try/catch, so
 *  pages of 200 stay comfortably under the public-RPC gas cap. */
const SCAN_PAGE = 200n;

/** Per-tick cap on `triggerInternalMatchLiquidation` submissions.
 *  Each tx is a real swap — limit so a busy chain doesn't blow the
 *  keeper's per-minute gas budget. */
const MAX_SUBMITS_PER_TICK = 10;

/** LoanStatus enum values from `LibVaipakam.LoanStatus`. EC-003
 *  Phase 4 widened the matchable set from `{Active}` to
 *  `{Active, FallbackPending}` — loans whose at-fallback liquidation
 *  failed transiently (slippage > 6%, DEX revert, oracle stale at
 *  that moment) are rescuable via internal match in a later block.
 *  The on-chain `triggerInternalMatchLiquidation` gate enforces the
 *  same set; this constant pair keeps the off-chain hydration filter
 *  in sync. */
const LOAN_STATUS_ACTIVE = 0;
const LOAN_STATUS_FALLBACK_PENDING = 4;

/** True iff the loan status is in the EC-003 matchable set. */
function isMatchableStatus(status: number): boolean {
  return status === LOAN_STATUS_ACTIVE || status === LOAN_STATUS_FALLBACK_PENDING;
}

/** Subset of the `Loan` struct fields needed for matching. */
interface LoanLite {
  id: bigint;
  status: number;
  lender: Address;
  borrower: Address;
  principalAsset: Address;
  collateralAsset: Address;
  principal: bigint;
  collateralAmount: bigint;
}

/** Hydrate `getLoanDetails` raw tuple into the lite shape. viem
 *  returns named struct fields as a plain object. */
function liftLoan(raw: Record<string, unknown>): LoanLite {
  return {
    id: BigInt(raw['id'] as bigint | number),
    status: Number(raw['status']),
    lender: raw['lender'] as Address,
    borrower: raw['borrower'] as Address,
    principalAsset: raw['principalAsset'] as Address,
    collateralAsset: raw['collateralAsset'] as Address,
    principal: BigInt(raw['principal'] as bigint | number),
    collateralAmount: BigInt(raw['collateralAmount'] as bigint | number),
  };
}

/** Bucket key for opposing-pair lookup. Loans with the same
 *  `(principalAsset, collateralAsset)` go in one bucket; their
 *  match partners live in the inverted-key bucket. */
function bucketKey(principal: Address, collateral: Address): string {
  return `${principal.toLowerCase()}|${collateral.toLowerCase()}`;
}

function inverseKey(principal: Address, collateral: Address): string {
  return `${collateral.toLowerCase()}|${principal.toLowerCase()}`;
}

/** Tracks the disabled-state per chain so the log fires at most
 *  once per session per chain. */
const killSwitchLogged = new Map<number, boolean>();

interface DetectorCtx {
  chainId: number;
  diamond: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

async function isEnabled(ctx: DetectorCtx): Promise<boolean> {
  try {
    const bundle = (await ctx.publicClient.readContract({
      address: ctx.diamond,
      abi: DETECTOR_ABI,
      functionName: 'getInternalMatchConfigBundle',
    })) as readonly [boolean, bigint, bigint];
    const enabled = bundle[0];
    if (!enabled && !killSwitchLogged.get(ctx.chainId)) {
      log.info('internalMatcher.disabled', {
        chain: ctx.chainId,
        note: 'internalMatchEnabled is false — bot will keep polling and resume when governance flips it on',
      });
      killSwitchLogged.set(ctx.chainId, true);
    }
    if (enabled) killSwitchLogged.set(ctx.chainId, false);
    return enabled;
  } catch (err) {
    // Selector not cut (older deploy) — treat as disabled.
    log.warn('internalMatcher.config.read.failed', {
      chain: ctx.chainId,
      err: String(err).slice(0, 200),
    });
    return false;
  }
}

/** Page through `getMatchEligibleLoans` until exhaustion. */
async function listMatchEligible(ctx: DetectorCtx): Promise<bigint[]> {
  const all: bigint[] = [];
  let cursor = 0n;
  for (;;) {
    let page: bigint[];
    let nextIdx: bigint;
    try {
      const result = (await ctx.publicClient.readContract({
        address: ctx.diamond,
        abi: DETECTOR_ABI,
        functionName: 'getMatchEligibleLoans',
        // (minLtvBps, maxLtvBps, startIdx, pageSize). Use the full
        // (0, 10_000) range — every match-eligible loan returned by
        // the view is liquidatable by construction (the view's
        // upstream filter walks active loans and calls calculateLTV).
        args: [0, 10_000, cursor, SCAN_PAGE],
      })) as readonly [readonly bigint[], bigint];
      page = [...result[0]];
      nextIdx = result[1];
    } catch (err) {
      log.warn('internalMatcher.view.paginate.failed', {
        chain: ctx.chainId,
        cursor: cursor.toString(),
        err: String(err).slice(0, 200),
      });
      return all;
    }
    for (const id of page) all.push(id);
    // Two exit conditions: empty page, or view reached the end
    // (nextIdx didn't advance / equals active list length).
    if (page.length === 0 || nextIdx <= cursor) break;
    cursor = nextIdx;
  }
  return all;
}

async function hydrateLoans(
  ctx: DetectorCtx,
  ids: bigint[],
): Promise<LoanLite[]> {
  const out: LoanLite[] = [];
  for (const id of ids) {
    try {
      const raw = (await ctx.publicClient.readContract({
        address: ctx.diamond,
        abi: DETECTOR_ABI,
        functionName: 'getLoanDetails',
        args: [id],
      })) as Record<string, unknown>;
      const lite = liftLoan(raw);
      // EC-003 Phase 4 — accept both Active and FallbackPending. The
      // FallbackPending loans are the rescue opportunity: their
      // at-fallback liquidation failed transiently but the asset is
      // often still priceable. The on-chain oracle-priceable gate in
      // `triggerInternalMatchLiquidation` rejects the genuinely-
      // illiquid ones, so the bot can submit optimistically; the
      // submit-time pre-flight below trims the obviously-doomed ones.
      if (!isMatchableStatus(lite.status)) continue;
      if (lite.principal === 0n || lite.collateralAmount === 0n) continue;
      out.push(lite);
    } catch (err) {
      log.debug('internalMatcher.loan.hydrate.failed', {
        chain: ctx.chainId,
        loanId: id.toString(),
        err: String(err).slice(0, 120),
      });
    }
  }
  return out;
}

async function submitMatch(
  ctx: DetectorCtx,
  a: LoanLite,
  b: LoanLite,
  c: LoanLite | null,
): Promise<boolean> {
  const cId = c ? c.id : 0n;
  try {
    const { request } = await ctx.publicClient.simulateContract({
      address: ctx.diamond,
      abi: DETECTOR_ABI,
      functionName: 'triggerInternalMatchLiquidation',
      args: [a.id, b.id, cId],
      account: ctx.walletClient.account!,
    });
    const hash = await ctx.walletClient.writeContract(request);
    log.info('internalMatcher.submitted', {
      chain: ctx.chainId,
      loanIdA: a.id.toString(),
      loanIdB: b.id.toString(),
      loanIdC: cId.toString(),
      tx: hash,
    });
    return true;
  } catch (err) {
    const msg = String(err).slice(0, 200);
    // Lost a race / revert / kill-switch flipped mid-tick — no
    // need to noise the log. Next tick will re-evaluate.
    log.debug('internalMatcher.submit.failed', {
      chain: ctx.chainId,
      loanIdA: a.id.toString(),
      loanIdB: b.id.toString(),
      loanIdC: cId.toString(),
      err: msg,
    });
    return false;
  }
}

/**
 * Find a 3-loan A→B→C→A cycle starting at `a` that doesn't include
 * any consumed loan. Returns `null` when no cycle is reachable
 * within the current candidate pool.
 *
 * Walks two hops: from `a.collateralAsset` find a loan `b` whose
 * principal is that asset; from `b.collateralAsset` find a loan `c`
 * whose principal is THAT asset AND whose collateral closes the
 * cycle (`c.collateralAsset == a.principalAsset`). O(M × N) on
 * bucket sizes where M = bucket(a.collateralAsset).size and
 * N = bucket(b.collateralAsset).size — at protocol scale, both
 * are small because the depth-tier classification already
 * filters out illiquid pairs.
 *
 * Note the bucket convention here groups by `principalAsset`, not
 * the 2-way `(principal, collateral)` pair — for 3-cycle detection
 * we follow asset edges, not full bucket keys.
 */
function findThreeWayChain(
  a: LoanLite,
  loansByPrincipalAsset: Map<string, LoanLite[]>,
  consumed: Set<bigint>,
): [LoanLite, LoanLite] | null {
  const aPrincipalLower = a.principalAsset.toLowerCase();
  const aCollateralLower = a.collateralAsset.toLowerCase();
  // `b` has principal = a.collateralAsset, i.e., B's debt is in
  // the asset A's borrower forfeits.
  const bCandidates = loansByPrincipalAsset.get(aCollateralLower) ?? [];
  for (const b of bCandidates) {
    if (consumed.has(b.id) || b.id === a.id) continue;
    const bCollateralLower = b.collateralAsset.toLowerCase();
    // Skip the trivial 2-way: A.principal=B.collateral AND
    // B.principal=A.collateral is the 2-way case, already
    // handled in the first pass. The 3-way path needs
    // B.collateral ≠ A.principal (a third asset).
    if (bCollateralLower === aPrincipalLower) continue;
    // `c` has principal = b.collateralAsset AND collateral =
    // a.principalAsset — closes the A → B → C → A cycle.
    const cCandidates = loansByPrincipalAsset.get(bCollateralLower) ?? [];
    for (const c of cCandidates) {
      if (consumed.has(c.id) || c.id === a.id || c.id === b.id) continue;
      if (c.collateralAsset.toLowerCase() === aPrincipalLower) {
        return [b, c];
      }
    }
  }
  return null;
}

/**
 * One tick of internal-match detection on a single chain. Returns
 * the count of successful submissions for the tick (caller may
 * use this for observability / pace adjustments).
 */
export async function runInternalMatcherTick(ctx: DetectorCtx): Promise<number> {
  if (!(await isEnabled(ctx))) return 0;
  const ids = await listMatchEligible(ctx);
  if (ids.length < 2) return 0;
  const loans = await hydrateLoans(ctx, ids);
  if (loans.length < 2) return 0;

  // Bucket by (principalAsset, collateralAsset). For each loan,
  // look up the inverse bucket to find opposing pairs.
  const buckets = new Map<string, LoanLite[]>();
  for (const l of loans) {
    const k = bucketKey(l.principalAsset, l.collateralAsset);
    const bucket = buckets.get(k) ?? [];
    bucket.push(l);
    buckets.set(k, bucket);
  }

  let submits = 0;
  const consumed = new Set<bigint>();

  // First pass — 2-way matches. Highest-value because they're
  // cheaper gas-wise and more common in practice (most opposing
  // pairs are symmetric two-loan pairs, not full 3-cycles).
  for (const l of loans) {
    if (submits >= MAX_SUBMITS_PER_TICK) break;
    if (consumed.has(l.id)) continue;
    const invBucket = buckets.get(inverseKey(l.principalAsset, l.collateralAsset));
    if (!invBucket || invBucket.length === 0) continue;
    for (const partner of invBucket) {
      if (consumed.has(partner.id)) continue;
      if (partner.id === l.id) continue;
      const ok = await submitMatch(ctx, l, partner, null);
      if (ok) {
        consumed.add(l.id);
        consumed.add(partner.id);
        submits++;
      }
      // Move to next l after first successful match to spread
      // matches across pairs (and across the per-tick cap).
      break;
    }
  }

  // Second pass — 3-way A→B→C→A chain matches on whatever didn't
  // pair up 2-way. Group remaining loans by `principalAsset` so
  // the cycle finder can walk asset edges in O(1) per hop.
  if (submits < MAX_SUBMITS_PER_TICK) {
    const loansByPrincipalAsset = new Map<string, LoanLite[]>();
    for (const l of loans) {
      if (consumed.has(l.id)) continue;
      const k = l.principalAsset.toLowerCase();
      const arr = loansByPrincipalAsset.get(k) ?? [];
      arr.push(l);
      loansByPrincipalAsset.set(k, arr);
    }
    for (const a of loans) {
      if (submits >= MAX_SUBMITS_PER_TICK) break;
      if (consumed.has(a.id)) continue;
      const chain = findThreeWayChain(a, loansByPrincipalAsset, consumed);
      if (!chain) continue;
      const [b, c] = chain;
      const ok = await submitMatch(ctx, a, b, c);
      if (ok) {
        consumed.add(a.id);
        consumed.add(b.id);
        consumed.add(c.id);
        submits++;
      }
    }
  }

  if (submits > 0) {
    log.info('internalMatcher.tick.summary', {
      chain: ctx.chainId,
      eligible: loans.length,
      submitted: submits,
    });
  }
  return submits;
}
