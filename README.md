# Vaipakam keeper bot — reference implementation

A self-contained, MIT-licensed Node.js bot that competes for
Vaipakam liquidations across every supported chain. **Liquidation
is permissionless** on Vaipakam — anyone can run this bot, and
anyone whose `triggerLiquidation` lands first earns the on-chain
liquidator bonus.

This is a standalone repo (originally extracted from the Vaipakam
monorepo's `ops/keeper-bot/` folder). It tracks the upstream
protocol's diamond ABI: when Vaipakam's diamond gains new
selectors or changes `triggerLiquidation`'s signature, this repo
gets a corresponding update.

```bash
git clone <this-repo-url>
cd vaipakam-keeper-bot
npm install
cp .env.example .env
# edit .env per the inline notes
npm start
```

## What the bot does

Every tick (default 60s), per configured chain:

1. Read `getActiveLoansCount()` and page through
   `getActiveLoansPaginated(offset, limit)` to get every active
   loan id. (Operators can pin a whitelist of loan ids per chain
   instead — useful for monitoring a single high-value position
   or stress-testing.)
2. For each loan id, read the on-chain Health Factor via
   `calculateHealthFactor(loanId)`. Skip loans whose HF ≥ 1.0.
3. For each liquidatable loan, read the loan struct, then
   orchestrate quotes from all configured DEX venues in parallel:
   - **0x Swap API** (off-chain, requires API key)
   - **1inch Swap API** (off-chain, requires API key)
   - **Uniswap V3 QuoterV2** (on-chain, no API key)
   - **Balancer V2** (subgraph + reserve estimate, no API key)
4. Rank by expected output (best first), pack into the diamond's
   ranked-failover signature, and submit
   `triggerLiquidation(loanId, ranked)` from the keeper EOA.
5. The diamond iterates the ranked try-list, commits on the first
   adapter that meets the oracle-derived 6% slippage floor, and
   pays out the liquidator bonus.

Idempotent within a tick — won't re-attempt the same loan id
twice in one cron sweep. Across ticks, the diamond's status check
naturally rejects re-attempts on already-liquidated loans (you
just pay gas for a failed simulation, not a real revert).

## Trust assumptions

- **Keeper key** = a hot wallet. Worst case if leaked: the attacker
  drains your gas budget by submitting attempts that fail. They
  cannot move user funds — the diamond never holds anything for the
  keeper.
- **API keys** = paid 0x / 1inch keys. If exposed, the holder can
  burn through your rate limits. The bot only runs them in-process;
  no proxy / no public exposure.
- **RPC URLs** = paid endpoints. Public RPCs WILL rate-limit the bot
  and you'll miss every fast race.

## Setup

```bash
# 1. Copy the env template and fill in
cp .env.example .env
# Edit .env: KEEPER_PRIVATE_KEY, CHAIN_IDS, per-chain DIAMOND + RPC.
# Optional: ZEROEX_API_KEY, ONEINCH_API_KEY for off-chain quote routes.

# 2. Install dependencies
npm install

# 3. Run
npm start
# or for development with auto-restart on file change:
npm run dev
```

Logs are JSON-lines, ingestible by Datadog / Loki / Splunk:

```
{"ts":"2026-04-25T18:23:01.123Z","level":"info","msg":"keeper.start","keeper":"0xKeeperAddr","chains":[8453,1],"pollIntervalSeconds":60,"zeroEx":true,"oneInch":true}
{"ts":"2026-04-25T18:23:02.456Z","level":"info","msg":"liquidation.submitted","chain":8453,"loanId":42,"tx":"0xabc...","via":"oneinch","expected":"1543200000"}
```

## MEV considerations

Liquidation is permissionless and competitive. To land more
liquidations:

- **Use an MEV-protected RPC** on chains where searchers run
  routinely. On Ethereum L1: Flashbots Protect or MEV Blocker.
  On BSC: bloXroute. On L2s with sequencer-ordered inclusion
  (Base, Arbitrum, Optimism, zkEVM): the public RPC is fine.
- **Set POLL_INTERVAL_SECONDS as low as your RPC budget allows.**
  A 30s tick on Base / 10s on Optimism keeps you in the running
  for any HF transition. Faster polling needs a paid RPC tier
  (Alchemy growth, Infura paid).
- **Don't dedicate a private key per chain.** Same keeper EOA
  across chains works fine and centralizes nonce management.
  Just fund it with gas on every chain you operate against.

## Per-chain coverage

| Chain | UniV3 | Balancer V2 | 0x | 1inch |
|---|---|---|---|---|
| Ethereum | ✓ | ✓ | ✓ | ✓ |
| Base | ✓ | ✓ | ✓ | ✓ |
| Arbitrum | ✓ | ✓ | ✓ | ✓ |
| Optimism | ✓ | ✓ | ✓ | ✓ |
| Polygon zkEVM | ✗ | ✓ | ✓ | ✓ |
| BNB Chain | ✗ | ✗ | ✓ | ✓ |

Empty cells aren't bugs — they reflect upstream deployment
coverage. The bot detects gaps automatically and skips the
missing venue.

## What the bot does NOT do

- **Quote validation against on-chain state.** The bot trusts the
  off-chain quote APIs and the subgraph. The diamond's per-adapter
  `minOutputAmount` floor is what actually enforces slippage. A
  stale quote = a failed simulation, not a bad fill.
- **Mempool monitoring.** The bot polls; it doesn't subscribe to
  pending txs. Searchers running mempool-aware bots will beat this
  one to high-value liquidations on Ethereum L1. On L2s with
  centralized sequencers, there's no public mempool to monitor —
  polling is competitive.
- **Profit projection.** `MIN_PROFIT_USD_8DEC` filters out
  small-value liquidations, but the bot doesn't track gas spent vs
  bonus earned. Operators should budget for some failed-simulation
  gas cost as a cost of doing business.
- **NFT-collateral defaults.** ERC-721 / ERC-1155 collateral takes
  the time-based default path (no DEX swap), which the bot doesn't
  participate in. Anyone can call `triggerDefault(loanId)` after
  the grace period; that's a separate (gas-cheaper) script.

## License

MIT. Use, fork, and modify freely. No warranty; running this bot
in production is at your own risk.

## Contact

Issues / PRs welcome at the upstream Vaipakam monorepo.
