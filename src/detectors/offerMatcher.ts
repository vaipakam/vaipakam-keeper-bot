/**
 * Vaipakam keeper bot — Range Orders Phase 1 matching detector.
 *
 * Watches the order book each tick, evaluates every plausible
 * (lender × borrower) pair via the on-chain `previewMatch` view, and
 * submits `matchOffers(lenderId, borrowerId)` for every pair the
 * preview accepts. The matcher EOA earns a 1% kickback of any LIF
 * that flows to treasury — see `OfferFacet._acceptOffer` (lender-asset
 * path, paid synchronously) and `LibVPFIDiscount.{settleBorrower,
 * forfeit}LifProper` (VPFI path, deferred to terminal).
 *
 * Per tick, per chain:
 *   1. Read `getActiveOffersCount` (O(1)) and short-circuit when 0.
 *   2. Page through `getActiveOffersPaginated` to gather all live ids.
 *   3. Hydrate each id via `getOffer(id)` and split into two arrays —
 *      lender offers and borrower offers.
 *   4. Pre-filter by the cheap continuity bucket (`(lendingAsset,
 *      collateralAsset, assetType, collateralAssetType, durationDays)`).
 *      `previewMatch` rejects mismatches anyway, but bucketing cuts
 *      the cartesian to a per-bucket nested loop so we don't pay an
 *      `eth_call` for every (N × M) impossible pair.
 *   5. Within each bucket, call `previewMatch(L, B)` until a pair
 *      returns `errorCode == 0` (Ok).
 *   6. Submit `matchOffers(L, B)`. On revert (lost a race, kill-switch
 *      flipped, etc.) log and move on — next tick will re-evaluate
 *      from fresh state.
 *
 * Per-tick dedupe via a Set keyed on `${lenderId}:${borrowerId}`.
 * When a partial-fill match consumes only part of a lender offer,
 * the offer survives in `activeOfferIdsList` so the next tick's scan
 * picks it up again (with a smaller `lenderRemainingPostMatch`).
 *
 * Master kill-switch: `OfferFacet.matchOffers` reverts with
 * `FunctionDisabled(3)` whenever `s.protocolCfg.partialFillEnabled`
 * is false (the default until governance flips it on). The bot logs
 * the revert once per chain at INFO and keeps polling — when the
 * flag flips, the next tick succeeds without a bot restart.
 */

