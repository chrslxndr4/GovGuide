# Congressional Stock Tracker & Conflict Detection Engine

**Date:** 2026-03-10
**Status:** Approved

## Overview

A "Quiver clone + GovGuide superpowers" — congressional stock trade tracker with conflict detection that cross-references trades with committee assignments, lobbying, campaign donors, pending regulations, and prediction market anomalies. Targets civic watchdogs and the general public.

## 1. Architecture

Three cross-linked views:

- **`/stocks` trade feed**: Filterable table of all congressional stock trades sourced from House Clerk XML + Senate eFD. Each row links to politician profile and ticker detail. Flagged badge on rows with active conflicts.
- **Politician profile enrichment**: New "Stock Trades" tab and "Conflict Flags" section on existing `/officials/[id]` pages. Committee assignments shown alongside trades in the same sector.
- **`/conflicts` dashboard**: Combined severity-sorted view of stock trade conflicts and prediction market anomalies. Cards with expandable detail, evidence links, and severity scores. Filter by type, severity, date range. Timeline view showing trades/bets relative to political events.

All three views are cross-linked. No new frameworks — Astro static pages with React islands for interactive filters/sorting.

## 2. Conflict Detection

### Rule-Based Detectors (8)

1. **Committee-sector overlap**: Politician on committee X trades stock in sector regulated by X (e.g., Armed Services member buys defense contractor)
2. **Pre-vote trading**: Trade within 30 days before a vote on legislation affecting that sector
3. **Lobbying-trade alignment**: Politician receives lobbying contacts from industry Y, then trades in Y
4. **Donor-trade correlation**: Top campaign donors overlap with companies the politician trades
5. **Regulatory front-running**: Trade before a regulatory action (EPA enforcement, FCC ruling, etc.) affecting that company/sector
6. **Insider timing**: Trade precedes a non-public earnings surprise or FDA decision
7. **Unusual frequency**: Politician's trading volume spikes vs. their historical baseline
8. **Bipartisan consensus trades**: Multiple politicians from both parties trade the same ticker in the same direction within a narrow window (suggests shared non-public info)

### Statistical Anomaly Detectors (4)

1. **Return anomaly**: Politician's portfolio returns significantly exceed market benchmarks (p < 0.05 over rolling 12-month window)
2. **Timing alpha**: Trades consistently precede positive price movements more than chance would predict
3. **Sector concentration shift**: Sudden reallocation toward a sector where the politician has new committee or legislative activity
4. **Cluster detection**: Graph-based detection of coordinated trading patterns across multiple officials

### Scoring

Combined severity score 0-10:
- 0-3: Low (single weak signal)
- 4-6: Medium (multiple signals or one strong signal)
- 7-10: High (multiple strong signals, clear temporal correlation)

Each conflict links to primary source evidence.

## 3. Data Flow & Pipeline

### Six-Step Weekly Batch

1. **Ingest trades** — House Clerk XML ZIPs + Senate eFD (already built in `import-stock-trades.ts`)
2. **Enrich tickers** — SEC EDGAR SIC codes for sector mapping, basic company metadata
3. **Cross-reference** — Match trades against committee assignments, lobbying contacts, donor records, pending legislation, regulatory actions
4. **Detect conflicts** — Run 8 rule-based + 4 statistical detectors
5. **Score & rank** — Compute severity scores, deduplicate overlapping detections
6. **Materialize views** — Refresh 3 materialized views for fast page loads

### New Tables

- `ticker_metadata` — symbol, company name, SIC code, sector, exchange (sourced from SEC EDGAR)
- `trade_enrichments` — FK to stock_trades, enriched sector, committee overlap flags, related legislation IDs

### Materialized Views (3)

- `mv_trade_conflicts` — pre-joined trades + conflicts + politician info for `/stocks` feed
- `mv_politician_trade_summary` — aggregated stats per politician for profile pages
- `mv_conflict_timeline` — chronological conflict events for timeline visualization

### Timeliness

Weekly batch (House Clerk publishes ~45 day delay anyway). On-demand refresh capability for breaking events.

## 4. Prediction Market Anomaly Detection

Integrates with the conflict detection engine. Detects anomalous prediction market betting patterns that may indicate insider knowledge.

### Data Sources

- Kalshi trade data (already imported via `import-predictions.ts`)
- Polymarket CLOB trades (wallet-level, pseudonymous)

### Anomaly Detectors (4)

1. **Volume spike**: Single market sees >3 sigma volume increase in 24-48hr window before a political event (vote, executive order, regulatory action)
2. **Price dislocation**: Market price diverges >15% from polling/prediction averages, then snaps back after an event — suggests informed trading
3. **Whale clustering**: Multiple large positions (>$10k) opened in the same direction within a short window on correlated markets
4. **Timing correlation**: Bets placed within 72hrs before a bill vote, executive order, or regulatory decision that moves the market >20%

### Cross-Referencing

- Correlate anomalous market movements with congressional calendar (scheduled votes, hearings, markup sessions)
- Flag when a market moves before a regulatory action tracked in `law_sources` table
- Link to related stock trades if a politician trades stocks AND a related prediction market moves simultaneously
- Match Kalshi usernames / Polymarket wallet addresses against known political actors where possible

### Output

- Writes to existing `prediction_anomalies` table (migration 014)
- Generates `prediction_insider` conflict type entries in `potential_conflicts` (migration 015)
- Surfaces on `/conflicts` page alongside stock trade conflicts
- Anomaly badges on `/predictions` page markets with detected irregularities
- Each anomaly scored 0-10 using same severity framework

### Constraints

- Polymarket wallets are pseudonymous — detection is pattern-based, not identity-based
- Kalshi has better identity data but less volume
- Most detection relies on temporal correlation with political events, not trader attribution

## 5. UI Integration

### `/stocks` — Trade Feed (new)

- Filterable table: politician, ticker, date, amount range, buy/sell, party
- Each row links to politician profile + ticker detail
- "Flagged" badge on rows with active conflicts
- Sort by recency, amount, or conflict severity

### `/conflicts` — Conflict Dashboard (new)

- Combined view: stock trade conflicts + prediction market anomalies
- Severity-sorted cards with expandable detail
- Each card: conflict type, involved entities, evidence links, severity score
- Filter by type (stock/prediction/lobbying), severity threshold, date range
- Timeline view showing when trades/bets occurred relative to political events

### Politician Profile Enrichment (existing `/officials/[id]`)

- New "Stock Trades" tab with mini trade table
- New "Conflict Flags" section showing active conflicts
- Prediction market activity if anomalies link to their actions
- Committee assignments shown alongside trades in same sector

### `/predictions` Enrichment (existing)

- "Anomaly" badges on markets with detected irregularities
- Expandable detail showing trigger reason
- Link to related conflicts if cross-referenced

### Implementation

No new frameworks. Astro static pages with React islands for interactive filters/sorting. Data from materialized views for fast page loads.

## 6. Data Privacy & Limitations

### What We Show

- **Stock trades**: All public record (STOCK Act disclosures). No privacy concern.
- **Prediction markets**: Market-level anomaly detection. Kalshi account data is private. Polymarket wallets are pseudonymous — no deanonymization attempts. Pattern-based detection only.
- **Conflict detection**: All inferences labeled as *potential* conflicts with evidence links. No accusations — "here's the data, draw your own conclusions."

### Limitations (displayed on every conflict card)

- Stock trades are self-reported with 45-day filing delay
- Blind trusts exempt from disclosure
- Prediction market attribution is limited
- Correlation does not equal causation

### Legal

No defamation risk — we only surface public records + statistical patterns. Every conflict card links to primary source data.
