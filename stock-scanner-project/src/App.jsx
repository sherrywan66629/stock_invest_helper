import React, { useState, useMemo, useEffect, useRef } from "react";
import { TrendingUp, Gauge, AlertTriangle, Upload, PlayCircle, X, Plus, RefreshCw, Loader2 } from "lucide-react";
import { getCachedBars, setCachedBars, clearCache, msUntilNextPstMidnight } from "./ticker-cache.js";

// ---------- Design tokens ----------
const C = {
  bg: "#0B1220",
  panel: "#111A2E",
  panelAlt: "#0E1626",
  border: "#22304A",
  text: "#E6EDF7",
  textMuted: "#8B98B0",
  bull: "#4FD1AE",
  bear: "#E2725B",
  gold: "#D4A24C",
  amber: "#E0B24C",
};

const mono = { fontFamily: "'IBM Plex Mono', 'JetBrains Mono', monospace" };
const sans = { fontFamily: "'Space Grotesk', 'Inter', sans-serif" };

// ---------- Demo dataset: synthetic downtrend -> basing pattern ----------
function buildDemoCSV() {
  let price = 100;
  const rows = [];
  const start = new Date("2026-03-01");
  for (let i = 0; i < 90; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    let drift, vol;
    if (i < 55) {
      drift = -0.35 - Math.random() * 0.4; // steady downtrend
      vol = 800000 + Math.random() * 400000;
    } else if (i < 80) {
      drift = (Math.random() - 0.55) * 0.5; // choppy basing, shrinking volume
      vol = 500000 + Math.random() * 200000 - (i - 55) * 4000;
    } else {
      drift = 0.15 + Math.random() * 0.6; // gentle reversal
      vol = 700000 + Math.random() * 500000 + (i - 80) * 15000;
    }
    const open = price;
    let close = Math.max(2, price + drift);
    // inject a hammer near day 78 and a morning-star cluster near day 83-85
    if (i === 78) close = open - open * 0.01;
    let low = Math.min(open, close) - Math.abs(drift) * (i === 78 ? 3.2 : 1.1) - Math.random() * 0.3;
    let high = Math.max(open, close) + Math.random() * 0.5;
    if (i === 83) { close = open - open * 0.02; low = open - open * 0.045; high = open + 0.1; vol = 1200000; }
    if (i === 84) { close = (open + close) / 2 * 0.999; high = Math.max(high, open + 0.1); low = Math.min(low, close - 0.1); vol = 600000; }
    if (i === 85) { close = open + open * 0.028; vol = 1500000; }
    price = close;
    rows.push([
      d.toISOString().slice(0, 10),
      open.toFixed(2),
      Math.max(high, open, close).toFixed(2),
      Math.max(0.5, Math.min(low, open, close)).toFixed(2),
      close.toFixed(2),
      Math.round(Math.max(50000, vol)),
    ].join(","));
  }
  return "date,open,high,low,close,volume\n" + rows.join("\n");
}
const DEMO_CSV = buildDemoCSV();

// ---------- Live data fetch (via /api/quote, which proxies Yahoo Finance) ----------
function barsToCSV(bars) {
  const rows = bars.map((b) => [b.date, b.open, b.high, b.low, b.close, b.volume].join(","));
  return "date,open,high,low,close,volume\n" + rows.join("\n");
}

async function fetchQuote(ticker) {
  const resp = await fetch(`/api/quote?ticker=${encodeURIComponent(ticker)}`);
  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error("获取数据失败：接口返回格式异常");
  }
  if (!resp.ok) throw new Error(data.error || "获取数据失败");
  return data.bars;
}

// Resolves a ticker's bars from cache (unless forced) or a live fetch, shaped
// for direct use in ticker state. Shared by the manual/panel fetch path and
// the background watchlist auto-loader below.
async function loadTickerData(ticker, { force = false } = {}) {
  if (!force) {
    const cached = getCachedBars(ticker);
    if (cached) {
      return { bars: cached, raw: barsToCSV(cached), fetchedAt: new Date().toISOString(), fromCache: true };
    }
  }
  const liveBars = await fetchQuote(ticker);
  setCachedBars(ticker, liveBars);
  return { bars: liveBars, raw: barsToCSV(liveBars), fetchedAt: new Date().toISOString(), fromCache: false };
}

// ---------- Parsing ----------
function parseCSV(text) {
  const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 30) throw new Error("至少需要 30 行日线数据才能做趋势和形态判断。");
  const header = lines[0].toLowerCase();
  const startIdx = header.includes("date") ? 1 : 0;
  const bars = [];
  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i].split(",").map((s) => s.trim());
    if (parts.length < 6) continue;
    const [date, open, high, low, close, volume] = parts;
    const o = parseFloat(open), h = parseFloat(high), l = parseFloat(low), c = parseFloat(close), v = parseFloat(volume);
    if ([o, h, l, c, v].some((x) => Number.isNaN(x))) continue;
    bars.push({ date, open: o, high: h, low: l, close: c, volume: v });
  }
  if (bars.length < 30) throw new Error("有效数据不足 30 行，请检查格式：date,open,high,low,close,volume");
  return bars;
}

// ---------- Indicators ----------
function sma(values, period, idx) {
  if (idx + 1 < period) return null;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) sum += values[i];
  return sum / period;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);
    if (i <= period) {
      gains += gain; losses += loss;
      if (i === period) {
        const avgG = gains / period, avgL = losses / period;
        out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
        out._prevAvgG = avgG; out._prevAvgL = avgL;
      }
    } else {
      const avgG = (out._prevAvgG * (period - 1) + gain) / period;
      const avgL = (out._prevAvgL * (period - 1) + loss) / period;
      out._prevAvgG = avgG; out._prevAvgL = avgL;
      out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
  }
  return out;
}

// ---------- Candlestick pattern detection (scans a recent window, not just the last bar) ----------
function bodySize(b) { return Math.abs(b.close - b.open); }
function range(b) { return b.high - b.low; }
function lowerShadow(b) { return Math.min(b.open, b.close) - b.low; }
function upperShadow(b) { return b.high - Math.max(b.open, b.close); }

// How many recent trading days still count as "recent enough" for a named
// pattern to matter - a hammer 3 days ago is still a relevant signal, not
// just one that lands on the literal most recent candle.
const PATTERN_LOOKBACK = 10;

// Each pattern TYPE has a fixed "strength" constant (how reliable that kind
// of formation is taken to be, by classic technical-analysis convention -
// not something we compute, just an assigned ranking: Morning Star > Bullish
// Engulfing > Hammer > Doji). baseScore(strength) is the score for an
// instance that just barely qualifies. On top of that, each detected
// instance gets a 0-7 point "quality" bonus based on how comfortably it
// clears its own qualifying threshold (e.g. a doji with an almost-zero body
// scores a bit higher than one that barely squeaks under the 10% cutoff) -
// capped at 7 so a max-quality instance of one pattern can never outscore
// even a bare-minimum instance of the next (smallest gap between pattern
// types is 8 points, Hammer 63 -> Bullish Engulfing 71).
function baseScore(strength) { return 15 + strength * 80; }
// Linearly maps x from [0,1] and clamps the result - the shared building
// block for every "cliff -> gradient" score in this file (candlestick
// quality bonus, volume, trend), so a value just short of a threshold gets
// partial credit instead of the same score as "not close at all".
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
const QUALITY_BONUS = 7;