import {
  type Address,
  type Abi,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { log } from '../log.ts';
import metricsAbi from '../abis/MetricsFacet.json' with { type: 'json' };
import offerCreateAbi from '../abis/OfferCreateFacet.json' with { type: 'json' };
import offerAcceptAbi from '../abis/OfferAcceptFacet.json' with { type: 'json' };
import offerCancelAbi from '../abis/OfferCancelFacet.json' with { type: 'json' };
import offerMatchAbi from '../abis/OfferMatchFacet.json' with { type: 'json' };

// OfferFacet was split for the EIP-170 24,576-byte limit into
// OfferCreateFacet (createOffer + range fields), OfferAcceptFacet
// (acceptOffer), OfferCancelFacet (cancelOffer + getOffer + read views),
// and OfferMatchFacet (matchOffers + previewMatch). Merge every half
// here so viem can resolve every selector this detector calls against
// the diamond. The previously-imported legacy combined
// `OfferFacet.json` was deleted alongside the #227 rename housekeeping
// — the monorepo hasn't exported it since the split landed.
const MATCHER_ABI: Abi = [
  ...(metricsAbi as Abi),
  ...(offerCreateAbi as Abi),
  ...(offerAcceptAbi as Abi),
  ...(offerCancelAbi as Abi),
  ...(offerMatchAbi as Abi),
];

/** Pagination size when scanning `getActiveOffersPaginated`. Same
 *  bound the liquidation scan uses for `getActiveLoansPaginated`. */
const SCAN_PAGE = 200n;

/** Per-tick cap on `previewMatch` calls. Each pair is one `eth_call`;
 *  10k worth of cartesian is hours of RPC on a single chain. The cap
 *  is a safety net — bucketing usually keeps the real count well
 *  under this. */
const MAX_PREVIEW_CALLS_PER_TICK = 2000;

/** Per-tick cap on `matchOffers` submissions. Matches are
 *  permissionless and any one of them can race other operators —
 *  cap submissions per tick so a busy book doesn't burn the keeper's
 *  whole gas budget in one minute. */
const MAX_SUBMITS_PER_TICK = 25;

/** Per-chain wall-time budget. `submitMatch` awaits
 *  `waitForTransactionReceipt` (up to ~30 s per match post-borrower-
 *  partial-fill); a sequential `runOfferMatcherTick` over a single
 *  chain can spend `MAX_SUBMITS_PER_TICK × 30 s` ≈ 12.5 min on a
 *  congested chain. The bot's per-chain ticks are independent today,
 *  but a sequential or batched runner driving multiple chains could
 *  see one congested chain starve the others. 90 s leaves headroom
 *  for ~3 multi-chain ticks within a 5-min cron envelope (mirroring
 *  the Workers-side budget in `apps/keeper/src/matcher.ts`). */
const PER_CHAIN_WALL_TIME_BUDGET_MS = 90_000;

/** Mirrors `LibOfferMatch.MatchError`. Index 0 == Ok. */
const MATCH_ERR_OK = 0;
/** Mirrors `LibOfferMatch.MatchError.SelfTrade` (vaipakam #234). The
 *  contract-side load-bearing gate is `SelfTradeForbidden(party)` in
 *  `OfferAcceptFacet._acceptOffer`; `previewMatch` returns this
 *  variant when `L.creator == B.creator`. Numeric value 11 — the
 *  variant is the 12th in the enum (after `LtvAboveTier`). */
const MATCH_ERR_SELF_TRADE = 11;

/** Mirrors `LibVaipakam.OfferType`. */
const OFFER_TYPE_LENDER = 0;
const OFFER_TYPE_BORROWER = 1;

/** Subset of the `Offer` struct fields we actually need for matching.
 *  `getOffer` returns the full struct; we destructure on read. */
interface OfferLite {
  id: bigint;
  creator: Address;
  offerType: number;
  accepted: boolean;
  assetType: number;
  collateralAssetType: number;
  lendingAsset: Address;
  collateralAsset: Address;
  durationDays: bigint;
}

/** Bucket key for pre-filtering candidate pairs by hard continuity
 *  invariants `previewMatch` would otherwise reject inline. */
function bucketKey(o: OfferLite): string {
  return [
    o.lendingAsset.toLowerCase(),
    o.collateralAsset.toLowerCase(),
    o.assetType,
    o.collateralAssetType,
    o.durationDays.toString(),
  ].join('|');
}

/** Decode the raw `getOffer` tuple return into the lite shape. viem
 *  surfaces a tuple's components as a plain object keyed on field
 *  name when the ABI carries names. We narrow to the fields the
 *  matcher cares about. */
function liftOffer(raw: Record<string, unknown>): OfferLite {
  return {
    id: BigInt(raw['id'] as bigint | number),
    creator: raw['creator'] as Address,
    offerType: Number(raw['offerType']),
    accepted: Boolean(raw['accepted']),
    assetType: Number(raw['assetType']),
    collateralAssetType: Number(raw['collateralAssetType']),
    lendingAsset: raw['lendingAsset'] as Address,
    collateralAsset: raw['collateralAsset'] as Address,
    durationDays: BigInt(raw['durationDays'] as bigint | number),
  };
}

interface MatchPreview {
  errorCode: number;
  matchAmount: bigint;
  matchRateBps: bigint;
  reqCollateral: bigint;
  lenderRemainingPostMatch: bigint;
}

/** Tracks the `FunctionDisabled(3)` kill-switch state per chain so
 *  we log it at most once per session per chain. Flipped back to
 *  false on the first non-disabled response so a governance flip
 *  re-arms the log on the next disable. */
const killSwitchLogged = new Map<number, boolean>();

interface MatcherCtx {
  chainId: number;
  diamond: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

/** Enumerate every live offer id on this chain (paginated). */
async function listActiveOfferIds(ctx: MatcherCtx): Promise<bigint[]> {
  let total: bigint;
  try {
    total = (await ctx.publicClient.readContract({
      address: ctx.diamond,
      abi: MATCHER_ABI,
      functionName: 'getActiveOffersCount',
    })) as bigint;
  } catch (err) {
    log.warn('matcher.offers.count.failed', {
      chain: ctx.chainId,
      err: String(err).slice(0, 200),
    });
    return [];
  }
  if (total === 0n) return [];

  const ids: bigint[] = [];
  for (let offset = 0n; offset < total; offset += SCAN_PAGE) {
    try {
      const page = (await ctx.publicClient.readContract({
        address: ctx.diamond,
        abi: MATCHER_ABI,
        functionName: 'getActiveOffersPaginated',
        args: [offset, SCAN_PAGE],
      })) as readonly bigint[];
      for (const id of page) ids.push(id);
      if (page.length < Number(SCAN_PAGE)) break;
    } catch (err) {
      log.warn('matcher.offers.page.failed', {
        chain: ctx.chainId,
        offset: Number(offset),
        err: String(err).slice(0, 200),
      });
      break;
    }
  }
  return ids;
}

/** Hydrate the lite-shape struct for every id, in parallel batches.
 *  Bad reads are skipped silently — a cancelled-mid-tick offer is
 *  expected to occasionally fail here and shouldn't kill the loop. */
async function hydrateOffers(
  ctx: MatcherCtx,
  ids: readonly bigint[],
): Promise<OfferLite[]> {
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const raw = (await ctx.publicClient.readContract({
          address: ctx.diamond,
          abi: MATCHER_ABI,
          functionName: 'getOffer',
          args: [id],
        })) as Record<string, unknown>;
        return liftOffer(raw);
      } catch (err) {
        log.debug('matcher.getOffer.failed', {
          chain: ctx.chainId,
          offerId: Number(id),
          err: String(err).slice(0, 150),
        });
        return null;
      }
    }),
  );
  return results.filter((o): o is OfferLite => o !== null && !o.accepted);
}

