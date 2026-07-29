// Cloudflare Pages Function: lightweight current-price lookup.
// Separate from /api/quote (which returns full daily-bar history) so the
// Seeking Alpha tab can refresh "what's it trading at" far more often
// without re-fetching/parsing a whole year of daily bars each time.
import { fetchYahooPrice } from "../_yahoo.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const ticker = (url.searchParams.get("ticker") || "").trim().toUpperCase();

  if (!ticker) {
    return Response.json({ error: "缺少股票代码" }, { status: 400 });
  }

  try {
    const { price, asOf } = await fetchYahooPrice(ticker);
    return Response.json(
      { ticker, price, asOf },
      { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=30" } }
    );
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502 });
  }
}
