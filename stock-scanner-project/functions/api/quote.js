// Cloudflare Pages Function: proxies Yahoo Finance's unofficial chart API
// (browser calls are blocked by CORS, so this has to run server-side).
// File path functions/api/quote.js -> route /api/quote (Cloudflare's file-based routing).
import { fetchYahooBars } from "../_yahoo.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const ticker = (url.searchParams.get("ticker") || "").trim().toUpperCase();

  if (!ticker) {
    return Response.json({ error: "缺少股票代码" }, { status: 400 });
  }

  try {
    const bars = await fetchYahooBars(ticker);
    return Response.json(
      { ticker, bars },
      { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=60" } }
    );
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502 });
  }
}
