/**
 * Vaipakam keeper bot — the borrower's standing instructions (vaipakam#3789,
 * "my positions" mode).
 *
 * A borrower can leave three instructions on a loan, each paid from their own
 * per-loan reserve in their vault (`StandingInstructionFacet`): a collateral
 * top-up when the health factor falls under their trigger, the interest of
 * each period from its end, and the whole repayment from a lead time before
 * the due date. Each executor is open to ANY caller. The caller chooses
 * nothing and receives nothing: the loan, the borrower's settings and the
 * reserve fix every amount. So an operator can run this bot for their own
 * wallets, and nothing happens on a loan unless someone runs the step.
 *
 * Mirrors the monorepo keeper's `standingInstructions` pass. The CONTRACT
 * decides; this pass copies no rule. Per tick, per chain, for each step the
 * operator switched on:
 *
 *   1. Pick the loans. With `CHAIN_<id>_MY_WALLETS` set: every loan whose
 *      BORROWER position one of those wallets holds NOW, read from the
 *      position tokens the wallet holds (`getUserPositionLoansPaginated`),
 *      kept only where the token is the loan's `borrowerTokenId` and the
 *      loan is active. A position follows its token, so a loan the wallet
 *      once borrowed and has since handed over is not picked. Unset: every
 *      active loan. `CHAIN_<id>_LOAN_IDS` narrows either further.
 *   2. Read the loan's own view, `getLoanReserve(loanId, holder)`. It says
 *      whether the instructions' owner still holds the position, what a
 *      top-up would move now, the interest payable now, the repayment due
 *      and how short the reserve is, and the skip reason the contract would
 *      record now. A step is tried only where the view says it would move
 *      something and records no skip.
 *   3. The interest step is previewed with `previewInterestPayment`, which
 *      runs the payment and undoes it, so a delivery a token would refuse is
 *      known before any gas is spent.
 *   4. Each call is simulated on the current state and sent only when the
 *      simulation succeeds. A step that is not due (too soon after the last
 *      top-up, before the repayment window, nothing owed) reverts in the
 *      simulation and is logged at debug. Each send waits for its receipt,
 *      and the receipt's `StandingInstructionSkipped` reason, if any, is
 *      logged by name.
 *
 * A repayment closes the loan, so when it is due it is the loan's only step.
 * Sends are capped per chain per tick; the rest wait for the next tick.
 *
 * The bot's key needs no keeper approval from anyone and holds no authority
 * over any loan: a leaked key costs only the gas it holds.
 */

import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  decodeEventLog,
  type Hex,
  type PublicClient,
  type WalletClient,
  zeroAddress,
} from 'viem';
import { log } from '../log.ts';
import type { StandingSteps } from '../config.ts';
import { LOAN_ABI, METRICS_ABI, STANDING_INSTRUCTION_ABI } from '../abis/diamond.ts';

const SCAN_PAGE = 200n;
/** Sends per chain per tick across the three steps. */
export const MAX_SENDS_PER_TICK = 5;
const RECEIPT_TIMEOUT_MS = 60_000;
/** `LibVaipakam.LoanStatus.Active`. */
const LOAN_ACTIVE = 0;

export type Step = 'topUp' | 'interest' | 'repay';

/** `StandingInstructionFacet.INSTRUCTION_*`, as the skip event names them. */
const INSTRUCTION_STEP: ReadonlyMap<number, Step> = new Map([
  [1, 'topUp'],
  [2, 'interest'],
  [3, 'repay'],
]);

/** `StandingInstructionFacet.SKIP_*`, in words. */
export const SKIP_REASONS: ReadonlyMap<number, string> = new Map([
  [1, 'the borrower position is no longer held by the wallet that set the instruction'],
  [2, 'the reserve is empty'],
  [3, 'the reserve is short of the full repayment'],
  [4, 'a sale, offset, refinance or intent is live on the loan'],
  [5, 'the collateral price is missing or distrusted'],
  [6, 'the platform or the asset is paused'],
  [7, "the borrower's account is locked"],
  [8, "the collateral has not yet moved to the new holder's vault"],
  [9, 'a token refused a delivery of the payment'],
  [10, 'the holder is sanctioned'],
]);

