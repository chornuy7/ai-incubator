/**
 * §10.2: клиент Supabase. Креденшлы — из окружения (локальный .env, не в git).
 *
 * Бэкенд ходит с SECRET-ключом (аналог service_role): обходит RLS, потому что вся
 * логика доступа (роли §8.1, подписки §5.4) уже в Node-слое. SECRET в репозиторий
 * не попадает — только в .env (в .gitignore).
 *
 * Не сконфигурирован (нет URL/ключа) → getSupabase() = null, и сторы работают на
 * файлах как раньше. Переключатель — DATA_BACKEND=supabase.
 */
import { createClient } from '@supabase/supabase-js'

let client = null
let tried = false

export function supabaseEnabled() {
  return String(process.env.DATA_BACKEND || '').toLowerCase() === 'supabase'
}

/** @returns {import('@supabase/supabase-js').SupabaseClient | null} */
export function getSupabase() {
  if (tried) return client
  tried = true
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE
  if (!url || !key) return null
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return client
}
