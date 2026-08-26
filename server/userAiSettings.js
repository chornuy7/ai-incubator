/**
 * MR-185: глобальный системный промпт — свой у каждого человека.
 *
 * Было: один текст на всю платформу (`aiSettings.js`, ключ `ai-settings` в общем kv).
 * Админ дописал себе строку — она уехала ВСЕМ: субам, другим владельцам, во все запуски.
 * Тот же корень, что и у карточек промптов: текст не принадлежал никому.
 *
 * Владелец 27.08: правка под администратором остаётся у администратора, под тестовым
 * модератором — у тестового модератора; на чужие аккаунты не переходит.
 *
 * ПРО СТАНДАРТНЫЙ ТЕКСТ. Тот, кто своего промпта не задавал, не должен работать «без
 * правил»: ему подставляется стандартный (`DEFAULT_SYSTEM_PROMPT` из aiSettings.js).
 * Порядок такой: свой → переопределение из хранилища, если оно заведено → стандартный
 * из кода. Первое сохранение заводит личную строку, и дальше общий текст этого человека
 * уже не касается; очистил свой — снова стандартный.
 */
import { getSupabase, supabaseEnabled } from './lib/supabase.js'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'
import { getGlobalSystemPromptSync, getAiSettings, DEFAULT_SYSTEM_PROMPT } from './aiSettings.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }
/** Путь вычисляем лениво: тесты подменяют его через env уже после импорта модуля. */
const FILE = () => process.env.USER_AI_SETTINGS_FILE || dataPath('user-ai-settings.json')

/** Таблицы ещё нет (миграция не накатана) — ведём себя как «своего промпта нет». */
const isMissingTable = (error) =>
  !!error && /user_ai_settings|schema cache|does not exist|relation .* does not exist/i.test(String(error.message || ''))

const clean = (v) => String(v ?? '')

/**
 * ЛИЧНЫЙ промпт человека — без запасного текста.
 * @returns {Promise<string>} пустая строка = своего нет
 */
export async function getOwnGlobalPrompt(userId) {
  const uid = clean(userId).trim()
  if (!uid) return ''
  const db = sb()
  if (db) {
    const { data, error } = await db.from('user_ai_settings').select('global_prompt').eq('user_id', uid).maybeSingle()
    if (error) {
      if (isMissingTable(error)) return ''
      throw new Error(`Не удалось прочитать ИИ-настройки: ${error.message}`)
    }
    return clean(data?.global_prompt)
  }
  const all = await readJson(FILE(), {})
  return clean(all[uid])
}

/**
 * Промпт, с которым реально пойдёт генерация: свой, а если своего нет — прежний общий.
 * @returns {Promise<string>}
 */
export async function getUserGlobalPrompt(userId) {
  const own = await getOwnGlobalPrompt(userId).catch(() => '')
  if (own.trim()) return own
  // Переопределение из хранилища (если заведено), иначе — стандартный текст из кода.
  // Кэш может быть ещё не прогрет — тогда подтягиваем настройки с диска/базы.
  const override = getGlobalSystemPromptSync() || clean((await getAiSettings().catch(() => null))?.globalSystemPrompt)
  return override.trim() || DEFAULT_SYSTEM_PROMPT
}

/**
 * Сохранить личный промпт. Пустая строка = «вернуть как было», строка удаляется, и снова
 * подставится общий текст — копию общего в базе не держим.
 * @returns {Promise<string>} что теперь у человека (с учётом запасного текста)
 */
export async function setUserGlobalPrompt(userId, prompt) {
  const uid = clean(userId).trim()
  if (!uid) throw new Error('Нет владельца настроек')
  const value = clean(prompt)
  const db = sb()

  if (db) {
    if (!value.trim()) {
      const { error } = await db.from('user_ai_settings').delete().eq('user_id', uid)
      if (error && !isMissingTable(error)) throw new Error(`Не удалось очистить ИИ-настройки: ${error.message}`)
    } else {
      const { error } = await db
        .from('user_ai_settings')
        .upsert({ user_id: uid, global_prompt: value, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      if (error && !isMissingTable(error)) throw new Error(`Не удалось сохранить ИИ-настройки: ${error.message}`)
    }
    return getUserGlobalPrompt(uid)
  }

  const all = await readJson(FILE(), {})
  if (!value.trim()) delete all[uid]
  else all[uid] = value
  await writeJson(FILE(), all)
  return getUserGlobalPrompt(uid)
}
