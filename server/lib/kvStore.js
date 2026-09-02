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
import { getSupabase, supabaseEnabled, isMissingTable } from './supabase.js'
import { readJson, writeJson } from './jsonStore.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }

/**
 * MR-290: в файл уходит РОВНО один случай — «таблицы ещё нет» (миграция не доехала).
 * Раньше сюда же проваливалась любая ошибка: отказ в правах, разрыв соединения, битый
 * запрос. Настройка при этом сохранялась в локальный файл, интерфейс показывал успех, а
 * на другом инстансе её просто не было. Молчаливое расхождение дороже видимой ошибки.
 * @param {{message?:string, code?:string}} error @param {string} key @param {string} op
 */
function fileFallbackOrThrow(error, key, op) {
  if (isMissingTable(error)) {
    console.warn(`[kv] ${key}: таблицы app_settings ещё нет (${error.message}) — ${op} по файлу. Примените миграции: npm run migrate`)
    return
  }
  throw new Error(`[kv] ${key}: ${op} не удалось: ${error.message || error}`)
}

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
    if (error) {
      fileFallbackOrThrow(error, key, 'чтение')
      return readJson(typeof file === 'function' ? file() : file, fallback)
    }
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
    fileFallbackOrThrow(error, key, 'запись')
  }
  await writeJson(typeof file === 'function' ? file() : file, value)
  return value
}
