/**
 * §10.2: общий KV-стор для мелких конфигов (`app_settings`).
 *
 * Правило со звонка 27.07 — «всё из БД, внутри самого кода этого быть не должно».
 * Хранение в JSON-файле рядом с процессом это тот же изъян: на нескольких инстансах
 * настройки разъедутся, а при переезде на хостинг просто исчезнут.
 *
 * Но заводить по таблице на каждый объект настроек незачем: у общих настроек, настроек
 * ИИ, safety-лимитов и чёрного списка нет отношений — только «ключ → значение». Поэтому
 * одна таблица `app_settings` и этот помощник.
 *
 * Файловый путь сохранён как есть: без DATA_BACKEND=supabase (тесты, локальный запуск)
 * всё работает по-старому, и переключение бэкенда не требует правок в сторах.
 */
import { getSupabase, supabaseEnabled } from './supabase.js'
import { readJson, writeJson } from './jsonStore.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }

/**
 * Прочитать значение по ключу.
 * @param {string} key ключ в app_settings
 * @param {string|(()=>string)} file путь к файлу для файлового режима (ленивый — путь
 *        могут переопределить через env уже после импорта модуля, как в тестах)
 * @param {any} fallback что вернуть, если ничего не сохранено
 */
export async function kvRead(key, file, fallback) {
  const db = sb()
  if (db) {
    const { data, error } = await db.from('app_settings').select('value').eq('key', key).maybeSingle()
    // Таблицы ещё нет (миграция не применена) — читаем файл, чтобы приложение работало.
    if (error) return readJson(typeof file === 'function' ? file() : file, fallback)
    return data?.value ?? fallback
  }
  return readJson(typeof file === 'function' ? file() : file, fallback)
}

/** Записать значение по ключу. */
export async function kvWrite(key, file, value) {
  const db = sb()
  if (db) {
    const { error } = await db.from('app_settings')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    if (!error) return value
    // Не молчим: без таблицы настройка сохранится только в файл, и это надо знать.
    console.warn(`[kv] ${key}: не удалось записать в app_settings (${error.message}) — примените supabase/migrations/2026-07-30-remaining-stores.sql`)
  }
  await writeJson(typeof file === 'function' ? file() : file, value)
  return value
}