/** Bucket lender vs borrower offers by the continuity key. */
function partitionByBucket(offers: readonly OfferLite[]): {
  lenders: Map<string, OfferLite[]>;
  borrowers: Map<string, OfferLite[]>;
} {
  const lenders = new Map<string, OfferLite[]>();
  const borrowers = new Map<string, OfferLite[]>();
  for (const o of offers) {
    const key = bucketKey(o);
    const target =
      o.offerType === OFFER_TYPE_LENDER
        ? lenders
        : o.offerType === OFFER_TYPE_BORROWER
          ? borrowers
          : null;
    if (!target) continue;
    let bucket = target.get(key);
    if (!bucket) {
      bucket = [];
      target.set(key, bucket);
    }
    bucket.push(o);
  }
  return { lenders, borrowers };
}

/** Call `previewMatch` and unwrap the tuple. Returns null on RPC
 *  error so the caller can move on to the next pair. */
async function previewMatch(
  ctx: MatcherCtx,
  lenderId: bigint,
  borrowerId: bigint,
): Promise<MatchPreview | null> {
  try {
    const raw = (await ctx.publicClient.readContract({
      address: ctx.diamond,
      abi: MATCHER_ABI,
      functionName: 'previewMatch',
      args: [lenderId, borrowerId],
    })) as Record<string, unknown>;
    return {
      errorCode: Number(raw['errorCode']),
      matchAmount: BigInt(raw['matchAmount'] as bigint | number),
      matchRateBps: BigInt(raw['matchRateBps'] as bigint | number),
      reqCollateral: BigInt(raw['reqCollateral'] as bigint | number),
      lenderRemainingPostMatch: BigInt(
        raw['lenderRemainingPostMatch'] as bigint | number,
      ),
    };
  } catch (err) {
    log.debug('matcher.previewMatch.failed', {
      chain: ctx.chainId,
      lenderId: Number(lenderId),
      borrowerId: Number(borrowerId),
      err: String(err).slice(0, 150),
    });
    return null;
  }
}

/** Submit `matchOffers` AND wait for inclusion before returning. The
 *  receipt wait is load-bearing: without it, the matcher tick's inner
 *  loop continues immediately and the next `previewMatch` reads `latest`
 *  state that doesn't include the just-broadcast tx's effects.
 *  Subsequent (L,B) pairs then evaluate against PRE-match lender
 *  capacity, queue up multiple matches against the SAME unallocated
 *  balance, and most of them revert when mined — burning gas AND
 *  wasting `MAX_SUBMITS_PER_TICK` slots that should go to valid pairs.
 *
 *  Returns true ONLY on `receipt.status === 'success'`. Broadcast
 *  failures, on-chain reverts, and receipt-wait timeouts are all
 *  logged and surface as `false` — caller breaks the inner loop on
 *  failure because the lender's state has moved beyond what
 *  previewMatch predicted. */
