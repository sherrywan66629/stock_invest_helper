# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

止跌形态多因子扫描器 — a stock reversal-signal scanner. The app lives in `stock-scanner-project/`, not the repo root. See [stock-scanner-project/README.md](stock-scanner-project/README.md) for the full architecture writeup (frontend/backend split, local dev vs. production, tech stack, directory structure, request walkthrough, caching). Read that file before making non-trivial changes — don't re-derive the architecture from scratch each session.

## Keep README.md in sync

**Whenever a feature is added, changed, or removed, update `stock-scanner-project/README.md` to match before considering the task done.** This includes the tech stack table, directory structure, request walkthrough, caching behavior, and the "已知限制 / 后续可迭代方向" section. The README should always describe what the code actually does right now — never let it drift into describing a past or aspirational state.

## Working in this repo

- The app is in `stock-scanner-project/` — `cd` there before running `npm` commands.
- `npm run dev` starts the local dev server at `localhost:5173`. It's plain Vite plus a dev-only middleware (`vite.config.js`) that simulates the Cloudflare Pages Function locally, so no separate backend process or account login is needed for local testing.
- Production's actual backend is a Cloudflare Pages Function (`functions/api/quote.js`) — a different entry point than local dev's middleware, though both call the same shared logic in `functions/_yahoo.js`.
- Deploys automatically via Cloudflare Pages' Git integration on push to `main` — no manual deploy step.

## Conventions from this project's history

- User-facing text (UI copy, error messages) stays in Chinese — the primary user's preferred language.
- For any frontend/UI change, actually start the dev server and verify it in a browser (the Claude Browser tool) before reporting the work as done — don't rely on code review alone.
- Don't commit or push without being explicitly asked to.