export function skipReason(code: number): string {
  return SKIP_REASONS.get(code) ?? `skip reason ${code}`;
}

/** The fields of `getLoanReserve` this pass reads. */
export interface ReserveView {
  instructions: {
    owner: Address;
    topUpTriggerHf: bigint;
    payInterest: boolean;
    repayAtDue: boolean;
  };
  ownerHoldsPosition: boolean;
  topUpNow: bigint;
  interestNow: bigint;
  repayDue: bigint;
  repayShortBy: bigint;
  topUpSkipNow: number;
  paymentSkipNow: number;
}

/**
 * The steps worth trying on a loan, read off the contract's own view: on, and
 * the view says the step would move something now and records no skip. A due
 * repayment goes alone, since it closes the loan. Pure; the contract still
 * decides every call (its simulation is the next gate).
 */
export function stepsToTry(v: ReserveView, on: StandingSteps): Step[] {
  const i = v.instructions;
  if (i.owner === zeroAddress || !v.ownerHoldsPosition) return [];
  const out: Step[] = [];
  if (on.repay && i.repayAtDue && v.repayDue > 0n && v.repayShortBy === 0n && v.paymentSkipNow === 0) {
    return ['repay'];
  }
  if (on.topUp && i.topUpTriggerHf !== 0n && v.topUpNow > 0n && v.topUpSkipNow === 0) out.push('topUp');
  if (on.interest && i.payInterest && v.interestNow > 0n && v.paymentSkipNow === 0) out.push('interest');
  return out;
}

/** The function each step calls. */
const STEP_FN = {
  topUp: 'runCollateralTopUp',
  interest: 'runInterestPayment',
  repay: 'runDueRepayment',
} as const;

interface Params {
  chainId: number;
  diamond: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
  steps: StandingSteps;
  /** The operator's wallets on this chain; null = every active loan. */
  myWallets: readonly Address[] | null;
  /** `CHAIN_<id>_LOAN_IDS`; null = no narrowing. */
  loanIds: readonly number[] | null;
}

/** A loan to look at, and the wallet whose reserve its view is read for
 *  (null: read the instructions' owner first). */
interface Candidate {
  loanId: bigint;
  holder: Address | null;
}

export async function runStandingInstructionsTick(p: Params): Promise<void> {
  if (!p.steps.topUp && !p.steps.interest && !p.steps.repay) return;
  const candidates = await listCandidates(p);
  let sends = 0;
  let tried = 0;
  for (const c of candidates) {
    if (sends >= MAX_SENDS_PER_TICK) {
      log.info('standing.capReached', { chain: p.chainId, left: candidates.length - tried });
      break;
    }
    tried += 1;
    const view = await readView(p, c);
    if (view === null) continue;
    for (const step of stepsToTry(view, p.steps)) {
      if (sends >= MAX_SENDS_PER_TICK) break;
      if (step === 'interest' && !(await interestPreviewClear(p, c.loanId))) continue;
      if (await trySend(p, c.loanId, step)) sends += 1;
    }
  }
  log.debug('standing.tick.done', { chain: p.chainId, loans: candidates.length, sent: sends });
}

async function listCandidates(p: Params): Promise<Candidate[]> {
  const narrow = p.loanIds && p.loanIds.length > 0 ? new Set(p.loanIds.map((n) => BigInt(n))) : null;
  const keep = (id: bigint) => narrow === null || narrow.has(id);
  if (p.myWallets === null) {
    return (await activeLoanIds(p)).filter(keep).map((loanId) => ({ loanId, holder: null }));
  }
  const out: Candidate[] = [];
  const seen = new Set<bigint>();
  for (const wallet of p.myWallets) {
    for (const loanId of await borrowerLoansHeldBy(p, wallet)) {
      if (!keep(loanId) || seen.has(loanId)) continue;
      seen.add(loanId);
      out.push({ loanId, holder: wallet });
    }
  }
  return out;
}