function detectPatterns(bars) {
  const n = bars.length;
  const mostRecentByName = new Map();
  const record = (name, score, day) => {
    const existing = mostRecentByName.get(name);
    if (!existing || day > existing.day) mostRecentByName.set(name, { name, score, day });
  };

  const start = Math.max(2, n - PATTERN_LOOKBACK);
  for (let i = start; i < n; i++) {
    const last = bars[i], prev = bars[i - 1], prev2 = bars[i - 2];

    // Hammer (strength 0.6): small body, long lower shadow (>=2x body), short
    // upper shadow. Quality = how much the lower shadow exceeds the 2x-body
    // minimum - a shadow 5x the body or longer gets full bonus.
    if (range(last) > 0) {
      const body = bodySize(last);
      const lowSh = lowerShadow(last);
      const upSh = upperShadow(last);
      if (body <= range(last) * 0.35 && lowSh >= body * 2 && upSh <= body * 0.6) {
        const shadowRatio = body > 0 ? lowSh / body : 5;
        const quality = clamp01((shadowRatio - 2) / 3);
        record("锤子线 Hammer", Math.round(baseScore(0.6) + quality * QUALITY_BONUS), last.date);
      }
    }
    // Doji (strength 0.35): body very small relative to range. Quality = how
    // much smaller the body is than the 10%-of-range cutoff - a body at 0%
    // (open == close) is a "textbook" doji and gets full bonus.
    if (range(last) > 0) {
      const bodyPct = bodySize(last) / range(last);
      if (bodyPct <= 0.1) {
        const quality = clamp01((0.1 - bodyPct) / 0.1);
        record("十字星 Doji", Math.round(baseScore(0.35) + quality * QUALITY_BONUS), last.date);
      }
    }
    // Bullish engulfing (strength 0.7): prev red, last green, last body
    // engulfs prev body. Quality = how much bigger the engulfing body is
    // than the engulfed one - 2x or more gets full bonus.
    if (prev.close < prev.open && last.close > last.open) {
      if (last.open <= prev.close && last.close >= prev.open) {
        const prevBody = bodySize(prev);
        const engulfRatio = prevBody > 0 ? bodySize(last) / prevBody : 2;
        const quality = clamp01(engulfRatio - 1);
        record("看涨吞没 Bullish Engulfing", Math.round(baseScore(0.7) + quality * QUALITY_BONUS), last.date);
      }
    }
    // Morning star (strength 0.85): big down day, small-body middle day (gap
    // down), big up day closing into first candle's body. Quality = how deep
    // day 3's close recovers into day 1's decline - closing all the way back
    // above day 1's open (100%+ recovery) gets full bonus.
    const day1Down = prev2.close < prev2.open && bodySize(prev2) > range(prev2) * 0.5;
    const day2Small = bodySize(prev) <= range(prev2) * 0.4;
    const day3Up = last.close > last.open && last.close >= (prev2.open + prev2.close) / 2;
    if (day1Down && day2Small && day3Up) {
      const day1Drop = prev2.open - prev2.close;
      const recovery = day1Drop > 0 ? (last.close - prev2.close) / day1Drop : 0.5;
      const quality = clamp01((recovery - 0.5) / 0.5);
      record("启明星 Morning Star", Math.round(baseScore(0.85) + quality * QUALITY_BONUS), last.date);
    }
  }
  return Array.from(mostRecentByName.values());
}

// When no named pattern fires, give a continuous 0-30ish reading instead of a
// flat floor, based on how the last few candles actually look: where the
// close sits within the day's range (close near the high leans bullish) and
// how small the body is relative to the range (smaller = more indecisive,
// same spirit as a Doji but graduated instead of a hard cutoff).
function baselineCandleScore(bars) {
  const n = bars.length;
  const window = bars.slice(Math.max(0, n - 3), n);
  const perDay = window.map((b) => {
    const r = range(b);
    if (r <= 0) return 15;
    const clv = ((b.close - b.low) - (b.high - b.close)) / r; // -1..+1, close position in range
    const bodyRatio = bodySize(b) / r; // 0..1
    const closeScore = ((clv + 1) / 2) * 15; // 0..15
    const indecisionScore = (1 - Math.min(bodyRatio, 1)) * 15; // 0..15
    return closeScore + indecisionScore;
  });
  return Math.round(perDay.reduce((a, b) => a + b, 0) / perDay.length);
}

function describeBaselineCandle(bars) {
  const last = bars[bars.length - 1];
  const r = range(last);
  if (r <= 0) return "近期未检测到明显反转形态";
  const clv = ((last.close - last.low) - (last.high - last.close)) / r;
  const bodyRatio = bodySize(last) / r;
  const lean = clv > 0.3 ? "收盘偏向当日高点" : clv < -0.3 ? "收盘偏向当日低点" : "收盘位于当日区间中部";
  const bodyNote = bodyRatio < 0.3 ? "，实体较小、多空拉锯" : "";
  return `近期未检测到明显反转形态（${lean}${bodyNote}）`;
}

// ---------- Scoring ----------
function scoreCandlestick(bars) {
  const patterns = detectPatterns(bars);
  if (patterns.length === 0) {
    return { score: baselineCandleScore(bars), patterns, baselineNote: describeBaselineCandle(bars) };
  }
  const score = Math.max(...patterns.map((p) => p.score));
  return { score, patterns };
}

// ---------- Support: how close is price to a well-tested recent low? ----------
// floor = the single lowest low in the lookback window (currently the full
// 60-day window we fetch, since `lookback` defaults to 60 and we never fetch
// more than 60 days - so this is effectively "the 60-day low").
// distPct = how far above that floor the current close is, as a percentage
// of the floor price. Smaller distPct = price is sitting right at its floor
// right now (the interesting case for a bottoming setup); larger distPct =
// price already rallied away from the low, so "is this a floor" is old news.
// touches = how many of those days had a low within 3% of the floor - more
// touches means the level has been tested repeatedly without breaking, which
// reads as a sturdier floor than one that was only ever hit once.
// Score = a base component from distPct (55/35/15, cliff-style) + 10 points
// per touch capped at 4 touches (max 40) - so max possible is 55+40=95.
function scoreSupport(bars, lookback = 60) {
  const n = bars.length;
  const win = bars.slice(Math.max(0, n - lookback), n);
  const lows = win.map((b) => b.low);
  const floor = Math.min(...lows);
  const current = bars[n - 1].close;
  const distPct = ((current - floor) / floor) * 100;
  const touches = win.filter((b) => (b.low - floor) / floor <= 0.03).length;
  let score = 0;
  if (distPct <= 6) score += 55;
  else if (distPct <= 15) score += 35;
  else score += 15;
  score += Math.min(touches, 4) * 10;
  return { score: Math.min(100, Math.round(score)), floor, distPct, touches };
}

