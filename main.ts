// BTC Predator v5 — deterministic cbBTC 1-minute trading bot for make.fun's
// "Race a BTC trading bot live for 24 hours" (btc-race-24h-20261118-1444).
//
// Three long-only entry modes, one position at a time, 100% of cash per entry.
// Exits are measured from the actual harness fill price. Fully deterministic:
// no clock, no network, no randomness — the same bars always produce the same
// orders.
//
//   Mode 1 RECLAIM (core, always on): arm when the bar's low sweeps the prior
//     20-bar low while the close sits at or below 0.99 x SMA(20); fire when a
//     later bar (within 5 bars) closes back above the arm bar's own low (the
//     swept low) with RSI(14) at or below 50 and ATR(14) not exploded (at or
//     below 2.0 x the median ATR of the prior 240 bars). Stop -0.5%, target
//     +1.0%, max hold 300 bars.
//
//   Mode 3 BREAKOUT (core, always on): close breaks the prior 20-bar high by
//     at least 0.20%, ATR(14) expanded (above 1.5 x median ATR) but not
//     exploded (at or below 2.0 x median ATR), EMA(9) above EMA(21), RSI(14)
//     at or below 80, close no more than 1.5% above SMA(20). Stop -0.4%,
//     target +1.0%, max hold 240 bars.
//
//   Mode 2 BREAKOUT DEGEN (news windows only): like the breakout, but with no
//     margin, no RSI cap and no ATR cap — a news spike IS a volatility
//     explosion by design. Windows: Jobless Claims + Philly Fed (19 Nov
//     13:00-15:30Z) and the 10Y TIPS auction (19 Nov 17:30-19:30Z). Stop -0.6%,
//     target +3.0%, max hold 240 bars, one re-entry per window if the first
//     entry was stopped out.
//
//   Entry priority while flat: Mode 2 (inside a window) -> Mode 3 -> Mode 1.
//   Exit order: stop -> target -> trail -> max hold -> flatten.
//   Trail (Modes 1 and 3): once the highest high since entry reaches +1.0%
//     above the fill, exit when the close falls 0.8% below that peak.
//
//   Guardrails: max 1 position; 100% cash sizing; no new entries once the
//     internal drawdown from the equity peak reaches 18%; no new entries after
//     bar 1400; flatten from bar 1425; max slippage 150 bps.
//
// Indicator definitions (all from received bars only, never future bars):
//   SMA(20) includes the current bar; HH(20)/LL(20) cover the 20 bars BEFORE
//   the current bar; RSI(14) and ATR(14) use Wilder smoothing; EMA(9)/EMA(21)
//   are seeded with the simple average of their first N closes; the median ATR
//   covers the ATR values of the prior 240 bars (excluding the current bar)
//   and needs at least 20 samples, otherwise it is unavailable.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 150;

// --- Mode 1: RECLAIM ---
const M1_DIP = 0.99;
const M1_RSI_MAX = 50;
const M1_CONFIRM_BARS = 5;
const M1_STOP = 0.005;
const M1_TARGET = 0.01;
const M1_HOLD = 300;

// --- Mode 3: BREAKOUT always-on ---
const M3_MARGIN = 1.002;
const M3_ATR_FLOOR = 1.5;
const M3_RSI_MAX = 80;
const M3_EXT_MAX = 1.015;
const M3_STOP = 0.004;
const M3_TARGET = 0.01;
const M3_HOLD = 240;

// --- ATR explosion cap (Mode 1 fire and Mode 3 only; Mode 2 is exempt) ---
const ATR_CAP_MULT = 2.0;

// --- Mode 2: BREAKOUT DEGEN (news windows) ---
const M2_WINDOWS = [
  { start: 1795093200000, end: 1795102200000 }, // Jobless Claims + Philly Fed, 19 Nov 13:00-15:30Z
  { start: 1795109400000, end: 1795116600000 }, // 10Y TIPS auction, 19 Nov 17:30-19:30Z
];
const M2_ATR_FLOOR = 1.5;
const M2_EXT_MAX = 1.008;
const M2_STOP = 0.006;
const M2_TARGET = 0.03;
const M2_HOLD = 240;
const M2_MAX_REENTRIES = 1;

// --- Trail (Modes 1 and 3 only) ---
const TRAIL_ACTIVATE = 0.01;
const TRAIL_GIVEBACK = 0.008;

// --- Guardrails ---
const DD_BRAKE = 0.18;
const FLATTEN_BAR = 1425;
const NO_ENTRY_AFTER_BAR = 1400;

// --- Indicator lengths ---
const SMA_LEN = 20;
const RANGE_LEN = 20;
const RSI_LEN = 14;
const ATR_LEN = 14;
const EMA_FAST = 9;
const EMA_SLOW = 21;
const ATR_MEDIAN_LEN = 240;
const ATR_MEDIAN_MIN = 20;

