// localStorage-backed cache for fetched OHLCV bars, keyed by ticker.
// - Sliding 6h TTL: every cache hit resets the countdown from that moment.
// - Hard reset once per PST calendar day, independent of the sliding TTL.
const CACHE_KEY = "stock-scanner-cache-v1";
const TTL_MS = 6 * 60 * 60 * 1000;

function pstDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function loadStore() {
  const today = pstDateString();
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return { day: today, entries: {} };
    const parsed = JSON.parse(raw);
    if (parsed.day !== today) {
      // PST day rolled over since this was last written - wipe immediately,
      // don't wait for the next write to overwrite the stale bytes.
      const fresh = { day: today, entries: {} };
      saveStore(fresh);
      return fresh;
    }
    return parsed;
  } catch {
    return { day: today, entries: {} };
  }
}

function saveStore(store) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(store));
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) - cache is best-effort only
  }
}

// ttlMs/slide let callers use a different freshness policy under the same
// store - e.g. the Seeking Alpha tab's current-price cache uses a much
// shorter, non-sliding TTL (see App.jsx) instead of the default 6h/sliding
// policy the daily-bar caches (both the 6mo and @1y ones) rely on.
export function getCachedBars(ticker, { ttlMs = TTL_MS, slide = true } = {}) {
  const store = loadStore();
  const entry = store.entries[ticker];
  if (!entry || Date.now() - entry.fetchedAt > ttlMs) return null;
  if (slide) {
    entry.fetchedAt = Date.now();
    saveStore(store);
  }
  return entry.bars;
}

export function setCachedBars(ticker, bars) {
  const store = loadStore();
  store.entries[ticker] = { bars, fetchedAt: Date.now() };
  saveStore(store);
}

export function clearCache() {
  saveStore({ day: pstDateString(), entries: {} });
}

function msSincePstMidnight() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const hour = get("hour") % 24;
  return ((hour * 60 + get("minute")) * 60 + get("second")) * 1000;
}

export function msUntilNextPstMidnight() {
  return 24 * 60 * 60 * 1000 - msSincePstMidnight();
}
