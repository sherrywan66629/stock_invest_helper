import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fetchYahooBars, fetchYahooPrice } from './functions/_yahoo.js'

// Serves /api/quote and /api/price during `vite dev` by running the same
// logic the Cloudflare Pages Functions (functions/api/quote.js,
// functions/api/price.js) use in production, so local dev needs no separate
// backend process.
function yahooQuoteDevMiddleware() {
  return {
    name: 'yahoo-quote-dev-middleware',
    configureServer(server) {
      server.middlewares.use('/api/quote', async (req, res) => {
        const params = new URL(req.url, 'http://localhost').searchParams
        const ticker = (params.get('ticker') || '').trim().toUpperCase()
        const range = params.get('range') || '6mo'
        res.setHeader('Content-Type', 'application/json')
        if (!ticker) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: '缺少股票代码' }))
          return
        }
        try {
          const bars = await fetchYahooBars(ticker, range === '6mo' ? { range, limit: 60 } : { range, limit: null })
          res.statusCode = 200
          res.end(JSON.stringify({ ticker, bars }))
        } catch (e) {
          res.statusCode = 502
          res.end(JSON.stringify({ error: e.message }))
        }
      })

      server.middlewares.use('/api/price', async (req, res) => {
        const params = new URL(req.url, 'http://localhost').searchParams
        const ticker = (params.get('ticker') || '').trim().toUpperCase()
        res.setHeader('Content-Type', 'application/json')
        if (!ticker) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: '缺少股票代码' }))
          return
        }
        try {
          const { price, asOf } = await fetchYahooPrice(ticker)
          res.statusCode = 200
          res.end(JSON.stringify({ ticker, price, asOf }))
        } catch (e) {
          res.statusCode = 502
          res.end(JSON.stringify({ error: e.message }))
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), yahooQuoteDevMiddleware()],
})
