// Shared fetch logic used by both the Cloudflare Pages Function (functions/api/quote.js)
// and the local Vite dev-server middleware (vite.config.js), so `npm run dev`
// works without needing a separate backend process.
export async function fetchYahooBars(ticker) {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  let lastError = "获取数据失败";

  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?range=6mo&interval=1d`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; StockScanner/1.0)" },
      });
      if (!resp.ok) {
        lastError = resp.status === 404 ? `未找到股票代码 ${ticker}` : `Yahoo Finance 返回错误 (${resp.status})`;
        continue;
      }
      const data = await resp.json();
      const result = data?.chart?.result?.[0];
      if (!result || !result.timestamp) {
        lastError = data?.chart?.error?.description || `未找到股票代码 ${ticker}`;
        continue;
      }
      const timestamps = result.timestamp;
      const q = result.indicators.quote[0];
      const bars = [];
      for (let i = 0; i < timestamps.length; i++) {
        const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
        if ([o, h, l, c, v].some((x) => x == null)) continue;
        bars.push({
          date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
          open: o,
          high: h,
          low: l,
          close: c,
          volume: v,
        });
      }
      const recent = bars.slice(-60);
      if (recent.length < 30) {
        lastError = "有效交易日数据不足30天，无法分析";
        continue;
      }
      return recent;
    } catch (e) {
      lastError = e.message || lastError;
    }
  }

  throw new Error(lastError);
}
