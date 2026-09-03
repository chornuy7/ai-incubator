/**
 * MR-185: тексты промптов модулей — по владельцу и в общей базе.
 *
 * Созвон 24.08: «при редактировании промтов применяется на всех пользователей свои
 * промты, а должно применяться только на 1 аккаунт». Тексты лежали в памяти браузера
 * без имени владельца — правка одного человека доставалась всем, кто заходит с этого
 * компьютера, а со своего второго устройства он своих правок не видел.
 *
 * ЧТО ХРАНИМ. Только ИЗМЕНЁННЫЕ тексты, строкой на карточку. Заводские подставляет
 * вызывающий код: копировать их каждому новому пользователю значило бы намертво
 * приколотить сегодняшнюю формулировку — правка заводского текста не доехала бы ни до
 * кого. Вернули карточке заводской вид — строка удаляется, а не хранится копией дефолта.
 *
 * Файловый режим (без DATA_BACKEND=supabase) оставлен как у остальных сторов: локальный
 * запуск и тесты работают без базы.
 */
import { getSupabase, supabaseEnabled } from './lib/supabase.js'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }
/** Путь вычисляем лениво: тесты подменяют его через env уже после импорта модуля. */
const FILE = () => process.env.USER_PROMPTS_FILE || dataPath('user-prompts.json')

const key = (userId, moduleKey) => `${userId}::${moduleKey}`
const clean = (v) => String(v ?? '').trim()

/**
 * Изменённые промпты пользователя в модуле.
 * @param {string} userId @param {string} moduleKey
 * @returns {Promise<Record<number, string>>} номер карточки → текст (только изменённые)
 */
export async function getUserPrompts(userId, moduleKey) {
  const uid = clean(userId)
  const mod = clean(moduleKey)
  if (!uid || !mod) return {}
  const db = sb()
  if (db) {
    const { data, error } = await db.from('user_prompts').select('idx, body').eq('user_id', uid).eq('module_key', mod)
    // Таблицы ещё нет (миграция не накатана) — не роняем модуль: человек увидит
    // заводские тексты, а не пустой экран.
    if (error) {
      if (isMissingTable(error)) return {}
      throw new Error(error.message)
    }
    return Object.fromEntries((data || []).map((r) => [Number(r.idx), String(r.body ?? '')]))
  }
  const all = await readJson(FILE(), {})
  return { ...(all[key(uid, mod)] || {}) }
}

/**
 * Сохранить набор карточек модуля. Приходит ПОЛНЫЙ список текстов — что совпало с
 * заводским, здесь же и вычищается, чтобы в базе не копились копии дефолтов.
 *
 * @param {string} userId @param {string} moduleKey
 * @param {string[]} bodies тексты по порядку карточек
 * @param {string[]} defaults заводские тексты того же модуля
 */
export async function saveUserPrompts(userId, moduleKey, bodies, defaults = []) {
  const uid = clean(userId)
  const mod = clean(moduleKey)
  if (!uid || !mod || !Array.isArray(bodies)) return {}

  const changed = []
  const removed = []
  bodies.forEach((raw, i) => {
    const body = String(raw ?? '')
    // Пустую карточку считаем возвратом к заводскому: хранить пустоту нечего, а модуль
    // без текста промпта работать не должен.
    if (!body.trim() || body === String(defaults[i] ?? '')) removed.push(i)
    else changed.push({ idx: i, body })
  })

  const db = sb()
  if (db) {
    if (changed.length) {
      const rows = changed.map((c) => ({ user_id: uid, module_key: mod, idx: c.idx, body: c.body, updated_at: new Date().toISOString() }))
      const { error } = await db.from('user_prompts').upsert(rows, { onConflict: 'user_id,module_key,idx' })
      if (error && !isMissingTable(error)) throw new Error(error.message)
    }
    if (removed.length) {
      const { error } = await db.from('user_prompts').delete().eq('user_id', uid).eq('module_key', mod).in('idx', removed)
      if (error && !isMissingTable(error)) throw new Error(error.message)
    }
    return Object.fromEntries(changed.map((c) => [c.idx, c.body]))
  }

  const all = await readJson(FILE(), {})
  all[key(uid, mod)] = Object.fromEntries(changed.map((c) => [c.idx, c.body]))
  await writeJson(FILE(), all)
  return { ...all[key(uid, mod)] }
}

/** Ответ Postgres «такой таблицы нет» — миграцию ещё не накатили. */
function isMissingTable(error) {
  const msg = String(error?.message || '')
  return error?.code === '42P01' || /not found in the schema cache|does not exist/i.test(msg)
}
