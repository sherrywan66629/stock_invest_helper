// Cloudflare Pages Function: proxies Yahoo Finance's unofficial chart API
// (browser calls are blocked by CORS, so this has to run server-side).
// File path functions/api/quote.js -> route /api/quote (Cloudflare's file-based routing).
import { fetchYahooBars } from "../_yahoo.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const ticker = (url.searchParams.get("ticker") || "").trim().toUpperCase();
  const range = url.searchParams.get("range") || "6mo";

  if (!ticker) {
    return Response.json({ error: "缺少股票代码" }, { status: 400 });
  }

  try {
    // range=6mo (default) keeps the original 60-bar behavior the four-factor
    // scanner depends on; any other range (e.g. "1y") returns everything
    // Yahoo gives back for that range, unsliced.
    const bars = await fetchYahooBars(ticker, range === "6mo" ? { range, limit: 60 } : { range, limit: null });
    return Response.json(
      { ticker, bars },
      { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=60" } }
    );
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502 });
  }
}
