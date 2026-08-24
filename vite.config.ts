import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Куда dev-сервер отправляет /api — на локальный бэкенд или на боевой.
 *
 * Панель везде ходит по ОТНОСИТЕЛЬНЫМ путям (`/api/...`), поэтому переключать сервер
 * достаточно в одном месте — в прокси. Через прокси, а не абсолютным адресом из
 * фронта, специально: запрос уходит со стороны Node, значит нет CORS и preflight, а
 * `changeOrigin` подставляет боевому серверу правильный Host. Токен лежит в
 * localStorage и уезжает заголовком Authorization — куки, которые бы на чужом
 * домене потерялись, тут не участвуют.
 *
 * Настройка только для разработки: собранная панель раздаётся со своего домена, там
 * `/api` и так свой.
 */
const CONFIG_PATH = fileURLToPath(new URL('./api.config.json', import.meta.url))
type ApiConfig = { useLiveApi?: boolean; liveApiUrl?: string; localApiUrl?: string }

function apiTarget(): string {
  let cfg: ApiConfig = {}
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as ApiConfig
  } catch {
    // Файла нет или он битый — работаем с локальным бэкендом, как было до конфига.
    // Ронять dev-сервер из-за пропавшей настройки незачем.
  }
  const local = cfg.localApiUrl || 'http://localhost:3001'
  const target = cfg.useLiveApi ? cfg.liveApiUrl || local : local
  const note = cfg.useLiveApi ? 'БОЕВОЙ сервер (api.config.json → useLiveApi: true)' : 'локальный бэкенд'
  console.log(`\n  /api → ${target}  —  ${note}\n`)
  return target
}

/** Поменяли api.config.json — vite перезапустится сам, руками дёргать не нужно. */
const watchApiConfig: Plugin = {
  name: 'watch-api-config',
  configureServer(server) {
    // resolve() приводит разделители к платформенным с обеих сторон — на Windows
    // watcher отдаёт путь с обратными слэшами, и сравнение строк без этого не сходится.
    const self = resolve(CONFIG_PATH)
    server.watcher.add(self)
    server.watcher.on('change', (file) => {
      if (resolve(file) === self) void server.restart()
    })
  },
}

export default defineConfig({
  plugins: [react(), watchApiConfig],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: apiTarget(), changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-ui': ['lucide-react', 'zustand', 'clsx'],
        },
      },
    },
  },
})
