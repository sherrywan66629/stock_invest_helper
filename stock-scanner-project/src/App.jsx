import React, { useState, useMemo } from "react";
import { TrendingDown, TrendingUp, BarChart3, Gauge, AlertTriangle, Upload, PlayCircle } from "lucide-react";

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

// ---------- Candlestick pattern detection (last bar context) ----------
function bodySize(b) { return Math.abs(b.close - b.open); }
function range(b) { return b.high - b.low; }
function lowerShadow(b) { return Math.min(b.open, b.close) - b.low; }
function upperShadow(b) { return b.high - Math.max(b.open, b.close); }

function detectPatterns(bars) {
  const n = bars.length;
  const patterns = [];
  const last = bars[n - 1], prev = bars[n - 2], prev2 = bars[n - 3];

  // Hammer: small body, long lower shadow (>=2x body), short upper shadow, in a downtrend
  if (last && range(last) > 0) {
    const body = bodySize(last);
    const lowSh = lowerShadow(last);
    const upSh = upperShadow(last);
    if (body <= range(last) * 0.35 && lowSh >= body * 2 && upSh <= body * 0.6) {
      patterns.push({ name: "锤子线 Hammer", strength: 0.6, day: last.date });
    }
  }
  // Doji: body very small relative to range
  if (last && range(last) > 0 && bodySize(last) <= range(last) * 0.1) {
    patterns.push({ name: "十字星 Doji", strength: 0.35, day: last.date });
  }
  // Bullish engulfing: prev red, last green, last body engulfs prev body
  if (prev && last && prev.close < prev.open && last.close > last.open) {
    if (last.open <= prev.close && last.close >= prev.open) {
      patterns.push({ name: "看涨吞没 Bullish Engulfing", strength: 0.7, day: last.date });
    }
  }
  // Morning star: big down day, small-body middle day (gap down), big up day closing into first candle's body
  if (prev2 && prev && last) {
    const day1Down = prev2.close < prev2.open && bodySize(prev2) > range(prev2) * 0.5;
    const day2Small = bodySize(prev) <= range(prev2) * 0.4;
    const day3Up = last.close > last.open && last.close >= (prev2.open + prev2.close) / 2;
    if (day1Down && day2Small && day3Up) {
      patterns.push({ name: "启明星 Morning Star", strength: 0.85, day: last.date });
    }
  }
  return patterns;
}

// ---------- Scoring ----------
function scoreCandlestick(bars) {
  const patterns = detectPatterns(bars);
  if (patterns.length === 0) return { score: 15, patterns };
  const best = Math.max(...patterns.map((p) => p.strength));
  return { score: Math.round(15 + best * 80), patterns };
}

function scoreSupport(bars, lookback = 60) {
  const n = bars.length;
  const win = bars.slice(Math.max(0, n - lookback), n);
  const lows = win.map((b) => b.low);
  const floor = Math.min(...lows);
  const current = bars[n - 1].close;
  const distPct = ((current - floor) / floor) * 100;
  // touches: how many bars came within 3% of the floor
  const touches = win.filter((b) => (b.low - floor) / floor <= 0.03).length;
  let score = 0;
  if (distPct <= 6) score += 55;
  else if (distPct <= 15) score += 35;
  else score += 15;
  score += Math.min(touches, 4) * 10;
  return { score: Math.min(100, Math.round(score)), floor, distPct, touches };
}

