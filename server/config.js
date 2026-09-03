import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '..', '.env') })

export const API_ID = Number(process.env.TELEGRAM_API_ID || '38680490')
export const API_HASH = process.env.TELEGRAM_API_HASH || 'f27c3fe31592b303c7a92e8eeaa8a7ee'
// API_PORT — наш собственный ключ и он главнее. `PORT` добавлен запасным: его
// подставляют хостинги и локальные обёртки, и без него они молча уезжают на 3001.
export const PORT = Number(process.env.API_PORT || process.env.PORT || '3001')
export const SESSIONS_DIR = path.join(__dirname, 'data', 'sessions')
export const PENDING_TTL_MS = 15 * 60 * 1000
