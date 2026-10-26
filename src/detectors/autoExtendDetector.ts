/**
 * Vaipakam keeper bot — T-092 #518 auto-extend detector.
 *
 * Mirrors the apps/keeper `runAutoLifecycle` pass shipped in the
 * monorepo PR #517. Per tick, per chain:
 *
 *   1. Read `AdminFacet.getAutoExtendEnabled()` — admin kill switch.
 *      Skip chain entirely when off.
 *   2. Read `MetricsFacet.getActiveLoansCount`; short-circuit on 0.
 *   3. Page `getActiveLoansPaginated` for the loan id list.
 *   4. For each loan, read both `getAutoExtendBorrowerCaps(loanId)`
 *      and `getAutoExtendLenderCaps(loanId)`. Each getter applies the
 *      staleness fence — a transferred NFT returns `enabled: false`.
 *   5. When both sides are enabled + fresh, pick `newRateBps` at the
 *      lender's floor (most conservative for the borrower while still
 *      respecting the lender's minimum) and `newDurationDays` to fit
 *      `min(both maxNewExpiry)`, capped at 30 days per extension so
 *      consent doesn't roll forward indefinitely without
 *      re-affirmation.
 *   6. Only inside the extension window (vaipakam#2738): from three days
 *      before the loan's effective due date to the end of its grace, both
 *      read from `LoanFacet.getLoanDeadlines` (the pause-adjusted loan
 *      clock), and only for a term that does not make the loan
 *      defaultable sooner: the new due date plus the new term's grace
 *      must not be earlier than the old grace end. A shorter term can sit
 *      in a smaller grace bucket, so "the end moves later" alone does not
 *      hold that. A deadline or grace schedule that does not read skips
 *      the loan (or the chain's tick) rather than extending blind. The
 *      contract does not yet check either rule; when it publishes the
 *      window (`getAutoExtendWindow`) this detector reads it instead.
 *   7. Submit `extendLoanInPlace(loanId, newRateBps, newDurationDays)`.
 *      The contract enforces every safety guard (sub-day-since-start,
 *      grace expired, sanctions, etc.) — failures bubble up here as
 *      logs and we continue.
 *
 * Soft per-tick cap of 5 extends so one rogue chain can't burn the
 * keeper's gas budget; remainder rolled forward to the next tick.
 *
 * Auto-refinance is NOT in this v1 — it requires composing the
 * matcher's flow with refinance-tagged offers (create→accept→
 * refinanceLoan). The existing `offerMatcher` detector already
 * drives matchOffers; combining the two is a follow-up.
 */