function scoreVolume(bars) {
  const n = bars.length;
  const recent = bars.slice(Math.max(0, n - 10), n);
  const earlier = bars.slice(Math.max(0, n - 30), Math.max(0, n - 10));
  const avgRecentDownVol = avgVolWhere(recent, (b) => b.close < b.open);
  const avgEarlierDownVol = avgVolWhere(earlier, (b) => b.close < b.open);
  const shrinking = avgEarlierDownVol > 0 && avgRecentDownVol < avgEarlierDownVol * 0.85;
  const last = bars[n - 1];
  const avgVol20 = average(bars.slice(Math.max(0, n - 21), n - 1).map((b) => b.volume));
  const spikeOnUpDay = last.close > last.open && last.volume > avgVol20 * 1.3;
  let score = 20;
  if (shrinking) score += 35;
  if (spikeOnUpDay) score += 45;
  return { score: Math.min(100, score), shrinking, spikeOnUpDay, avgRecentDownVol, avgEarlierDownVol };
}
function avgVolWhere(arr, pred) {
  const f = arr.filter(pred);
  if (f.length === 0) return 0;
  return average(f.map((b) => b.volume));
}
function average(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function scoreTrend(bars) {
  const closes = bars.map((b) => b.close);
  const n = closes.length;
  const rsiArr = rsi(closes, 14);
  const lastRSI = rsiArr[n - 1];
  const ma20now = sma(closes, 20, n - 1);
  const ma20prev = sma(closes, 20, Math.max(19, n - 6));
  const ma50 = sma(closes, 50, n - 1);
  let score = 20;
  let oversoldRecovering = false;
  if (lastRSI != null) {
    if (lastRSI < 40) score += 20;
    // recovering: RSI now higher than 5 bars ago while still low-ish
    const rsiPrev = rsiArr[Math.max(14, n - 6)];
    if (rsiPrev != null && lastRSI > rsiPrev && lastRSI < 55) { score += 25; oversoldRecovering = true; }
  }
  let ma20TurningUp = false;
  if (ma20now != null && ma20prev != null && ma20now > ma20prev) { score += 25; ma20TurningUp = true; }
  return { score: Math.min(100, Math.round(score)), lastRSI, ma20now, ma50, oversoldRecovering, ma20TurningUp };
}

// ---------- Gauge ----------
function Gauge_({ value, size = 150 }) {
  const r = size / 2 - 12;
  const cx = size / 2, cy = size / 2;
  const startAngle = -210, endAngle = 30; // 240-degree arc
  const angle = startAngle + (value / 100) * (endAngle - startAngle);
  const toXY = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const [sx, sy] = toXY(startAngle);
  const [ex, ey] = toXY(angle);
  const largeArc = angle - startAngle > 180 ? 1 : 0;
  const color = value >= 65 ? C.bull : value >= 40 ? C.amber : C.bear;
  const [bgex, bgey] = toXY(endAngle);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <path d={`M ${sx} ${sy} A ${r} ${r} 0 1 1 ${bgex} ${bgey}`} fill="none" stroke={C.border} strokeWidth="12" strokeLinecap="round" />
      <path d={`M ${sx} ${sy} A ${r} ${r} 0 ${largeArc} 1 ${ex} ${ey}`} fill="none" stroke={color} strokeWidth="12" strokeLinecap="round" />
      <text x={cx} y={cy - 2} textAnchor="middle" fill={C.text} fontSize="30" fontWeight="700" style={mono}>{value}</text>
      <text x={cx} y={cy + 20} textAnchor="middle" fill={C.textMuted} fontSize="11" style={sans}>综合得分 / 100</text>
    </svg>
  );
}

// Plain-language "what this measures" copy, shown for every factor regardless of score
const FACTOR_DEFINITIONS = {
  candle: "衡量最近几天的K线形状，有没有出现历史上和止跌相关的经典图形（比如锤子线、启明星）。反映的是价格图形本身的信号。",
  support: "衡量现价离近期最低点有多远，以及这个低点区域被反复测试而没跌破的次数。反映的是这个价位有没有人愿意接盘。",
  volume: "衡量下跌时成交量（当天参与买卖的股数）有没有逐渐变小，反弹时成交量有没有明显放大。反映的是有没有真金白银的资金在进场。",
  trend: "衡量RSI指标（过去14天涨跌力度的对比，0-100）是否处于超卖区并开始回升，以及20日均线是否转向上。反映的是这轮下跌的速度有没有开始变慢。",
};