async function submitMatch(
  ctx: MatcherCtx,
  lenderId: bigint,
  borrowerId: bigint,
  preview: MatchPreview,
): Promise<boolean> {
  const account = ctx.walletClient.account;
  if (!account) return false;

  let hash: Hex;
  try {
    hash = await ctx.walletClient.writeContract({
      address: ctx.diamond,
      abi: MATCHER_ABI,
      functionName: 'matchOffers',
      args: [lenderId, borrowerId],
      account,
      chain: ctx.walletClient.chain,
    });
  } catch (err) {
    const errStr = String(err);
    // FunctionDisabled(3) = 0x96624a75 — the partialFillEnabled
    // master kill-switch path. Log once per chain so we don't spam
    // the operator's console while the protocol's flag is still off.
    if (errStr.includes('FunctionDisabled') || errStr.includes('0x96624a75')) {
      if (!killSwitchLogged.get(ctx.chainId)) {
        log.info('matcher.disabled', {
          chain: ctx.chainId,
          note: 'partialFillEnabled master flag is off; matcher will retry on every tick',
        });
        killSwitchLogged.set(ctx.chainId, true);
      }
    } else {
      log.info('matcher.submit.failed', {
        chain: ctx.chainId,
        lenderId: Number(lenderId),
        borrowerId: Number(borrowerId),
        err: errStr.slice(0, 200),
      });
    }
    return false;
  }

  // 30 s timeout per match — bounded by chain block time × small
  // constant. Worst-case tick duration: MAX_SUBMITS_PER_TICK × ~block,
  // bounded by `PER_CHAIN_WALL_TIME_BUDGET_MS` at the caller.
  try {
    const receipt = await ctx.publicClient.waitForTransactionReceipt({
      hash,
      timeout: 30_000,
    });
    if (receipt.status !== 'success') {
      // On-chain revert — another matcher / a borrower cancel / a
      // governance flip raced us between preview and inclusion. Log
      // it; caller breaks the inner loop on `false`.
      log.info('matcher.submit.reverted', {
        chain: ctx.chainId,
        lenderId: Number(lenderId),
        borrowerId: Number(borrowerId),
        tx: hash,
      });
      return false;
    }
  } catch (err) {
    // Timeout (tx dropped from mempool or RPC slow) — assume in-flight
    // and back off this lender for the tick.
    log.info('matcher.submit.receiptTimeout', {
      chain: ctx.chainId,
      lenderId: Number(lenderId),
      borrowerId: Number(borrowerId),
      tx: hash,
      err: String(err).slice(0, 200),
    });
    return false;
  }

  log.info('matcher.submit.ok', {
    chain: ctx.chainId,
    lenderId: Number(lenderId),
    borrowerId: Number(borrowerId),
    tx: hash,
    matchAmount: preview.matchAmount.toString(),
    matchRateBps: Number(preview.matchRateBps),
    lenderRemaining: preview.lenderRemainingPostMatch.toString(),
  });
  return true;
}

/** One pass over the chain's order book — see module docstring for
 *  the full step-by-step contract. */