async function activeLoanIds(p: Params): Promise<bigint[]> {
  let total: bigint;
  try {
    total = await p.publicClient.readContract({ address: p.diamond, abi: METRICS_ABI, functionName: 'getActiveLoansCount' });
  } catch (err) {
    log.warn('standing.count.failed', { chain: p.chainId, err: String(err).slice(0, 200) });
    return [];
  }
  const ids: bigint[] = [];
  for (let offset = 0n; offset < total; offset += SCAN_PAGE) {
    try {
      const page = await p.publicClient.readContract({
        address: p.diamond,
        abi: METRICS_ABI,
        functionName: 'getActiveLoansPaginated',
        args: [offset, SCAN_PAGE],
      });
      ids.push(...page);
      if (page.length < Number(SCAN_PAGE)) break;
    } catch (err) {
      log.warn('standing.page.failed', { chain: p.chainId, offset: Number(offset), err: String(err).slice(0, 200) });
      break;
    }
  }
  return ids;
}

/**
 * The active loans whose BORROWER position `wallet` holds now. Read from the
 * position tokens the wallet holds, not from the loan's stored borrower,
 * which is the original borrower until the collateral is consolidated after
 * a transfer: a read keyed on it would miss a position the wallet bought and
 * keep one it sold.
 */
async function borrowerLoansHeldBy(p: Params, wallet: Address): Promise<bigint[]> {
  const pairs: { loanId: bigint; tokenId: bigint }[] = [];
  for (let offset = 0n; ; offset += SCAN_PAGE) {
    let page: readonly [readonly bigint[], readonly bigint[], bigint];
    try {
      page = await p.publicClient.readContract({
        address: p.diamond,
        abi: METRICS_ABI,
        functionName: 'getUserPositionLoansPaginated',
        args: [wallet, offset, SCAN_PAGE],
      });
    } catch (err) {
      log.warn('standing.positions.failed', { chain: p.chainId, wallet, err: String(err).slice(0, 200) });
      break;
    }
    const [loanIds, tokenIds, total] = page;
    for (let k = 0; k < loanIds.length; k++) pairs.push({ loanId: loanIds[k], tokenId: tokenIds[k] });
    if (offset + SCAN_PAGE >= total) break;
  }
  const out: bigint[] = [];
  for (const { loanId, tokenId } of pairs) {
    try {
      const loan = await p.publicClient.readContract({
        address: p.diamond,
        abi: LOAN_ABI,
        functionName: 'getLoanDetails',
        args: [loanId],
      });
      if (loan.status === LOAN_ACTIVE && loan.borrowerTokenId === tokenId) out.push(loanId);
    } catch (err) {
      log.debug('standing.loan.read.failed', { chain: p.chainId, loanId: Number(loanId), err: String(err).slice(0, 150) });
    }
  }
  return out;
}

async function readView(p: Params, c: Candidate): Promise<ReserveView | null> {
  const read = (holder: Address) =>
    p.publicClient.readContract({
      address: p.diamond,
      abi: STANDING_INSTRUCTION_ABI,
      functionName: 'getLoanReserve',
      args: [c.loanId, holder],
    });
  try {
    let holder = c.holder;
    if (holder === null) {
      // The instructions are the loan's; the reserve is the owner's. Read
      // the owner first, then the view for them.
      const owner = (await read(zeroAddress)).instructions.owner;
      if (owner === zeroAddress) return null;
      holder = owner;
    }
    return await read(holder);
  } catch (err) {
    log.debug('standing.view.failed', { chain: p.chainId, loanId: Number(c.loanId), err: String(err).slice(0, 150) });
    return null;
  }
}

/** The interest payment's own preview: it always reverts
 *  `InterestPaymentPreview(skip, amount, inner)`. True when it would pay. */