type Mode = 'M1' | 'M2' | 'M3';

interface BarPrices {
  o: number;
  h: number;
  l: number;
  c: number;
}

interface OpenPosition {
  mode: Mode;
  fill: number;
  entrySeq: number;
  window: number; // Mode 2 window index, -1 otherwise
  peak: number; // highest high since entry (trail)
}

interface ArmedReclaim {
  sweptLow: number; // the arm bar's own low (the level the reclaim must close above)
  bar: number; // seq of the arm bar
}

const bars: BarPrices[] = [];
const atrByBar: (number | null)[] = [];

// Wilder RSI(14) state.
let rsiAvgGain: number | null = null;
let rsiAvgLoss: number | null = null;
let rsiGainSum = 0;
let rsiLossSum = 0;
let rsiChanges = 0;

// Wilder ATR(14) state.
let atrValue: number | null = null;
let atrTrSum = 0;
let atrTrCount = 0;

// EMA state (seeded with the simple average of the first N closes).
let emaFast: number | null = null;
let emaSlow: number | null = null;

// Strategy state.
let arm: ArmedReclaim | null = null;
let pos: OpenPosition | null = null;
let pendingMode: Mode | null = null; // mode of a buy awaiting its fill
let pendingWindow = -1;
let pendingEntrySeq = -1; // seq of the bar the pending buy was decided on
let pendingExitReason: string | null = null; // reason of a sell awaiting its fill
let orderNo = 0;
let peakEquity = 0;
const m2Windows = M2_WINDOWS.map(() => ({ entries: 0, stopped: false }));

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Median ATR over the prior bars (excluding the current bar); null below 20 samples. */
function medianAtrBefore(barIndex: number): number | null {
  const samples: number[] = [];
  const from = Math.max(0, barIndex - ATR_MEDIAN_LEN);
  for (let i = from; i < barIndex; i++) {
    const v = atrByBar[i];
    if (v !== null && v !== undefined) samples.push(v);
  }
  if (samples.length < ATR_MEDIAN_MIN) return null;
  return median(samples);
}

function windowIndex(t: number): number {
  for (let w = 0; w < M2_WINDOWS.length; w++) {
    if (t >= M2_WINDOWS[w]!.start && t < M2_WINDOWS[w]!.end) return w;
  }
  return -1;
}

function log(msg: string): void {
  console.error(`[v5] ${msg}`);
}

