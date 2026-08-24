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

/**
 * §11.3 (кол 29.07): проверка пары e-mail/пароль через Supabase Auth.
 *
 * Одноразовый клиент, чтобы НЕ трогать auth-состояние общего сервисного клиента (он ходит
 * за данными). GoTrue-токен нам не нужен — свою подписанную сессию мы выпускаем сами; здесь
 * только «правильный ли пароль». @returns auth-user при успехе, иначе null.
 */
export async function verifyAuthPassword(email, password) {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE
  if (!url || !key) return null
  const c = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  try {
    const { data, error } = await c.auth.signInWithPassword({
      email: String(email || '').trim().toLowerCase(),
      password: String(password || ''),
    })
    if (error || !data?.user) return null
    return data.user
  } catch { return null }
  finally { try { await c.auth.signOut() } catch { /* нет сессии — не важно */ } }
}

/**
 * Ответ Postgres «такой таблицы нет» — значит миграцию ещё не накатили.
 *
 * Код уезжает на прод пушем, а миграции применяются руками через SQL Editor: между
 * этими моментами всегда есть окно. Витрины (кэш парсинга, база оплат) в этом окне
 * должны отработать на файловом хранилище, а не уронить страницу. Отличать «нет
 * таблицы» от настоящей ошибки обязательно: иначе тихий фолбэк спрячет реальную беду.
 *
 * `42P01` — код undefined_table у Postgres; PostgREST дополнительно отвечает
 * «Could not find the table … in the schema cache», когда таблицы нет в кэше схемы.
 */
export function isMissingTable(error) {
  if (!error) return false
  return /42P01|does not exist|schema cache/i.test(`${error.code || ''} ${error.message || ''}`)
}
