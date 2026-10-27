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
 *   6. Only inside the extension window (vaipakam#2738), read from the
 *      contract's own statement of it, `getAutoExtendWindow(loanId)`
 *      (opens three days before the pause-adjusted due date, never inside
 *      the first day after the start, closes at the grace end; both bounds
 *      inclusive). A window that does not read skips the loan: a Diamond
 *      deployed before vaipakam#2738's contract half does not route the
 *      view, and this bot extends nothing there rather than judging the
 *      window on a copy of the rule.
 *   7. Submit `extendLoanInPlace(loanId, newRateBps, newDurationDays)`.
 *      The contract enforces every safety guard (window, grace expired,
 *      a term that does not extend or would make the loan defaultable
 *      sooner, sanctions, etc.) — the gas estimate refuses those before
 *      anything is broadcast, and we log and continue.
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
import { ADMIN_ABI, AUTO_LIFECYCLE_ABI, METRICS_ABI } from '../abis/diamond.ts';

const SCAN_PAGE = 200n;
const MAX_EXTENDS_PER_TICK = 5;
const DEFAULT_EXTEND_DAYS = 30n;
const SECONDS_PER_DAY = 86_400n;

/**
 * Whether `now` is inside the window `getAutoExtendWindow` published for a
 * loan (both bounds inclusive, as `extendLoanInPlace` applies them); null when
 * it is, otherwise why not.
 */
export function windowVerdict(opensAt: bigint, closesAt: bigint, now: bigint): string | null {
  if (now < opensAt) return `window opens at ${opensAt}`;
  if (now > closesAt) return `past grace (ended ${closesAt})`;
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

  // vaipakam#2738 — only inside the window the contract states. Read after
  // the caps: most loans carry no consent and never reach this read.
  let opensAt: bigint;
  let closesAt: bigint;
  try {
    [opensAt, closesAt] = await publicClient.readContract({
      address: diamond,
      abi: AUTO_LIFECYCLE_ABI,
      functionName: 'getAutoExtendWindow',
      args: [loanIdBig],
    });
  } catch (err) {
    log.info('autoExtend.window.unread', {
      chain: chainId,
      loanId: String(loanIdBig),
      err: String(err).slice(0, 200),
    });
    return false;
  }
  const outside = windowVerdict(opensAt, closesAt, nowSec);
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