export async function runOfferMatcherTick(ctx: MatcherCtx): Promise<void> {
  const ids = await listActiveOfferIds(ctx);
  if (ids.length === 0) {
    log.debug('matcher.tick.empty', { chain: ctx.chainId });
    return;
  }
  const offers = await hydrateOffers(ctx, ids);
  const { lenders, borrowers } = partitionByBucket(offers);

  log.debug('matcher.tick.start', {
    chain: ctx.chainId,
    activeOffers: offers.length,
    lenderBuckets: lenders.size,
    borrowerBuckets: borrowers.size,
  });

  // Reset the kill-switch flag opportunistically — a previous tick
  // may have logged it. The flag's only purpose is to throttle the
  // log line; resetting on every tick is fine.
  killSwitchLogged.set(ctx.chainId, killSwitchLogged.get(ctx.chainId) ?? false);

  // Bound the chain's wall-time so a congested chain can't starve any
  // sibling work in the same scheduler tick. Each loop level checks
  // `overBudget()` before doing more work.
  const tickStart = Date.now();
  const overBudget = () =>
    Date.now() - tickStart > PER_CHAIN_WALL_TIME_BUDGET_MS;

  let previewCalls = 0;
  let submits = 0;
  const attempted = new Set<string>();

  // Walk only buckets that have offers on BOTH sides — every other
  // bucket can never produce a valid match and isn't worth a single
  // RPC call.
  for (const [key, lenderList] of lenders) {
    if (submits >= MAX_SUBMITS_PER_TICK) break;
    if (overBudget()) break;
    const borrowerList = borrowers.get(key);
    if (!borrowerList || borrowerList.length === 0) continue;

    for (const L of lenderList) {
      if (submits >= MAX_SUBMITS_PER_TICK) break;
      if (overBudget()) break;
      for (const B of borrowerList) {
        if (previewCalls >= MAX_PREVIEW_CALLS_PER_TICK) break;
        if (submits >= MAX_SUBMITS_PER_TICK) break;
        if (overBudget()) break;
        const pairKey = `${L.id}:${B.id}`;
        if (attempted.has(pairKey)) continue;
        attempted.add(pairKey);

        // vaipakam #235 — self-trade short-circuit. Same-creator pairs
        // can never produce a valid loan (the contract reverts
        // `SelfTradeForbidden(party)` in `_acceptOffer`), and
        // `previewMatch` returns `MatchError.SelfTrade`. Skipping them
        // before the RPC roundtrip saves one `eth_call` per
        // colluding-creator pair per tick. Lower-cased compare because
        // `getOffer` returns checksummed addresses.
        if (L.creator.toLowerCase() === B.creator.toLowerCase()) {
          continue;
        }

        previewCalls += 1;
        const p = await previewMatch(ctx, L.id, B.id);
        if (!p) continue;
        // Defence-in-depth: the client-side pre-filter above should
        // catch every same-creator pair. Log here anyway in case the
        // local `getOffer` cache races against an in-flight ownership
        // transfer or a future refactor drops `creator` from
        // `OfferLite`. Other typed errors are too noisy to log
        // per-pair; the observability story for those lives in the
        // per-tick submits / previewCalls counters.
        if (p.errorCode === MATCH_ERR_SELF_TRADE) {
          log.debug('matcher.selfTrade.slippedPreFilter', {
            chainId: ctx.chainId,
            lenderId: L.id.toString(),
            borrowerId: B.id.toString(),
            creator: L.creator,
          });
          continue;
        }
        if (p.errorCode !== MATCH_ERR_OK) continue;

        const ok = await submitMatch(ctx, L.id, B.id, p);
        if (ok) {
          submits += 1;
          // Post borrower-partial-fill (vaipakam #102 / #172), borrower
          // offers are NOT single-fill anymore. Don't break the inner
          // loop on success: the same lender may have remaining capacity
          // to fan-out across additional borrowers in this tick, and the
          // same borrower (post-this match) may still have capacity that
          // a DIFFERENT lender in `lenderList` could fill.
          //
          // The `attempted` set already prevents re-trying the exact
          // (L,B) pair within a tick. After a successful submit, both
          // L's and B's `amountFilled` have grown on-chain (the receipt
          // wait in `submitMatch` guarantees the next read sees the
          // mutation); the next `previewMatch` reads the updated state
          // and returns the right overlap (or `AmountNoOverlap` /
          // dust-close, which the `if (!p || p.errorCode !== Ok)`
          // continue above handles cleanly).
          //
          // Early-exit only when the preview reports the lender is now
          // FULLY filled (`lenderRemainingPostMatch == 0n`). Anything
          // smaller — where the lender still has capacity that might
          // not meet the per-match minimum — is left to the contract's
          // `previewMatch` to filter on the next iteration; the extra
          // preview call per exhausted lender per tick is cheap relative
          // to fan-out wins on healthy ones.
          if (p.lenderRemainingPostMatch === 0n) {
            break;
          }
          // Otherwise fall through to the next borrower for this lender.
          continue;
        }
        // `submitMatch` returned false. The three causes (broadcast
        // failure, on-chain revert, `waitForTransactionReceipt` timeout)
        // all leave L's state uncertain — the tx may still be in flight,
        // or another matcher / a borrower-cancel raced us. Trying L
        // against B2/B3 in the same tick would re-evaluate against
        // possibly-stale state and either queue duplicate matches (the
        // race the receipt-wait was added to prevent) or burn preview
        // calls on doomed pairs. Back off this lender for the tick —
        // `attempted` already prevents (L,B1) retry, but we need an
        // explicit `break` to skip the rest of the borrower list too.
        break;
      }
    }
  }

  log.debug('matcher.tick.done', {
    chain: ctx.chainId,
    previewCalls,
    submits,
    elapsedMs: Date.now() - tickStart,
  });
  if (overBudget()) {
    log.info('matcher.tick.overBudget', {
      chain: ctx.chainId,
      elapsedMs: Date.now() - tickStart,
      budgetMs: PER_CHAIN_WALL_TIME_BUDGET_MS,
      note: 'wall-time budget exhausted; deferring remaining work to next tick',
    });
  }
}
