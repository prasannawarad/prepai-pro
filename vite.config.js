import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Serves api/gemini.js at /api/gemini during `npm run dev`, mirroring how
// Vercel serves it in production, so the client code is identical in both.
function devApiPlugin() {
  return {
    name: 'dev-api-gemini',
    async configureServer(server) {
      const { default: handler } = await import('./api/gemini.js')
      server.middlewares.use('/api/gemini', async (req, res) => {
        // Minimal shim for the Vercel (req, res) helpers the handler uses.
        res.status = (code) => { res.statusCode = code; return res }
        res.json = (obj) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(obj))
        }
        try {
          let raw = ''
          for await (const chunk of req) raw += chunk
          req.body = raw ? JSON.parse(raw) : {}
        } catch {
          return res.status(400).json({ error: 'Invalid JSON body.' })
        }
        await handler(req, res)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  if (env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY) {
    process.env.GEMINI_API_KEY = env.GEMINI_API_KEY
  }
  return {
    plugins: [react(), devApiPlugin()],
  }
})
