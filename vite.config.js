import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Локально Vite не обслуживает папку api/ (это конвенция Vercel).
// Этот плагин поднимает POST /api/chat в dev-режиме, вызывая тот же
// обработчик api/chat.js, что используется и в проде на Vercel.
function devApiPlugin() {
  return {
    name: 'dev-api-chat',
    configureServer(server) {
      server.middlewares.use('/api/chat', async (req, res) => {
        try {
          let raw = ''
          for await (const chunk of req) raw += chunk
          req.body = raw ? JSON.parse(raw) : {}

          // Мини-шим под сигнатуру Vercel-хендлера (res.status().json())
          res.status = (code) => {
            res.statusCode = code
            return res
          }
          res.json = (obj) => {
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(obj))
            return res
          }

          const mod = await server.ssrLoadModule(path.resolve(__dirname, 'api/chat.js'))
          await mod.default(req, res)
        } catch (err) {
          if (!res.headersSent) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
          }
          res.end(JSON.stringify({ error: err?.message || 'dev api error' }))
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Подхватываем ключ из .env / .env.local в process.env для dev-хендлера
  const env = loadEnv(mode, process.cwd(), '')
  if (env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY
  }
  if (env.APP_PASSWORD) {
    process.env.APP_PASSWORD = env.APP_PASSWORD
  }

  return {
    plugins: [react(), devApiPlugin()],
  }
})
