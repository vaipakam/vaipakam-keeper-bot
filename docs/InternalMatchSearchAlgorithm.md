# Internal-match pair-search algorithm

Companion doc for
[`src/detectors/internalMatcher.ts`](../src/detectors/internalMatcher.ts).
Spec the off-chain pair-search behaviour so a future bot
operator running a competing matcher knows what shape of pairs
the protocol expects, what the priority window looks like, and
how to size their RPC budget.

This is bot-side intent only; the on-chain contract surface
imposes the actual validation gates (see
`docs/DesignsAndPlans/InternalLiquidationLedger.md` in the
vaipakam repo for the protocol-level design).

## 1. On-chain entry point

```solidity
function triggerInternalMatchLiquidation(
    uint256 loanIdA,
    uint256 loanIdB,
    uint256 loanIdC   // 0 = 2-way match; non-zero = 3-way A→B→C→A cycle
) external nonReentrant whenNotPaused;
```

The function validates the match (asset opposition, LTV-floor,
self-pair / chain-repeat, sanctions) then settles the legs
synchronously. Bot earns `internalMatchIncentivePerLegBps` (1%
by default, governance-tunable up to 3%) of each matched leg's
notional, paid to `msg.sender` in the leg's asset.

## 2. Eligibility surface

A loan is "match-eligible" iff:

1. `status == LoanStatus.Active`.
2. `currentLtvBps ≥ loan.liquidationLtvBpsAtInit` (i.e., HF < 1
   against its snapshotted per-tier liquidation threshold).
3. `principal > 0` and `collateralAmount > 0`.
4. `principalLiquidity == Liquid` and `collateralLiquidity ==
   Liquid` (illiquid collateral → external default path).

`MetricsFacet.getMatchEligibleLoans(minLtvBps, maxLtvBps,
startIdx, pageSize)` returns the active loan IDs that pass
condition (2) in a configurable LTV band. The bot calls it
per tick with `(0, 10_000, cursor, 200)` to gather every
match-eligible ID, then hydrates each via `getLoanDetails(id)`
to verify conditions (1) (3) (4) — the view doesn't enforce
them.

## 3. Match-shape constraints

### 2-way pair (A, B)

```
A.principalAsset  == B.collateralAsset   (= asset X)
A.collateralAsset == B.principalAsset    (= asset Y)
```

Two loans where each one's debt asset is the other's collateral
asset. The match clears `min(A.principal, B.collateralAmount)`
of X (B's collateral pays A's lender) and
`min(B.principal, A.collateralAmount)` of Y (A's collateral
pays B's lender), each with the configured per-leg incentive
withheld.

### 3-way chain (A → B → C → A)

```
A.principalAsset  == B.collateralAsset   (= X)
B.principalAsset  == C.collateralAsset   (= Y)
C.principalAsset  == A.collateralAsset   (= Z)
```

Three loans where each loan's debt asset is the next loan's
collateral asset, closing a 3-cycle. Three independent
min-match legs.

## 4. Candidate enumeration

Per tick:

1. **List**: paginate `getMatchEligibleLoans` until the view
   returns an empty page or the `nextIdx` cursor stops
   advancing. Page size 200 keeps the LTV-compute cost inside
   public-RPC gas caps.
2. **Hydrate**: `getLoanDetails(id)` per row. Drop any that
   fail the (1)/(3)/(4) checks above.
3. **Bucket**: group by `(principalAsset, collateralAsset)`.
   Pair candidates live in the inverse-bucket
   `(collateralAsset, principalAsset)`.
4. **2-way pass**: for each unconsumed loan, look up its
   inverse bucket. The first unconsumed loan in that bucket is
   a candidate; if `simulateContract(triggerInternalMatchLiquidation,
   [A.id, B.id, 0])` succeeds, submit.
5. **3-way pass**: re-bucket the remaining (unconsumed) loans
   by `principalAsset` so asset edges can be walked in O(1)
   per hop. For each loan `A`:
   - Look up `bucket[A.collateralAsset]` → candidate `B`s
     whose debt is in A's collateral asset.
   - For each such `B`, look up `bucket[B.collateralAsset]` →
     candidate `C`s whose debt is in B's collateral asset.
   - Accept the first `C` whose `collateralAsset == A.principalAsset`
     (closes the A→B→C→A cycle). Submit
     `triggerInternalMatchLiquidation(A.id, B.id, C.id)`.
   - Skip degenerate cycles where `B.collateralAsset ==
     A.principalAsset` — that's a 2-way pair, already
     handled in step 4.

## 5. Submit policy

- **Per-tick submit cap**: 10 by default (`MAX_SUBMITS_PER_TICK`).
  Keeps the keeper's per-minute gas budget predictable.
- **Per-pair dedupe**: a `Set<bigint>` of consumed loan IDs
  per tick; a loan that wins one match is excluded from
  subsequent attempts in the same tick.
- **First-valid wins**: bot iterates each bucket and submits
  on the first candidate that simulates successfully — no
  attempt at global optimum. Lost-race reverts are normal
  (multiple matchers can target the same pair); the bot logs
  at DEBUG and moves on.
- **No re-simulation across blocks**: a candidate that
  simulated successfully but lost the race in the same block
  is NOT retried automatically; next tick re-enumerates from
  fresh state.

## 6. Gas + economics

- **Per match (2-way)**: ~250–350k gas (4 escrow withdraws +
  2 deposit-counter records + status transition for each
  cleared leg).
- **Per match (3-way)**: ~400–500k gas (6 withdraws + 3
  deposits + up to 3 status transitions).
- **Profit floor**: bot earns `incentiveBps × notional` per
  leg in the leg's asset. At default 100 BPS and average
  match size ≈ $1000 per leg, bot nets ~$10/leg gross of
  gas. On L2s where gas is sub-$1, every match clears
  profit. On L1 the bot should compute gas-cost-in-asset and
  skip matches where notional × incentiveBps < gas-cost
  threshold.

## 7. Kill-switch behaviour

When `getInternalMatchConfigBundle().enabled == false`:
- `MetricsFacet.getMatchEligibleLoans` returns an empty
  array — the view itself short-circuits.
- `triggerInternalMatchLiquidation` reverts
  `InternalMatchDisabled` for every call.
- The priority-window gate inside `triggerLiquidation`
  short-circuits — external opens up across the full LTV
  range (no priority window).

Bot detects this via the config-bundle read and logs once per
session per chain at INFO. No retries. When governance flips
the flag back on, the next tick picks it up and starts
matching without a bot restart.

## 8. Future extensions

- **Cross-chain match aggregation**: a bot scanning chain A
  could discover a match on chain B (one leg posted on each
  chain). Requires an LZ message + cross-chain settlement
  — out of scope for v1; revisit if same-chain match
  volume saturates.
- **Profitability gating**: skip matches where the simulated
  per-leg incentive doesn't cover the estimated gas cost on
  the target chain. Useful on L1 only.
- **Priority-window-only mode**: only target loans currently
  in the 2% priority window where external is blocked, to
  avoid wasted simulations on loans already above-window
  (external is grabbing them).
- **4-way+ chains**: the contract entry point caps at 3 legs,
  so a longer cycle isn't directly callable. A bot could in
  principle find a 4-cycle and submit it as two overlapping
  3-cycles; whether that's worth the complexity depends on
  observed 4-cycle frequency at scale.