// ---------- Volume: is selling drying up, and is buying showing up? ----------
// Two independent continuous sub-scores, both scanning a recent window
// instead of a single day, so a signal from a few days ago still counts:
//
// 1) "Shrinking" (0-35 pts): compares average volume on down-days in the
//    last 10 days vs. the prior 20 days. shrinkRatio = recent / earlier.
//    Full 35 pts at ratio <= 0.6 (down-day volume cut by 40%+), 0 pts at
//    ratio >= 1.1 (no real shrinkage), linear in between. shrinkRatio > 1
//    means down-day volume actually grew - still 0 pts, never negative.
//
// 2) "Spike on an up day" (0-45 pts): scans the last 10 days (not just the
//    most recent one) for the single up-day whose volume was the largest
//    multiple of ITS OWN trailing 20-day average volume (bestSpikeRatio).
//    Full 45 pts at 2x average or more, 0 pts at 1x (no spike at all),
//    linear in between.
//
// Base floor is 20, so total = 20 + shrinkScore + spikeScore, capped at 100.
const VOLUME_SPIKE_LOOKBACK = 10;

function scoreVolume(bars) {
  const n = bars.length;
  const recent = bars.slice(Math.max(0, n - 10), n);
  const earlier = bars.slice(Math.max(0, n - 30), Math.max(0, n - 10));
  const avgRecentDownVol = avgVolWhere(recent, (b) => b.close < b.open);
  const avgEarlierDownVol = avgVolWhere(earlier, (b) => b.close < b.open);

  let shrinkScore = 0;
  let shrinkRatio = null;
  if (avgEarlierDownVol > 0) {
    shrinkRatio = avgRecentDownVol / avgEarlierDownVol;
    shrinkScore = 35 * clamp01((1.1 - shrinkRatio) / (1.1 - 0.6));
  }
  const shrinking = shrinkRatio != null && shrinkRatio < 0.85;

  let spikeScore = 0;
  let bestSpikeRatio = null;
  const spikeStart = Math.max(20, n - VOLUME_SPIKE_LOOKBACK);
  for (let i = spikeStart; i < n; i++) {
    const day = bars[i];
    if (day.close <= day.open) continue; // only up days are candidates
    const trailingAvgVol = average(bars.slice(i - 20, i).map((b) => b.volume));
    if (trailingAvgVol <= 0) continue;
    const ratio = day.volume / trailingAvgVol;
    if (bestSpikeRatio == null || ratio > bestSpikeRatio) bestSpikeRatio = ratio;
  }
  if (bestSpikeRatio != null) {
    spikeScore = 45 * clamp01((bestSpikeRatio - 1) / (2 - 1));
  }
  const spikeOnUpDay = bestSpikeRatio != null && bestSpikeRatio > 1.3;

  const score = Math.round(Math.min(100, 20 + shrinkScore + spikeScore));
  return { score, shrinking, spikeOnUpDay, shrinkRatio, bestSpikeRatio };
}
function avgVolWhere(arr, pred) {
  const f = arr.filter(pred);
  if (f.length === 0) return 0;
  return average(f.map((b) => b.volume));
}
function average(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

// ---------- Trend: has the down-move lost steam and started turning? ----------
// Three continuous sub-scores stacked on a base floor of 20:
//
// 1) "Oversold" (0-20 pts): how deep into oversold territory RSI(14) is.
//    Full 20 pts at RSI <= 25 (deeply oversold), 0 pts at RSI >= 45, linear
//    in between - not a hard "<40 or nothing" cutoff.
//
// 2) "Recovering from oversold" (0-25 pts): how much RSI has risen over the
//    last 5 trading days, only while RSI is still below 55 (past that it's
//    not an early recovery anymore, just... an uptrend). Full 25 pts at a
//    10+ point RSI rise in 5 days, 0 pts at no rise, linear in between.
//
// 3) "MA20 turning up" (0-25 pts): the 20-day moving average's slope over
//    the last 5 trading days, as a percentage of its own level. Full 25 pts
//    at +2% or more, 0 pts at flat or falling, linear in between.
function scoreTrend(bars) {
  const closes = bars.map((b) => b.close);
  const n = closes.length;
  const rsiArr = rsi(closes, 14);
  const lastRSI = rsiArr[n - 1];
  const ma20now = sma(closes, 20, n - 1);
  const ma20prev = sma(closes, 20, Math.max(19, n - 6));

  let oversoldScore = 0;
  if (lastRSI != null) {
    oversoldScore = 20 * clamp01((45 - lastRSI) / (45 - 25));
  }

  let recoverScore = 0;
  let oversoldRecovering = false;
  if (lastRSI != null && lastRSI < 55) {
    const rsiPrev = rsiArr[Math.max(14, n - 6)];
    if (rsiPrev != null) {
      const rsiRise = lastRSI - rsiPrev;
      recoverScore = 25 * clamp01(rsiRise / 10);
      oversoldRecovering = rsiRise > 0;
    }
  }

  let maScore = 0;
  let ma20TurningUp = false;
  if (ma20now != null && ma20prev != null) {
    const slopePct = ((ma20now - ma20prev) / ma20prev) * 100;
    maScore = 25 * clamp01(slopePct / 2);
    ma20TurningUp = slopePct > 0;
  }

  const score = Math.round(Math.min(100, 20 + oversoldScore + recoverScore + maScore));
  return { score, lastRSI, oversoldRecovering, ma20TurningUp };
}

// Score -> bull/amber/bear color, used to color-code each factor at a glance
// (both on the watchlist cards and the factor bars in the detail panel).
function scoreColor(v) {
  return v >= 65 ? C.bull : v >= 40 ? C.amber : C.bear;
}

// Plain-language "what this measures" copy, written for someone with zero
// investing background - shown for every factor regardless of score.
const FACTOR_DEFINITIONS = {
  candle: `看的是：把每天的开盘价、收盘价、最高价、最低价画成一根根"蜡烛"（K线），最近这几天有没有出现历史上和"卖压耗尽、有人开始接盘"相关的经典形状——比如下影线很长的锤子线、连续几天先大跌、再企稳、再反弹的启明星。`,
  support: `看的是：现价离最近 60 个交易日里的最低点有多远，以及这个低点附近被反复"跌到就有人接、总也跌不破"的次数。跌到同一个价位却总也跌不破，说明可能有实质买盘在那个位置接手，是相对扎实的价格支撑。`,
  volume: `看的是：成交量（当天有多少股票被买卖）的变化——下跌的时候，参与卖出的量是不是在逐渐变小（说明想卖的人越来越少）；上涨的时候，有没有某天成交量明显放大（说明有真金白银在买入，不只是零星反弹）。`,
  trend: `看的是两个技术指标：① RSI——一个 0-100 的数字，衡量最近 14 天里"涨的力度"和"跌的力度"谁更强，数值越低说明跌得越"过头"；② 20日均线——最近 20 个交易日收盘价的平均值，用来看股价近期的大方向有没有从向下转成向上。`,
};

// Score-bucket interpretation copy, tailored to what each factor actually
// measures. Low-score buckets deliberately reassure that a low score means
// "this signal hasn't shown up yet", not "the stock will keep falling" -
// each factor is independent evidence, not a prediction.
function interpretScore(key, value) {
  const buckets = {
    candle: [
      [30, `低分：最近的K线还没出现这些经典反转形状——不代表股价接下来一定还会跌，只是"图形上"暂时没看到卖压耗尽的迹象，可以再观察几天。`],
      [60, `中等：K线图形上出现了一定的止跌迹象，具体是哪种形状可以看上面的"当前读数"；强度或确认度有限，建议再结合其他因子一起判断。`],
      [101, "高分：出现了较强的经典反转形态组合，图形层面释放的止跌信号比较明确。"],
    ],
    support: [
      [30, `低分：现价离最近的低点还比较远，或者这个价位被反复跌破，还没能形成稳固支撑，具体数值见上面的"当前读数"。`],
      [60, `中等：这个价位已经显示出一定支撑力，但离低点的距离或被测试的次数还不够充分，具体数值见上面的"当前读数"。`],
      [101, "高分：价格反复测试同一低点区域都没有跌破，说明这个价位有人愿意接盘，支撑相对扎实。"],
    ],
    volume: [
      [30, `低分：下跌时成交量没有明显缩小，上涨时也没看到放量买入，目前还看不出资金转向的迹象，具体数值见上面的"当前读数"。`],
      [60, `中等：出现了一定的资金转向迹象（缩量或放量至少有一项），但还不够充分或不完整，具体可以看上面的"当前读数"。`],
      [101, "高分：下跌缩量、反弹放量同时出现，说明有实际资金在这个位置进场接盘，信号相对完整可信。"],
    ],
    trend: [
      [30, `低分：目前还看不到明显的止跌迹象——RSI、均线暂时都没有转强的信号，具体可以看上面的"当前读数"。`],
      [60, `中等：出现了一部分止跌迹象（RSI走低、开始回升、或均线企稳中的一项或几项），但没有同时出现，确认力度一般，具体可以看上面的"当前读数"。`],
      [101, "高分：RSI从超卖区回升，20日均线也同时转向上，多个信号同时出现，下跌动能减弱的证据比较充分。"],
    ],
  };
  const rules = buckets[key];
  for (const [ceiling, text] of rules) {
    if (value < ceiling) return text;
  }
  return rules[rules.length - 1][1];
}

function FactorBar({ factorKey, label, value, note, color }) {
  return (
    <div className="mb-5">
      <div className="flex justify-between items-baseline mb-1">
        <span style={{ ...sans, color: C.text, fontSize: 13, fontWeight: 600 }}>{label}</span>
        <span style={{ ...mono, color, fontSize: 15, fontWeight: 700 }}>{value}</span>
      </div>
      <div style={{ height: 6, background: C.border, borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${value}%`, height: "100%", background: color, borderRadius: 4, transition: "width .4s" }} />
      </div>
      <div style={{ ...sans, color: C.textMuted, fontSize: 11, marginTop: 6, lineHeight: 1.6 }}>
        {FACTOR_DEFINITIONS[factorKey]}
      </div>
      {note && (
        <div style={{ ...mono, color: C.text, fontSize: 11, marginTop: 6, background: C.panelAlt, border: `1px solid ${C.border}`, borderRadius: 5, padding: "6px 8px" }}>
          当前读数：{note}
        </div>
      )}
      <div style={{ ...sans, color, fontSize: 11, marginTop: 6, lineHeight: 1.6, opacity: 0.9 }}>
        {interpretScore(factorKey, value)}
      </div>
    </div>
  );
}

// ---------- Per-ticker analysis panel (the original single-stock tool, now scoped to one ticker) ----------
function TickerPanel({ ticker, state, updateState, onClose }) {
  const { raw, bars, error, fetchedAt, autoFetchTried, fromCache, loading } = state;
  const [fetching, setFetching] = useState(false);
  const [showManual, setShowManual] = useState(false);

  const handleParse = (text) => {
    try {
      const parsed = parseCSV(text);
      updateState({ bars: parsed, error: "" });
    } catch (e) {
      updateState({ bars: null, error: e.message });
    }
  };

  const handleFetchLive = async ({ force = false } = {}) => {
    if (!force) {
      const cached = getCachedBars(ticker);
      if (cached) {
        updateState({
          bars: cached, raw: barsToCSV(cached), fetchedAt: new Date().toISOString(), fromCache: true,
          error: "", autoFetchTried: true,
        });
        return;
      }
    }
    setFetching(true);
    updateState({ error: "" });
    try {
      const result = await loadTickerData(ticker, { force: true });
      updateState({ ...result, error: "", autoFetchTried: true });
    } catch (e) {
      updateState({ error: e.message, autoFetchTried: true });
    } finally {
      setFetching(false);
    }
  };

  // Auto-fetch live data the first time this ticker's panel is opened - unless
  // the watchlist's background auto-loader is already fetching this same
  // ticker, in which case just wait for that instead of firing a duplicate.
  useEffect(() => {
    if (!autoFetchTried && !bars && !loading) {
      handleFetchLive();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  const results = useMemo(() => {
    if (!bars) return null;
    return {
      cs: scoreCandlestick(bars),
      sup: scoreSupport(bars),
      vol: scoreVolume(bars),
      trend: scoreTrend(bars),
    };
  }, [bars]);

  return (
    <div style={{ ...sans, padding: 24, height: "100%", overflowY: "auto" }}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Gauge size={20} color={C.gold} />
          <h1 style={{ color: C.text, fontSize: 20, fontWeight: 700, letterSpacing: 0.3 }}>
            {ticker} · 止跌形态多因子扫描器
          </h1>
        </div>
        <button
          onClick={onClose}
          className="flex items-center gap-1"
          style={{ background: "transparent", color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", fontSize: 12, cursor: "pointer" }}
        >
          <X size={14} /> 返回列表
        </button>
      </div>
      <p style={{ color: C.textMuted, fontSize: 12, marginBottom: 20 }}>
        K线形态 · 支撑位测试 · 量能变化 · 趋势动能，四项独立因子分别给分，不合成单一分数 — 不构成投资建议，仅作分析辅助。
      </p>

      <div className="grid gap-5" style={{ gridTemplateColumns: "360px 1fr" }}>
        {/* Left: input */}
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
          <div style={{ color: C.text, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>数据来源</div>
          <div style={{ color: C.textMuted, fontSize: 11, marginBottom: 10, lineHeight: 1.6 }}>
            自动获取 {ticker} 最近 60 个交易日的日线数据（数据来自 Yahoo Finance）。
          </div>
          <button
            onClick={() => handleFetchLive({ force: true })}
            disabled={fetching}
            className="flex items-center gap-1"
            style={{
              background: C.gold, color: "#1A1305", border: "none", borderRadius: 6, padding: "8px 12px",
              fontSize: 12, fontWeight: 700, cursor: fetching ? "default" : "pointer", opacity: fetching ? 0.7 : 1,
            }}
          >
            {fetching ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {fetching ? "获取中…" : bars ? "刷新数据" : "获取最新数据"}
          </button>
          {fetchedAt && !fetching && (
            <div style={{ color: C.textMuted, fontSize: 11, marginTop: 6, ...mono }}>
              上次更新：{new Date(fetchedAt).toLocaleString("zh-CN")}
              {fromCache && "（本地缓存，6小时内）"}
            </div>
          )}
          {error && (
            <div className="flex items-start gap-1 mt-3" style={{ color: C.bear, fontSize: 12 }}>
              <AlertTriangle size={14} style={{ marginTop: 1 }} /> {error}
            </div>
          )}

          <button
            onClick={() => setShowManual((v) => !v)}
            style={{ background: "transparent", color: C.textMuted, border: "none", fontSize: 11, marginTop: 16, padding: 0, cursor: "pointer", textDecoration: "underline" }}
          >
            {showManual ? "收起手动输入" : "自动获取失败？手动粘贴数据 / 加载示例数据"}
          </button>

          {showManual && (
            <div style={{ marginTop: 10 }}>
              <div style={{ color: C.textMuted, fontSize: 11, marginBottom: 8, ...mono }}>
                格式：date,open,high,low,close,volume（每行一天，至少30天）
              </div>
              <textarea
                value={raw}
                onChange={(e) => updateState({ raw: e.target.value })}
                placeholder={`粘贴 ${ticker} 的日线 OHLCV 数据…`}
                rows={10}
                style={{
                  width: "100%", background: C.panelAlt, color: C.text, border: `1px solid ${C.border}`,
                  borderRadius: 6, padding: 10, fontSize: 11, ...mono, resize: "vertical",
                }}
              />
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => handleParse(raw)}
                  className="flex items-center gap-1"
                  style={{ background: C.gold, color: "#1A1305", border: "none", borderRadius: 6, padding: "8px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                >
                  <Upload size={14} /> 解析数据
                </button>
                <button
                  onClick={() => { updateState({ raw: DEMO_CSV }); handleParse(DEMO_CSV); }}
                  className="flex items-center gap-1"
                  style={{ background: "transparent", color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 12px", fontSize: 12, cursor: "pointer" }}
                >
                  <PlayCircle size={14} /> 加载示例数据
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right: results */}
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20 }}>
          {!results ? (
            <div style={{ color: C.textMuted, fontSize: 13, textAlign: "center", padding: "60px 0" }}>
              粘贴数据或加载示例数据后，这里会显示多因子分析结果。
            </div>
          ) : (
            <div>
              <div style={{ color: C.textMuted, fontSize: 12, lineHeight: 1.6, marginBottom: 16 }}>
                以下四项因子相互独立，请分别参考，本工具不再合成单一分数——避免用一个数字掩盖不同维度之间的分歧。
                四项分数的方向是一致的：<strong style={{ color: C.text }}>分数越高，代表这一项看到的"止跌"证据越强；分数低不代表股价一定还会继续跌，只是这一项暂时还没看到支持止跌的信号，可能需要再观察，或者参考其他几项。</strong>
              </div>

              <FactorBar
                factorKey="candle"
                label="K线形态"
                value={results.cs.score}
                color={scoreColor(results.cs.score)}
                note={results.cs.patterns.length ? results.cs.patterns.map((p) => p.name).join("、") : results.cs.baselineNote}
              />
              <FactorBar
                factorKey="support"
                label="支撑位测试"
                value={results.sup.score}
                color={scoreColor(results.sup.score)}
                note={`距区间低点 ${results.sup.distPct.toFixed(1)}%，${results.sup.touches} 次测试同一支撑区`}
              />
              <FactorBar
                factorKey="volume"
                label="量能变化"
                value={results.vol.score}
                color={scoreColor(results.vol.score)}
                note={`${results.vol.shrinking ? "下跌缩量 ✓" : "下跌未明显缩量"}；${results.vol.spikeOnUpDay ? "反弹放量 ✓" : "反弹未见放量"}`}
              />
              <FactorBar
                factorKey="trend"
                label="趋势动能"
                value={results.trend.score}
                color={scoreColor(results.trend.score)}
                note={`RSI(14) ${results.trend.lastRSI ? results.trend.lastRSI.toFixed(1) : "—"}${results.trend.oversoldRecovering ? "，从超卖区回升" : ""}${results.trend.ma20TurningUp ? "；MA20 转向上" : ""}`}
              />

              <div className="flex items-start gap-2 mt-6 pt-4" style={{ borderTop: `1px solid ${C.border}` }}>
                <AlertTriangle size={14} color={C.textMuted} style={{ marginTop: 2, flexShrink: 0 }} />
                <div style={{ color: C.textMuted, fontSize: 11, lineHeight: 1.6 }}>
                  本工具基于历史价格与成交量的统计规律，K线形态和技术信号的可靠性在学术界存在争议，
                  不构成投资建议。请结合基本面分析与自身风险承受能力独立判断。
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Watchlist card on the home page ----------
const FACTOR_TILES = [
  { k: "candle", label: "K线" },
  { k: "support", label: "支撑" },
  { k: "volume", label: "量能" },
  { k: "trend", label: "趋势" },
];

function computeFactorScores(state) {
  if (!state || !state.bars) return null;
  const { bars } = state;
  return {
    candle: scoreCandlestick(bars).score,
    support: scoreSupport(bars).score,
    volume: scoreVolume(bars).score,
    trend: scoreTrend(bars).score,
  };
}

function WatchlistCard({ ticker, state, onOpen, onRemove }) {
  const scores = computeFactorScores(state);
  const hasData = !!scores;
  const isLoading = !hasData && !!state?.loading;
  const hasFailed = !hasData && !isLoading && !!state?.error;
  const statusColor = isLoading ? C.textMuted : hasFailed ? C.bear : C.textMuted;

  return (
    <div
      onClick={onOpen}
      style={{
        background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18,
        cursor: "pointer", transition: "border-color .2s, transform .2s", position: "relative",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.gold; e.currentTarget.style.transform = "translateY(-2px)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.transform = "translateY(0)"; }}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        style={{ position: "absolute", top: 10, right: 10, background: "transparent", border: "none", color: C.textMuted, cursor: "pointer", padding: 4 }}
        title="移除"
      >
        <X size={14} />
      </button>
      <div style={{ ...mono, color: C.text, fontSize: 18, fontWeight: 700, marginBottom: 10 }}>{ticker}</div>
      {hasData ? (
        <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
          {FACTOR_TILES.map(({ k, label }) => (
            <div
              key={k}
              style={{ background: C.panelAlt, border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 8px" }}
            >
              <div style={{ ...sans, color: C.textMuted, fontSize: 10 }}>{label}</div>
              <div style={{ ...mono, color: scoreColor(scores[k]), fontSize: 17, fontWeight: 700 }}>{scores[k]}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-1" style={{ color: statusColor, fontSize: 12 }}>
          {isLoading && <Loader2 size={12} className="animate-spin" />}
          <span>{isLoading ? "自动获取中…" : hasFailed ? "自动获取失败，点击重试" : "点击导入数据并查看分析"}</span>
        </div>
      )}
    </div>
  );
}

const DEFAULT_TICKER_STATE = () => ({
  raw: "", bars: null, error: "", fetchedAt: null, autoFetchTried: false, fromCache: false, loading: false,
});

const DEFAULT_TICKERS = [
  "NFLX", "TSLA", "AAPL", "NVDA", "MSFT", "AMZN", "ASML", "AMD", "AVGO", "XYZ",
  "META", "DIS", "ORCL", "GOOG", "SPY", "TSM", "MU", "GOOGL", "BRK-B", "NOW",
  "MRVL", "BKNG", "SPOT",
];

// Seeds watchlist cards with cached data (if still fresh) so scores show up
// immediately on load, without needing to open each ticker's panel first.
function hydrateFromCache(tickers) {
  const initial = {};
  for (const t of tickers) {
    const cached = getCachedBars(t);
    if (cached) {
      initial[t] = {
        ...DEFAULT_TICKER_STATE(), bars: cached, raw: barsToCSV(cached),
        fetchedAt: new Date().toISOString(), autoFetchTried: true, fromCache: true,
      };
    }
  }
  return initial;
}

// ---------- Tab: 关注股票止跌形态 (the original single-tab tool) ----------
function WatchlistTab() {
  const [tickers, setTickers] = useState(DEFAULT_TICKERS);
  const [tickerStates, setTickerStates] = useState(() => hydrateFromCache(DEFAULT_TICKERS));
  const [activeTicker, setActiveTicker] = useState(null);
  const [newTicker, setNewTicker] = useState("");

  // Hard-wipe the cache once per PST calendar day, even for a tab left open across midnight.
  useEffect(() => {
    let timer;
    const scheduleNextClear = () => {
      timer = setTimeout(() => {
        clearCache();
        scheduleNextClear();
      }, msUntilNextPstMidnight());
    };
    scheduleNextClear();
    return () => clearTimeout(timer);
  }, []);

  const getState = (t) => tickerStates[t] || DEFAULT_TICKER_STATE();

  const updateTickerState = (t, patch) => {
    setTickerStates((prev) => ({ ...prev, [t]: { ...getState(t), ...patch } }));
  };

  // Auto-load any ticker that doesn't already have cached/loaded data, so the
  // watchlist fills in on its own without the user opening each panel. Each
  // ticker's load is fully independent - one failing never touches the others.
  // Requests are staggered rather than fired all at once, since Yahoo's chart
  // endpoint is unofficial and more likely to rate-limit a simultaneous burst.
  const autoLoadedRef = useRef(new Set());
  useEffect(() => {
    let pending = 0;
    tickers.forEach((t) => {
      if (autoLoadedRef.current.has(t)) return;
      autoLoadedRef.current.add(t);
      if (getState(t).bars) return; // already have data (e.g. hydrated from cache)

      const delay = pending * 150;
      pending += 1;
      setTimeout(async () => {
        updateTickerState(t, { loading: true, error: "" });
        try {
          const result = await loadTickerData(t);
          updateTickerState(t, { ...result, error: "", autoFetchTried: true, loading: false });
        } catch (e) {
          updateTickerState(t, { error: e.message, autoFetchTried: true, loading: false });
        }
      }, delay);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers]);

  const addTicker = () => {
    const t = newTicker.trim().toUpperCase();
    if (!t || tickers.includes(t)) { setNewTicker(""); return; }
    setTickers((prev) => [...prev, t]);
    setNewTicker("");
  };

  const removeTicker = (t) => {
    setTickers((prev) => prev.filter((x) => x !== t));
    setTickerStates((prev) => {
      const next = { ...prev };
      delete next[t];
      return next;
    });
    if (activeTicker === t) setActiveTicker(null);
  };

  return (
    <div style={{ ...sans, position: "relative", minHeight: "100%" }}>
      {/* ---- Watchlist ---- */}
      <div style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
        <div className="flex items-center gap-2 mb-1">
          <Gauge size={22} color={C.gold} />
          <h1 style={{ color: C.text, fontSize: 22, fontWeight: 700, letterSpacing: 0.3 }}>我的止跌观察列表</h1>
        </div>
        <p style={{ color: C.textMuted, fontSize: 12, marginBottom: 20 }}>
          点击任意股票代码，查看它的K线形态、支撑位、量能与趋势动能多因子分析。
        </p>

        <div className="flex gap-2 mb-6">
          <input
            value={newTicker}
            onChange={(e) => setNewTicker(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTicker()}
            placeholder="添加股票代码，比如 AMZN"
            style={{
              flex: 1, background: C.panel, color: C.text, border: `1px solid ${C.border}`,
              borderRadius: 8, padding: "10px 12px", fontSize: 13, ...mono,
            }}
          />
          <button
            onClick={addTicker}
            className="flex items-center gap-1"
            style={{ background: C.gold, color: "#1A1305", border: "none", borderRadius: 8, padding: "10px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
          >
            <Plus size={14} /> 添加
          </button>
        </div>

        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
          {tickers.map((t) => (
            <WatchlistCard
              key={t}
              ticker={t}
              state={tickerStates[t]}
              onOpen={() => setActiveTicker(t)}
              onRemove={() => removeTicker(t)}
            />
          ))}
          {tickers.length === 0 && (
            <div style={{ color: C.textMuted, fontSize: 13, gridColumn: "1 / -1", textAlign: "center", padding: "40px 0" }}>
              列表是空的，添加一个股票代码开始追踪吧。
            </div>
          )}
        </div>
      </div>

      {/* ---- Backdrop ---- */}
      <div
        onClick={() => setActiveTicker(null)}
        style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
          opacity: activeTicker ? 1 : 0,
          pointerEvents: activeTicker ? "auto" : "none",
          transition: "opacity .3s ease",
          zIndex: 40,
        }}
      />

      {/* ---- Slide-in detail panel ---- */}
      <div
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0, width: "min(1100px, 100vw)",
          background: C.bg, borderLeft: `1px solid ${C.border}`, boxShadow: "-12px 0 40px rgba(0,0,0,0.35)",
          transform: activeTicker ? "translateX(0)" : "translateX(100%)",
          transition: "transform .35s cubic-bezier(.4,0,.2,1)",
          zIndex: 50,
        }}
      >
        {activeTicker && (
          <TickerPanel
            ticker={activeTicker}
            state={getState(activeTicker)}
            updateState={(patch) => updateTickerState(activeTicker, patch)}
            onClose={() => setActiveTicker(null)}
          />
        )}
      </div>
    </div>
  );
}

// ---------- Tab: Seeking Alpha 下半年选股 ----------
// Static picklist - Seeking Alpha's 2026 下半年 10-stock selection, with the
// user-provided thesis broken into structured fields for the UI. This is
// hand-curated content, not derived from any API - update it by editing this
// array if the picklist changes.
const SEEKING_ALPHA_2026H2 = [
  { ticker: "CRDO", name: "Credo Technology", sector: "半导体 · AI数据中心互连",
    thesis: "AI数据中心“高速互连”核心供应商",
    detail: "AEC（有源电缆）+ 铜缆 + 光互连三条产品线同时放量，FY2027 营收预期同比增长超80%，是AI基建扩张里的“卖水人”角色。" },
  { ticker: "LITE", name: "Lumentum Holdings", sector: "半导体 · 光通信/硅光子",
    thesis: "光通信 + 硅光子龙头",
    detail: "英伟达直接投资20亿美元，AI网络架构正从电互连转向光互连，Lumentum 是这一转向里最大的受益方之一。" },
  { ticker: "TTMI", name: "TTM Technologies", sector: "电子制造 · 高端PCB/国防",
    thesis: "高端PCB + 国防 + 数据中心",
    detail: "数据中心业务同比暴涨61%，同时吃军工订单和制造业回流红利，双引擎驱动。" },
  { ticker: "SNDK", name: "SanDisk", sector: "半导体 · 存储(NAND)",
    thesis: "NAND存储周期反转标的",
    detail: "AI存储需求 + 涨价 + 长协改善，盈利爆发力极强，是这一轮存储周期拐点里弹性较大的选手。" },
  { ticker: "STRL", name: "Sterling Infrastructure", sector: "工程建筑 · 数据中心/晶圆厂基建",
    thesis: "数据中心 & 晶圆厂“包工头”",
    detail: "场地开发、基建工程订单积压创纪录，AI数据中心相关业务占比还在提升，是实打实的硬需求。" },
  { ticker: "VICR", name: "Vicor Corporation", sector: "半导体 · 电源管理",
    thesis: "AI芯片“最后一英寸”供电方案商",
    detail: "48V垂直供电技术稀缺性拉满，订单和授权收入明显提速，解决AI芯片供电痛点的“小而美”标的。" },
  { ticker: "SEZL", name: "Sezzle", sector: "金融科技 · BNPL(先买后付)",
    thesis: "高增长BNPL金融科技",
    detail: "订阅用户、GMV、利润率齐升，但风险偏好较高，波动大，适合激进型选手。" },
  { ticker: "DAVE", name: "Dave Inc.", sector: "金融科技 · 数字银行/现金预支",
    thesis: "次级客群数字银行 + 现金预支",
    detail: "增长猛、空头比例高、估值偏贵，属于多空博弈激烈的品种。" },
  { ticker: "PACS", name: "PACS Group", sector: "医疗保健 · 专业护理/康复",
    thesis: "专业护理 + 康复机构运营商",
    detail: "老龄化 + 入住率提升 + 并购扩张，防御型配置，波动小，长线逻辑相对稳健。" },
  { ticker: "AMZN", name: "Amazon.com", sector: "大盘科技 · 电商/云计算",
    thesis: "名单里确定性最高的大盘股",
    detail: "AWS 吃生成式AI红利，电商 + 广告 + 流媒体多元 buff 加持，是名单里的“压舱石”。" },
];

// Trading-day lookback windows for each return period shown per stock -
// standard approximation (~21 trading days/month) since exact calendar-day
// alignment would need holiday-aware date matching for little practical gain.
// "1y" is null because the bars array itself is already exactly the fetched
// 1-year range, so its first bar IS the 1-year-ago anchor.
const RETURN_PERIODS = [
  { key: "1w", label: "1周", days: 5 },
  { key: "1m", label: "1月", days: 21 },
  { key: "3m", label: "3月", days: 63 },
  { key: "6m", label: "6月", days: 126 },
  { key: "1y", label: "1年", days: null },
];

function pctChangeOverDays(bars, tradingDaysAgo) {
  const n = bars.length;
  if (n < 2) return null;
  const idx = tradingDaysAgo == null ? 0 : Math.max(0, n - 1 - tradingDaysAgo);
  const from = bars[idx].close;
  const to = bars[n - 1].close;
  if (!from) return null;
  return ((to - from) / from) * 100;
}

// Fetches a full ~1-year daily-bar history (unsliced, unlike the 60-bar 6mo
// fetch the scanner tab uses) - namespaced under "TICKER@1y" in the shared
// localStorage cache so it never collides with that tab's 60-bar entries.
async function fetchQuote1y(ticker) {
  const resp = await fetch(`/api/quote?ticker=${encodeURIComponent(ticker)}&range=1y`);
  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error("获取数据失败：接口返回格式异常");
  }
  if (!resp.ok) throw new Error(data.error || "获取数据失败");
  return data.bars;
}

async function load1yTickerData(ticker, { force = false } = {}) {
  const cacheKey = `${ticker}@1y`;
  if (!force) {
    const cached = getCachedBars(cacheKey);
    if (cached) return { bars: cached, fetchedAt: new Date().toISOString(), fromCache: true };
  }
  const bars = await fetchQuote1y(ticker);
  setCachedBars(cacheKey, bars);
  return { bars, fetchedAt: new Date().toISOString(), fromCache: false };
}

// Current price refreshes on its own, much shorter cadence than the 1-year
// chart data above - a stock can move several percent within a day, so
// reusing the same 6h/sliding cache for "what's it trading at right now"
// would show a visibly stale number for most of that window. 30 min, and
// NOT sliding (slide: false) - it goes stale on a fixed schedule regardless
// of how often the card gets re-viewed, rather than resetting every time
// someone looks at it.
const PRICE_TTL_MS = 30 * 60 * 1000;

async function fetchCurrentPrice(ticker) {
  const resp = await fetch(`/api/price?ticker=${encodeURIComponent(ticker)}`);
  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error("获取股价失败：接口返回格式异常");
  }
  if (!resp.ok) throw new Error(data.error || "获取股价失败");
  return { price: data.price, asOf: data.asOf };
}

async function loadCurrentPrice(ticker, { force = false } = {}) {
  const cacheKey = `${ticker}@price`;
  if (!force) {
    const cached = getCachedBars(cacheKey, { ttlMs: PRICE_TTL_MS, slide: false });
    if (cached) return cached;
  }
  const value = await fetchCurrentPrice(ticker);
  setCachedBars(cacheKey, value);
  return value;
}

// Minimal hand-rolled line chart (no charting library in this project) -
// normalizes closes into the viewBox and draws a single polyline.
function Sparkline({ bars, color, height = 56 }) {
  if (!bars || bars.length < 2) return null;
  const width = 320;
  const closes = bars.map((b) => b.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const points = closes
    .map((c, i) => {
      const x = (i / (closes.length - 1)) * width;
      const y = height - ((c - min) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

function ReturnChip({ label, value }) {
  const color = value == null ? C.textMuted : value >= 0 ? C.bull : C.bear;
  return (
    <div style={{ background: C.panelAlt, border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 8px", textAlign: "center" }}>
      <div style={{ ...sans, color: C.textMuted, fontSize: 10 }}>{label}</div>
      <div style={{ ...mono, color, fontSize: 13, fontWeight: 700 }}>
        {value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`}
      </div>
    </div>
  );
}

function SeekingAlphaCard({ pick, state, onRefresh }) {
  const { bars, loading, error, price, priceAsOf } = state;
  // Falls back to the 1y series' last close if the lightweight price lookup
  // itself failed/hasn't loaded yet, so one flaky extra request doesn't blank
  // out a card that otherwise loaded fine.
  const currentPrice = price ?? (bars ? bars[bars.length - 1].close : null);
  const trendColor = bars && bars.length >= 2 ? (currentPrice >= bars[0].close ? C.bull : C.bear) : C.textMuted;

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18 }}>
      <div className="flex items-start justify-between mb-1">
        <div className="flex items-baseline gap-2">
          <span style={{ ...mono, color: C.text, fontSize: 18, fontWeight: 700 }}>{pick.ticker}</span>
          <span style={{ ...sans, color: C.textMuted, fontSize: 12 }}>{pick.name}</span>
        </div>
        <div className="flex items-center gap-2">
          {currentPrice != null && (
            <span style={{ ...mono, color: C.text, fontSize: 16, fontWeight: 700 }}>${currentPrice.toFixed(2)}</span>
          )}
          <button
            onClick={onRefresh}
            disabled={loading}
            style={{ background: "transparent", border: "none", color: C.textMuted, cursor: loading ? "default" : "pointer", padding: 4, display: "flex" }}
            title="刷新"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
        </div>
      </div>
      {priceAsOf && (
        <div style={{ ...mono, color: C.textMuted, fontSize: 10, textAlign: "right", marginBottom: 8 }}>
          价格更新于 {new Date(priceAsOf).toLocaleTimeString("zh-CN")}
        </div>
      )}

      <div style={{ ...sans, color: C.gold, fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{pick.thesis}</div>
      <div style={{ ...sans, color: C.textMuted, fontSize: 11, marginBottom: 3 }}>{pick.sector}</div>
      <div style={{ ...sans, color: C.textMuted, fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>{pick.detail}</div>

      {error && !bars && (
        <div className="flex items-start gap-1" style={{ color: C.bear, fontSize: 12, marginBottom: 10 }}>
          <AlertTriangle size={14} style={{ marginTop: 1 }} /> {error}
        </div>
      )}

      {bars ? (
        <>
          <div style={{ marginBottom: 10 }}>
            <Sparkline bars={bars} color={trendColor} />
          </div>
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
            {RETURN_PERIODS.map(({ key, label, days }) => (
              <ReturnChip key={key} label={label} value={pctChangeOverDays(bars, days)} />
            ))}
          </div>
        </>
      ) : (
        !error && (
          <div className="flex items-center gap-1" style={{ color: C.textMuted, fontSize: 12 }}>
            {loading && <Loader2 size={12} className="animate-spin" />}
            <span>{loading ? "获取股价数据中…" : "等待加载"}</span>
          </div>
        )
      )}
    </div>
  );
}

function SeekingAlphaTab() {
  const [tickerStates, setTickerStates] = useState({});
  const autoLoadedRef = useRef(new Set());

  const updateState = (ticker, patch) => {
    setTickerStates((prev) => ({ ...prev, [ticker]: { ...(prev[ticker] || {}), ...patch } }));
  };

  const load = async (ticker, { force = false } = {}) => {
    updateState(ticker, { loading: true, error: "" });
    try {
      // Fetched concurrently - the lightweight price lookup is a separate,
      // more-often-stale-marked request (see PRICE_TTL_MS) whose failure
      // shouldn't blank out a card whose 1-year chart data loaded fine, so
      // it's caught on its own instead of failing the whole load.
      const [barsResult, priceResult] = await Promise.all([
        load1yTickerData(ticker, { force }),
        loadCurrentPrice(ticker, { force }).catch(() => ({ price: null, asOf: null })),
      ]);
      updateState(ticker, {
        ...barsResult, price: priceResult.price, priceAsOf: priceResult.asOf, error: "", loading: false,
      });
    } catch (e) {
      updateState(ticker, { error: e.message, loading: false });
    }
  };

  // Background-load all 10 picks on mount, staggered to avoid bursting
  // Yahoo's unofficial endpoint - same pattern as the watchlist tab's loader.
  useEffect(() => {
    let pending = 0;
    SEEKING_ALPHA_2026H2.forEach(({ ticker }) => {
      if (autoLoadedRef.current.has(ticker)) return;
      autoLoadedRef.current.add(ticker);
      const delay = pending * 150;
      pending += 1;
      setTimeout(() => load(ticker), delay);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ ...sans, padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <div className="flex items-center gap-2 mb-1">
        <TrendingUp size={22} color={C.gold} />
        <h1 style={{ color: C.text, fontSize: 22, fontWeight: 700, letterSpacing: 0.3 }}>Seeking Alpha · 2026 下半年选股</h1>
      </div>
      <p style={{ color: C.textMuted, fontSize: 12, marginBottom: 20, lineHeight: 1.6 }}>
        Seeking Alpha 给出的 2026 下半年 10 只精选个股，附当前股价、过去1年走势图，以及1周/1月/3月/6月/1年涨跌幅——数据来自 Yahoo Finance，仅作研究参考，不构成投资建议。
      </p>
      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))" }}>
        {SEEKING_ALPHA_2026H2.map((pick) => (
          <SeekingAlphaCard
            key={pick.ticker}
            pick={pick}
            state={tickerStates[pick.ticker] || {}}
            onRefresh={() => load(pick.ticker, { force: true })}
          />
        ))}
      </div>
    </div>
  );
}

// ---------- Tab registry: add a new tab here (label + icon + component) ----------
const TABS = [
  { key: "watchlist", label: "关注股票止跌形态", icon: Gauge, Component: WatchlistTab },
  { key: "seeking-alpha", label: "Seeking Alpha 下半年选股", icon: TrendingUp, Component: SeekingAlphaTab },
];

// ---------- Left-hand nav sidebar ----------
function Sidebar({ activeTab, onSelect }) {
  return (
    <nav
      style={{
        width: 224, flexShrink: 0, background: C.panel, borderRight: `1px solid ${C.border}`,
        height: "100vh", position: "sticky", top: 0, boxSizing: "border-box",
        padding: "20px 12px", display: "flex", flexDirection: "column", gap: 4,
      }}
    >
      <div className="flex items-center gap-2" style={{ padding: "0 8px", marginBottom: 22 }}>
        <Gauge size={20} color={C.gold} />
        <span style={{ ...sans, color: C.text, fontSize: 15, fontWeight: 700 }}>选股工具箱</span>
      </div>
      {TABS.map(({ key, label, icon: Icon }) => {
        const active = key === activeTab;
        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            className="flex items-center gap-2"
            style={{
              ...sans, textAlign: "left", cursor: "pointer",
              background: active ? C.panelAlt : "transparent",
              color: active ? C.text : C.textMuted,
              border: `1px solid ${active ? C.border : "transparent"}`,
              borderRadius: 8, padding: "10px 10px", fontSize: 13, fontWeight: active ? 600 : 500,
            }}
          >
            <Icon size={16} color={active ? C.gold : C.textMuted} style={{ flexShrink: 0 }} />
            {label}
          </button>
        );
      })}
    </nav>
  );
}

// ---------- App shell: sidebar + active tab's content ----------
export default function App() {
  const [activeTab, setActiveTab] = useState(TABS[0].key);
  // Tabs are mounted once, the first time they're visited, and then kept
  // mounted (just hidden via CSS) for the rest of the session instead of
  // being unmounted when you switch away. Switching tabs used to fully
  // destroy the previous tab's component tree, which reset all of its local
  // state (loaded bars, prices, etc.) back to empty - so every time you came
  // back, cards briefly went blank and re-populated even though the
  // underlying data was still sitting in the localStorage cache untouched.
  // Keeping the component alive means that flash is gone, and a tab you
  // never open never fetches anything in the first place.
  const [visitedTabs, setVisitedTabs] = useState(() => new Set([TABS[0].key]));

  const selectTab = (key) => {
    setActiveTab(key);
    setVisitedTabs((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  };

  return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex" }}>
      <Sidebar activeTab={activeTab} onSelect={selectTab} />
      <div style={{ flex: 1, height: "100vh", overflowY: "auto", position: "relative" }}>
        {TABS.filter((t) => visitedTabs.has(t.key)).map(({ key, Component }) => (
          <div key={key} style={{ display: key === activeTab ? "block" : "none", height: "100%" }}>
            <Component />
          </div>
        ))}
      </div>
    </div>
  );
}