import {
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { log } from '../log.ts';
// Per-facet typed ABIs (src/abis/diamond.ts, #13): each call names the ABI
// of the facet that defines its function, so viem types the call and a
// contract signature change fails the typecheck instead of the run.
import { ADMIN_ABI, AUTO_LIFECYCLE_ABI, CONFIG_ABI, LOAN_ABI, METRICS_ABI } from '../abis/diamond.ts';

const SCAN_PAGE = 200n;
const MAX_EXTENDS_PER_TICK = 5;
const DEFAULT_EXTEND_DAYS = 30n;
const SECONDS_PER_DAY = 86_400n;

/** vaipakam#2738 — how long before a loan's effective due date the window to
 *  extend it opens. It closes at the end of the loan's grace. The value
 *  matches the protocol's own keeper and the contract half of #2738. */
export const EXTEND_WINDOW_SECONDS = 3n * SECONDS_PER_DAY;

/** One governance grace bucket, as `ConfigFacet.getGraceBuckets` returns it. */
export interface GraceBucket {
  maxDurationDays: bigint;
  graceSeconds: bigint;
}

/** The grace a term of `durationDays` carries: `LibVaipakam.gracePeriod`'s
 *  walk over the published buckets, or its compiled default schedule when
 *  governance has published none. */
export function graceSeconds(buckets: readonly GraceBucket[], durationDays: bigint): bigint {
  if (buckets.length === 0) {
    if (durationDays < 7n) return 3_600n;
    if (durationDays < 30n) return SECONDS_PER_DAY;
    if (durationDays < 90n) return 3n * SECONDS_PER_DAY;
    if (durationDays < 180n) return 7n * SECONDS_PER_DAY;
    if (durationDays < 365n) return 14n * SECONDS_PER_DAY;
    return 30n * SECONDS_PER_DAY;
  }
  for (const b of buckets) {
    if (b.maxDurationDays === 0n || durationDays < b.maxDurationDays) return b.graceSeconds;
  }
  return buckets[buckets.length - 1].graceSeconds;
}

/**
 * Whether extending a loan whose effective deadlines are `maturity` /
 * `graceEnd` to a `newDurationDays` term from `now` is inside the window and
 * keeps its grace-inclusive deadline; null when it is, otherwise why not. The
 * new term starts at `now`, as `extendLoanInPlace` restarts it.
 */
export function extendWindowVerdict(
  deadlines: { maturity: bigint; graceEnd: bigint },
  newDurationDays: bigint,
  buckets: readonly GraceBucket[],
  now: bigint,
): string | null {
  const opensAt = deadlines.maturity - EXTEND_WINDOW_SECONDS;
  if (now < opensAt) return `window opens at ${opensAt}`;
  if (now > deadlines.graceEnd) return `past grace (ended ${deadlines.graceEnd})`;
  const newMaturity = now + newDurationDays * SECONDS_PER_DAY;
  if (newMaturity <= deadlines.maturity) return 'term would not move the due date later';
  if (newMaturity + graceSeconds(buckets, newDurationDays) < deadlines.graceEnd) {
    return 'term would make the loan defaultable sooner';
  }
  return null;
}

interface AutoExtendDetectorParams {
  chainId: number;
  diamond: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

/** One side's auto-extend caps as the contract returns them. The rate bounds
 *  are `uint16`, which viem decodes as `number` (not `bigint`). The read is
 *  assigned without a cast, so the compiler checks this shape against the
 *  ABI (#13). */
interface ExtendCaps {
  enabled: boolean;
  minRateBps: number;
  maxRateBps: number;
  maxNewExpiry: bigint;
  setter: Address;
}

export async function runAutoExtendDetectorTick(
  params: AutoExtendDetectorParams,
): Promise<void> {
  const { chainId, diamond, publicClient, walletClient } = params;

  // Admin kill switch — skip the chain entirely when off.
  let adminEnabled: boolean;
  try {
    adminEnabled = (await publicClient.readContract({
      address: diamond,
      abi: ADMIN_ABI,
      functionName: 'getAutoExtendEnabled',
    }));
  } catch (err) {
    log.warn('autoExtend.adminGate.failed', {
      chain: chainId,
      err: String(err).slice(0, 200),
    });
    return;
  }
  if (!adminEnabled) {
    log.debug('autoExtend.killSwitch.off', { chain: chainId });
    return;
  }

  // Enumerate active loans.
  let total: bigint;
  try {
    total = (await publicClient.readContract({
      address: diamond,
      abi: METRICS_ABI,
      functionName: 'getActiveLoansCount',
    }));
  } catch (err) {
    log.warn('autoExtend.count.failed', {
      chain: chainId,
      err: String(err).slice(0, 200),
    });
    return;
  }
  if (total === 0n) return;

  // vaipakam#2738 — the grace each candidate term carries. Unread, no term's
  // grace is known, so nothing is extended this tick.
  let buckets: readonly GraceBucket[];
  try {
    buckets = await publicClient.readContract({
      address: diamond,
      abi: CONFIG_ABI,
      functionName: 'getGraceBuckets',
    });
  } catch (err) {
    log.warn('autoExtend.graceBuckets.failed', {
      chain: chainId,
      err: String(err).slice(0, 200),
    });
    return;
  }

  const loanIds: bigint[] = [];
  for (let cursor = 0n; cursor < total; cursor += SCAN_PAGE) {
    const limit =
      cursor + SCAN_PAGE > total ? total - cursor : SCAN_PAGE;
    try {
      const page = (await publicClient.readContract({
        address: diamond,
        abi: METRICS_ABI,
        functionName: 'getActiveLoansPaginated',
        args: [cursor, limit],
      }));
      loanIds.push(...page);
    } catch (err) {
      log.warn('autoExtend.page.failed', {
        chain: chainId,
        cursor: String(cursor),
        err: String(err).slice(0, 200),
      });
      return;
    }
  }

  let submitted = 0;
  for (const loanIdBig of loanIds) {
    if (submitted >= MAX_EXTENDS_PER_TICK) break;
    const fired = await tryExtend(
      chainId,
      diamond,
      publicClient,
      walletClient,
      loanIdBig,
      buckets,
    );
    if (fired) submitted++;
  }
  log.debug('autoExtend.tick.done', {
    chain: chainId,
    scanned: loanIds.length,
    extended: submitted,
  });
}

async function tryExtend(
  chainId: number,
  diamond: Address,
  publicClient: PublicClient,
  walletClient: WalletClient,
  loanIdBig: bigint,
  buckets: readonly GraceBucket[],
): Promise<boolean> {
  // Read both-side caps. Each getter self-applies the staleness fence:
  // a transferred NFT returns `enabled: false` and we skip.
  let borrowerCaps: ExtendCaps;
  let lenderCaps: ExtendCaps;
  try {
    [borrowerCaps, lenderCaps] = (await Promise.all([
      publicClient.readContract({
        address: diamond,
        abi: AUTO_LIFECYCLE_ABI,
        functionName: 'getAutoExtendBorrowerCaps',
        args: [loanIdBig],
      }),
      publicClient.readContract({
        address: diamond,
        abi: AUTO_LIFECYCLE_ABI,
        functionName: 'getAutoExtendLenderCaps',
        args: [loanIdBig],
      }),
    ]));
  } catch {
    // Old deploys without the facet — return silently; the per-chain
    // adminEnabled check would normally have caught this, but a
    // partial cut might still trip individual calls.
    return false;
  }

  if (!borrowerCaps.enabled || !lenderCaps.enabled) return false;

  // Pick rate at the lender's floor — most conservative for the
  // borrower while still respecting the lender's minimum. The
  // contract enforces `minRateBps <= newRateBps <= ceiling`.
  const ceiling =
    lenderCaps.maxRateBps < borrowerCaps.maxRateBps
      ? lenderCaps.maxRateBps
      : borrowerCaps.maxRateBps;
  const newRateBps = lenderCaps.minRateBps;
  if (newRateBps > ceiling) return false; // no intersection

  // Compute the duration that fits inside the tightest expiry cap.
  const expiryCap =
    lenderCaps.maxNewExpiry < borrowerCaps.maxNewExpiry
      ? lenderCaps.maxNewExpiry
      : borrowerCaps.maxNewExpiry;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (expiryCap !== 0n && nowSec >= expiryCap) return false;

  let newDurationDays = DEFAULT_EXTEND_DAYS;
  if (expiryCap !== 0n) {
    const remainingDays = (expiryCap - nowSec) / SECONDS_PER_DAY;
    if (remainingDays < newDurationDays) newDurationDays = remainingDays;
    if (newDurationDays === 0n) return false;
  }

  // vaipakam#2738 — only inside the window, and only a term that keeps the
  // loan's grace-inclusive deadline. Read after the caps: most loans carry
  // no consent and never reach this read.
  let deadlines: { maturity: bigint; graceEnd: bigint };
  try {
    const [, , maturity, graceEnd] = await publicClient.readContract({
      address: diamond,
      abi: LOAN_ABI,
      functionName: 'getLoanDeadlines',
      args: [loanIdBig],
    });
    deadlines = { maturity, graceEnd };
  } catch (err) {
    log.info('autoExtend.deadlines.unread', {
      chain: chainId,
      loanId: String(loanIdBig),
      err: String(err).slice(0, 200),
    });
    return false;
  }
  const outside = extendWindowVerdict(deadlines, newDurationDays, buckets, nowSec);
  if (outside !== null) {
    log.debug('autoExtend.outsideWindow', {
      chain: chainId,
      loanId: String(loanIdBig),
      reason: outside,
    });
    return false;
  }

  if (!walletClient.account) return false;

  try {
    const hash = await walletClient.writeContract({
      address: diamond,
      abi: AUTO_LIFECYCLE_ABI,
      functionName: 'extendLoanInPlace',
      args: [loanIdBig, newRateBps, newDurationDays],
      chain: null,
      account: walletClient.account,
    });
    log.info('autoExtend.fired', {
      chain: chainId,
      loanId: String(loanIdBig),
      rateBps: String(newRateBps),
      days: String(newDurationDays),
      tx: hash,
    });
    return true;
  } catch (err) {
    // Most reverts here are benign (loan in last day, grace expired,
    // both-side consent flipped between read + write). Log at info.
    log.info('autoExtend.skipped', {
      chain: chainId,
      loanId: String(loanIdBig),
      reason: String(err).slice(0, 200),
    });
    return false;
  }
}