async function onBatch(state: BarsState, batch: Batch): Promise<OrderInput[]> {
  // Track the equity peak for the drawdown brake.
  const equity = Number(state.equity);
  if (equity > peakEquity) peakEquity = equity;

  // Fold this batch's fills into our own position bookkeeping first, so an
  // order decided on the previous bar is visible before we decide on this one.
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL) continue;
    const sym = state.symbols.get(SYMBOL);
    const scale = sym === undefined ? 5 : sym.price_scale;
    if (fill.status === 'filled' && fill.side === 'buy') {
      const price = Number(BigInt(fill.price)) / 10 ** scale;
      pos = {
        mode: pendingMode ?? 'M3',
        fill: price,
        // NOTE: fill.decided_bar/fill_bar are millisecond timestamps, not bar
        // indices — the entry bar is the seq the buy was decided on.
        entrySeq: pendingEntrySeq >= 0 ? pendingEntrySeq : state.seq - 1,
        window: pendingWindow,
        peak: price,
      };
      log(`filled ${pos.mode} buy ${fill.client_id} @ $${price.toFixed(2)} (bar ${state.seq})`);
      pendingMode = null;
      pendingWindow = -1;
      pendingEntrySeq = -1;
    } else if (fill.status === 'filled' && fill.side === 'sell') {
      if (pos !== null && pos.mode === 'M2' && pendingExitReason === 'STOP' && pos.window >= 0) {
        m2Windows[pos.window]!.stopped = true;
      }
      log(`filled sell ${fill.client_id} @ $${(Number(BigInt(fill.price)) / 10 ** scale).toFixed(2)}`);
      pos = null;
      pendingExitReason = null;
    } else if (fill.status === 'rejected') {
      if (fill.side === 'buy') {
        // A rejected Mode 2 buy never entered: release the window's entry
        // slot, otherwise the rejection would permanently block the window
        // (re-entry is only allowed after the first entry was stopped out).
        if (pendingMode === 'M2' && pendingWindow >= 0) {
          const room = m2Windows[pendingWindow]!;
          room.entries = Math.max(0, room.entries - 1);
        }
        pendingMode = null;
        pendingWindow = -1;
        pendingEntrySeq = -1;
      } else {
        pendingExitReason = null;
      }
    }
  }

  const raw = batch.bars.find((b) => b.symbol === SYMBOL);
  if (raw === undefined) return []; // a minute with no bar: nothing to decide on
  const sym = state.symbols.get(SYMBOL);
  const priceScale = sym === undefined ? 5 : sym.price_scale;
  const toPrice = (v: string): number => Number(BigInt(v)) / 10 ** priceScale;
  const bar: BarPrices = { o: toPrice(raw.o), h: toPrice(raw.h), l: toPrice(raw.l), c: toPrice(raw.c) };
  const seq = state.seq;

  // --- Update indicators with this bar (current bar included where defined). ---
  const prevClose = bars.length > 0 ? bars[bars.length - 1]!.c : null;
  bars.push(bar);
  const n = bars.length;
  const i = n - 1;

  // RSI(14), Wilder: seed with the mean of the first 14 changes, then smooth.
  let rsi: number | null = null;
  if (prevClose !== null) {
    const change = bar.c - prevClose;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (rsiAvgGain === null || rsiAvgLoss === null) {
      rsiGainSum += gain;
      rsiLossSum += loss;
      rsiChanges += 1;
      if (rsiChanges >= RSI_LEN) {
        rsiAvgGain = rsiGainSum / RSI_LEN;
        rsiAvgLoss = rsiLossSum / RSI_LEN;
      }
    } else {
      rsiAvgGain = (rsiAvgGain * (RSI_LEN - 1) + gain) / RSI_LEN;
      rsiAvgLoss = (rsiAvgLoss * (RSI_LEN - 1) + loss) / RSI_LEN;
    }
  }
  if (rsiAvgGain !== null && rsiAvgLoss !== null) {
    rsi = rsiAvgLoss === 0 ? 100 : 100 - 100 / (1 + rsiAvgGain / rsiAvgLoss);
  }

  // ATR(14), Wilder: seed with the mean of the first 14 true ranges, then smooth.
  if (prevClose !== null) {
    const tr = Math.max(bar.h - bar.l, Math.abs(bar.h - prevClose), Math.abs(bar.l - prevClose));
    if (atrValue === null) {
      atrTrSum += tr;
      atrTrCount += 1;
      if (atrTrCount >= ATR_LEN) atrValue = atrTrSum / ATR_LEN;
    } else {
      atrValue = (atrValue * (ATR_LEN - 1) + tr) / ATR_LEN;
    }
  }
  atrByBar.push(atrValue);

  // EMA(9)/EMA(21), seeded with the simple average of the first N closes.
  if (emaFast === null && n >= EMA_FAST) {
    let sum = 0;
    for (let k = n - EMA_FAST; k < n; k++) sum += bars[k]!.c;
    emaFast = sum / EMA_FAST;
  } else if (emaFast !== null) {
    emaFast += (2 / (EMA_FAST + 1)) * (bar.c - emaFast);
  }
  if (emaSlow === null && n >= EMA_SLOW) {
    let sum = 0;
    for (let k = n - EMA_SLOW; k < n; k++) sum += bars[k]!.c;
    emaSlow = sum / EMA_SLOW;
  } else if (emaSlow !== null) {
    emaSlow += (2 / (EMA_SLOW + 1)) * (bar.c - emaSlow);
  }

  // SMA(20) including the current bar.
  let sma20: number | null = null;
  if (n >= SMA_LEN) {
    let sum = 0;
    for (let k = n - SMA_LEN; k < n; k++) sum += bars[k]!.c;
    sma20 = sum / SMA_LEN;
  }

  // HH(20)/LL(20) over the 20 bars BEFORE the current bar.
  let hh20: number | null = null;
  let ll20: number | null = null;
  if (n >= RANGE_LEN + 1) {
    hh20 = -Infinity;
    ll20 = Infinity;
    for (let k = n - RANGE_LEN - 1; k < n - 1; k++) {
      if (bars[k]!.h > hh20) hh20 = bars[k]!.h;
      if (bars[k]!.l < ll20) ll20 = bars[k]!.l;
    }
  }

  const medAtr = medianAtrBefore(i);
  const atr = atrValue;
  const atrExpanded = medAtr !== null && atr !== null && atr > M3_ATR_FLOOR * medAtr;
  // The cap passes when the median is not yet available: no explosion proven.
  const atrNotExploded = medAtr === null || atr === null || atr <= ATR_CAP_MULT * medAtr;

  // --- Exits (when holding a position). Order: stop -> target -> trail -> max hold -> flatten. ---
  if (pos !== null) {
    pos.peak = Math.max(pos.peak, bar.h);
    const stopPct = pos.mode === 'M1' ? M1_STOP : pos.mode === 'M2' ? M2_STOP : M3_STOP;
    const targetPct = pos.mode === 'M1' ? M1_TARGET : pos.mode === 'M2' ? M2_TARGET : M3_TARGET;
    const maxHold = pos.mode === 'M1' ? M1_HOLD : pos.mode === 'M2' ? M2_HOLD : M3_HOLD;
    let reason: string | null = null;
    if (bar.c <= pos.fill * (1 - stopPct)) reason = 'STOP';
    else if (bar.c >= pos.fill * (1 + targetPct)) reason = 'TARGET';
    else if (
      pos.mode !== 'M2' &&
      pos.peak >= pos.fill * (1 + TRAIL_ACTIVATE) &&
      bar.c <= pos.peak * (1 - TRAIL_GIVEBACK)
    ) {
      reason = 'TRAIL';
    } else if (seq - pos.entrySeq >= maxHold) reason = 'MAXHOLD';
    else if (seq >= FLATTEN_BAR) reason = 'FLATTEN';
    if (reason !== null) {
      const held = state.positions.get(SYMBOL);
      if (held !== undefined && held.qty > 0n) {
        pendingExitReason = reason;
        log(`${pos.mode} exit ${reason} at bar ${seq} (close $${bar.c.toFixed(2)}, fill $${pos.fill.toFixed(2)})`);
        return [{ side: 'sell', client_id: `s${++orderNo}`, symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    return [];
  }

  // --- Entries (while flat). Priority: Mode 2 -> Mode 3 -> Mode 1. ---
  if (state.warmingUp) return [];
  if (seq > NO_ENTRY_AFTER_BAR) return [];
  if (peakEquity > 0 && equity <= peakEquity * (1 - DD_BRAKE)) return [];

  // An arm expires once the gap to its bar exceeds the confirmation window.
  if (arm !== null && seq - arm.bar > M1_CONFIRM_BARS) arm = null;

  const w = windowIndex(batch.t);
  let mode: Mode | null = null;
  let modeWindow = -1;

  // Mode 2: news window, no margin, no RSI cap, NO ATR cap.
  if (w >= 0 && hh20 !== null && sma20 !== null && emaFast !== null && emaSlow !== null) {
    const room = m2Windows[w]!;
    const reentryOk = room.entries === 0 || (room.entries === 1 && room.stopped && M2_MAX_REENTRIES >= 1);
    if (
      reentryOk &&
      bar.c > hh20 &&
      medAtr !== null &&
      atr !== null &&
      atr > M2_ATR_FLOOR * medAtr &&
      emaFast > emaSlow &&
      bar.c <= sma20 * M2_EXT_MAX
    ) {
      mode = 'M2';
      modeWindow = w;
    }
  }

  // Mode 3: breakout always-on, with margin, ATR floor AND cap, RSI cap, extension cap.
  if (
    mode === null &&
    hh20 !== null &&
    sma20 !== null &&
    emaFast !== null &&
    emaSlow !== null &&
    rsi !== null &&
    bar.c > hh20 * M3_MARGIN &&
    atrExpanded &&
    atrNotExploded &&
    emaFast > emaSlow &&
    rsi <= M3_RSI_MAX &&
    bar.c <= sma20 * M3_EXT_MAX
  ) {
    mode = 'M3';
  }

  // Mode 1: reclaim of the swept low, with RSI gate and ATR explosion cap.
  if (
    mode === null &&
    arm !== null &&
    rsi !== null &&
    bar.c > arm.sweptLow &&
    rsi <= M1_RSI_MAX &&
    atrNotExploded
  ) {
    mode = 'M1';
  }

  if (mode !== null) {
    if (state.cash <= 0n) return [];
    pendingMode = mode;
    pendingWindow = modeWindow;
    pendingEntrySeq = seq;
    if (mode === 'M2' && modeWindow >= 0) m2Windows[modeWindow]!.entries += 1;
    arm = null; // entering supersedes any pending reclaim arm
    log(`${mode} entry signal at bar ${seq} (close $${bar.c.toFixed(2)})`);
    return [{ side: 'buy', client_id: `b${++orderNo}`, symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }

  // No entry: arm (or refresh) a reclaim when the bar sweeps the 20-bar low
  // while closing deep below SMA(20). The swept low is the arm bar's own low.
  if (ll20 !== null && sma20 !== null && bar.l < ll20 && bar.c <= M1_DIP * sma20) {
    arm = { sweptLow: bar.l, bar: seq };
    log(`M1 armed at bar ${seq} (low $${bar.l.toFixed(2)}, close/SMA20 ${(bar.c / sma20).toFixed(4)})`);
  }
  return [];
}

await runBars({ onBatch });