async function interestPreviewClear(p: Params, loanId: bigint): Promise<boolean> {
  try {
    await p.publicClient.simulateContract({
      address: p.diamond,
      abi: STANDING_INSTRUCTION_ABI,
      functionName: 'previewInterestPayment',
      args: [loanId],
      account: p.walletClient.account,
    });
  } catch (err) {
    const r = revertOf(err);
    if (r?.name === 'InterestPaymentPreview') {
      const [skip, amount] = r.args as readonly [number, bigint, Hex];
      if (skip === 0 && amount > 0n) return true;
      if (skip !== 0) log.info('standing.skip.predicted', { chain: p.chainId, loanId: Number(loanId), step: 'interest', reason: skipReason(skip) });
      return false;
    }
    log.debug('standing.preview.refused', { chain: p.chainId, loanId: Number(loanId), err: r?.name ?? String(err).slice(0, 150) });
    return false;
  }
  // The preview never returns; a Diamond that does not route it is not one
  // this pass knows how to read.
  return false;
}

/** Simulate, send, wait. True when a transaction landed (ran or skipped). */
async function trySend(p: Params, loanId: bigint, step: Step): Promise<boolean> {
  const account = p.walletClient.account;
  if (!account) return false;
  let request;
  try {
    ({ request } = await p.publicClient.simulateContract({
      address: p.diamond,
      abi: STANDING_INSTRUCTION_ABI,
      functionName: STEP_FN[step],
      args: [loanId],
      account,
    }));
  } catch (err) {
    // Not due, or no longer due: the contract's own refusal, by name.
    log.debug('standing.notDue', { chain: p.chainId, loanId: Number(loanId), step, refusal: revertOf(err)?.name ?? String(err).slice(0, 150) });
    return false;
  }
  let hash: Hex;
  try {
    hash = await p.walletClient.writeContract({ ...request, chain: p.walletClient.chain ?? null });
  } catch (err) {
    log.warn('standing.send.failed', { chain: p.chainId, loanId: Number(loanId), step, err: String(err).slice(0, 200) });
    return false;
  }
  try {
    const receipt = await p.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== 'success') {
      log.warn('standing.reverted', { chain: p.chainId, loanId: Number(loanId), step, tx: hash });
      return true;
    }
    const skipped = skipsIn(p.diamond, receipt.logs, loanId);
    if (skipped !== null) {
      log.info('standing.skipped', { chain: p.chainId, loanId: Number(loanId), step: INSTRUCTION_STEP.get(skipped.instruction) ?? step, reason: skipReason(skipped.reason), tx: hash });
    } else {
      log.info('standing.ran', { chain: p.chainId, loanId: Number(loanId), step, tx: hash });
    }
  } catch (err) {
    log.warn('standing.receipt.unread', { chain: p.chainId, loanId: Number(loanId), step, tx: hash, err: String(err).slice(0, 150) });
  }
  return true;
}

/** The `StandingInstructionSkipped` the receipt records for `loanId`, if any. */
export function skipsIn(
  diamond: Address,
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
  loanId: bigint,
): { instruction: number; reason: number } | null {
  for (const l of logs) {
    if (l.address.toLowerCase() !== diamond.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({
        abi: STANDING_INSTRUCTION_ABI,
        data: l.data,
        topics: l.topics as [Hex, ...Hex[]],
        eventName: 'StandingInstructionSkipped',
      });
      if (ev.args.loanId === loanId) return { instruction: ev.args.instruction, reason: ev.args.reason };
    } catch {
      // another event
    }
  }
  return null;
}

/** The decoded custom error a call reverted with, if viem could name it. */
function revertOf(err: unknown): { name: string; args: readonly unknown[] } | null {
  if (!(err instanceof BaseError)) return null;
  const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(r instanceof ContractFunctionRevertedError) || !r.data) return null;
  return { name: r.data.errorName, args: r.data.args ?? [] };
}
