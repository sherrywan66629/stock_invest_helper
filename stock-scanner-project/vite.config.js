import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fetchYahooBars } from './functions/_yahoo.js'

// Serves /api/quote during `vite dev` by running the same logic the Cloudflare
// Pages Function (functions/api/quote.js) uses in production, so local dev
// needs no separate backend process.
function yahooQuoteDevMiddleware() {
  return {
    name: 'yahoo-quote-dev-middleware',
    configureServer(server) {
      server.middlewares.use('/api/quote', async (req, res) => {
        const ticker = (new URL(req.url, 'http://localhost').searchParams.get('ticker') || '').trim().toUpperCase()
        res.setHeader('Content-Type', 'application/json')
        if (!ticker) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: '缺少股票代码' }))
          return
        }
        try {
          const bars = await fetchYahooBars(ticker)
          res.statusCode = 200
          res.end(JSON.stringify({ ticker, bars }))
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