// Score-bucket interpretation copy, tailored to what each factor actually measures
function interpretScore(key, value) {
  const buckets = {
    candle: [
      [30, "低分：近期没有出现明显的反转图形，形态层面暂时没有确认信号（不代表不会出现，只是现在还没看到）。"],
      [60, "中等：出现了一定的反转迹象，但强度或规模有限，还不算强确认。"],
      [101, "高分：出现了较强的经典反转形态组合，形态层面确认信号较强。"],
    ],
    support: [
      [30, "低分：现价离近期低点还比较远，或者反复跌破同一区域，说明这个价位还没形成有效支撑。"],
      [60, "中等：价格在低点附近有一定支撑，但测试次数还不多，稳固程度一般。"],
      [101, "高分：价格反复测试同一低点区域都没有跌破，说明这个价位的支撑相对扎实。"],
    ],
    volume: [
      [30, "低分：下跌没有缩量，反弹也没有放量，还看不到资金转向的迹象。"],
      [60, "中等：只出现了一半信号（比如下跌缩量了，但反弹没放量；或者相反），说明卖压在减弱，但买盘还没明显跟上。"],
      [101, "高分：下跌缩量、反弹放量同时出现，说明有实际资金在进场接盘，信号相对完整。"],
    ],
    trend: [
      [30, "低分：还没进入超卖区，或者价格/均线依然偏弱，下跌的速度还没有减慢的迹象。"],
      [60, "中等：已经进入超卖区（跌得比较急了），但还没看到RSI回升或均线拐头这类喘气动作的确认。"],
      [101, "高分：超卖后已经出现回升，均线也开始转向上，说明下跌动能减弱的证据比较充分。"],
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

export default function StockBottomScanner() {
  const [raw, setRaw] = useState("");
  const [bars, setBars] = useState(null);
  const [error, setError] = useState("");
  const [weights, setWeights] = useState({ candle: 25, support: 25, volume: 25, trend: 25 });

  const handleParse = (text) => {
    try {
      const parsed = parseCSV(text);
      setBars(parsed);
      setError("");
    } catch (e) {
      setError(e.message);
      setBars(null);
    }
  };

  const results = useMemo(() => {
    if (!bars) return null;
    const cs = scoreCandlestick(bars);
    const sup = scoreSupport(bars);
    const vol = scoreVolume(bars);
    const trend = scoreTrend(bars);
    const totalW = weights.candle + weights.support + weights.volume + weights.trend || 1;
    const composite = Math.round(
      (cs.score * weights.candle + sup.score * weights.support + vol.score * weights.volume + trend.score * weights.trend) / totalW
    );
    return { cs, sup, vol, trend, composite };
  }, [bars, weights]);

  const setW = (k, v) => setWeights((prev) => ({ ...prev, [k]: v }));

  return (
    <div style={{ background: C.bg, minHeight: 600, padding: 24, ...sans }}>
      <div className="flex items-center gap-2 mb-1">
        <Gauge size={20} color={C.gold} />
        <h1 style={{ color: C.text, fontSize: 20, fontWeight: 700, letterSpacing: 0.3 }}>止跌形态多因子扫描器</h1>
      </div>
      <p style={{ color: C.textMuted, fontSize: 12, marginBottom: 20 }}>
        综合K线形态 · 支撑位测试 · 量能变化 · 趋势动能，输出可解释的合成分数 — 不构成投资建议，仅作分析辅助。
      </p>

      <div className="grid gap-5" style={{ gridTemplateColumns: "360px 1fr" }}>
        {/* Left: input */}
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
          <div style={{ color: C.text, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>数据输入</div>
          <div style={{ color: C.textMuted, fontSize: 11, marginBottom: 8, ...mono }}>
            格式：date,open,high,low,close,volume（每行一天，至少30天）
          </div>
          <textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder="粘贴日线 OHLCV 数据…"
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
              onClick={() => { setRaw(DEMO_CSV); handleParse(DEMO_CSV); }}
              className="flex items-center gap-1"
              style={{ background: "transparent", color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 12px", fontSize: 12, cursor: "pointer" }}
            >
              <PlayCircle size={14} /> 加载示例数据
            </button>
          </div>
          {error && (
            <div className="flex items-start gap-1 mt-3" style={{ color: C.bear, fontSize: 12 }}>
              <AlertTriangle size={14} style={{ marginTop: 1 }} /> {error}
            </div>
          )}

          <div style={{ color: C.text, fontSize: 13, fontWeight: 600, marginTop: 20, marginBottom: 8 }}>因子权重（可调整）</div>
          {[
            { k: "candle", label: "K线形态" },
            { k: "support", label: "支撑位" },
            { k: "volume", label: "量能" },
            { k: "trend", label: "趋势动能" },
          ].map(({ k, label }) => (
            <div key={k} className="mb-2">
              <div className="flex justify-between" style={{ fontSize: 11, color: C.textMuted }}>
                <span>{label}</span><span style={mono}>{weights[k]}</span>
              </div>
              <input
                type="range" min={0} max={100} value={weights[k]}
                onChange={(e) => setW(k, parseInt(e.target.value))}
                style={{ width: "100%" }}
              />
            </div>
          ))}
        </div>

        {/* Right: results */}
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20 }}>
          {!results ? (
            <div style={{ color: C.textMuted, fontSize: 13, textAlign: "center", padding: "60px 0" }}>
              粘贴数据或加载示例数据后，这里会显示多因子分析结果。
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-8 mb-6">
                <Gauge_ value={results.composite} />
                <div>
                  <div style={{ color: C.text, fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
                    {results.composite >= 65 ? "止跌信号较强" : results.composite >= 40 ? "信号中性偏弱，需更多确认" : "止跌信号不足"}
                  </div>
                  <div style={{ color: C.textMuted, fontSize: 12, lineHeight: 1.6 }}>
                    分数由四个独立因子加权得出，任何单一因子都不足以下结论，
                    建议结合更大周期走势与基本面信息交叉验证。
                  </div>
                </div>
              </div>

              <FactorBar
                factorKey="candle"
                label="K线形态"
                value={results.cs.score}
                color={C.gold}
                note={results.cs.patterns.length ? results.cs.patterns.map((p) => p.name).join("、") : "近期未检测到明显反转形态"}
              />
              <FactorBar
                factorKey="support"
                label="支撑位测试"
                value={results.sup.score}
                color={C.bull}
                note={`距区间低点 ${results.sup.distPct.toFixed(1)}%，${results.sup.touches} 次测试同一支撑区`}
              />
              <FactorBar
                factorKey="volume"
                label="量能变化"
                value={results.vol.score}
                color={C.amber}
                note={`${results.vol.shrinking ? "下跌缩量 ✓" : "下跌未明显缩量"}；${results.vol.spikeOnUpDay ? "反弹放量 ✓" : "反弹未见放量"}`}
              />
              <FactorBar
                factorKey="trend"
                label="趋势动能"
                value={results.trend.score}
                color={C.bear}
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
