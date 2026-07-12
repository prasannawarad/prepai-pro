import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Serves the api/ handlers at their production paths during `npm run dev`,
// mirroring how Vercel serves them, so the client code is identical in both.
const API_ROUTES = {
  '/api/gemini': 'api/gemini.js',
  '/api/transcribe': 'api/transcribe.js',
}

function devApiPlugin() {
  return {
    name: 'dev-api',
    async configureServer(server) {
      for (const [route, modulePath] of Object.entries(API_ROUTES)) {
        // Vite bundles this config into node_modules/.vite-temp, so relative
        // dynamic imports break — resolve from the project root instead.
        const moduleUrl = pathToFileURL(path.resolve(process.cwd(), modulePath)).href
        const { default: handler } = await import(moduleUrl)
        server.middlewares.use(route, async (req, res) => {
          // Minimal shim for the Vercel (req, res) helpers the handlers use.
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
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  for (const key of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
    if (env[key] && !process.env[key]) process.env[key] = env[key]
  }
  return {
    plugins: [react(), devApiPlugin()],
  }
})
