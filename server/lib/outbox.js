/**
 * Что МЫ отправляли конкретному человеку — по историям задач всех модулей.
 *
 * Нужно для честного ответа в окне переписки. Telegram принимает отправку, а потом
 * молча стирает её антиспамом: сообщение исчезает и у нас, и у получателя, диалога
 * в списке нет вовсе. Живой пример 22.07 — `@qqqqq09890`: в логе «ЛС → …»,
 * `getMessages` возвращает 0, диалога в `getDialogs` нет.
 *
 * Без этого экран говорит «с этим контактом ещё не переписывались», и оператор
 * думает, что баг у нас. На самом деле это главный симптом того, что аккаунт
 * помечен спамом, — и знать об этом важнее, чем видеть пустой чат.
 */
import fs from 'fs/promises'
import path from 'path'
import { dataPath } from './jsonStore.js'
import { getSupabase, supabaseEnabled } from './supabase.js'

/** Модули, которые пишут людям в ЛС. */
const DM_MODULES = ['mailing', 'neuro-dialogs', 'neuro-chatting']

/** Ключ сравнения контакта: «@User1», «user1» и «t.me/user1» — один человек. */
export function peerKey(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?t\.me\//i, '')
    .replace(/^[@+]/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * @param {string} peer контакт (@username, +телефон или id:123)
 * @param {{ accountId?: string }} [opts] сузить до конкретного аккаунта
 * @returns {Promise<{ text:string, ts:string, taskId:string, moduleKey:string, accountId?:string }[]>}
 *   отправленные нами сообщения, от старых к новым
 */
export async function outgoingToPeer(peer, opts = {}) {
  const key = peerKey(peer)
  if (!key) return []
  const fromDb = await outgoingFromDb(key, opts)
  if (fromDb) return fromDb
  return outgoingFromFiles(key, opts)
}

/**
 * MR-290: история задач переехала в базу (`task_events`), и читать файлы стало нельзя.
 *
 * Это не косметика. Файлы после переезда перестают пополняться, а функция продолжила бы
 * работать — молча возвращая пусто. Окно переписки сказало бы «с этим контактом ещё не
 * переписывались» ровно там, где оно должно кричать обратное: пустой диалог при живой
 * отправке — главный симптом того, что аккаунт помечен спамом. Худший вид поломки:
 * экран не сломан, он уверенно врёт.
 *
 * @returns {Promise<object[]|null>} null — базы нет или прочитать не удалось; читайте файлы.
 */
async function outgoingFromDb(key, opts = {}) {
  const db = supabaseEnabled() ? getSupabase() : null
  if (!db) return null
  // Отбираем сразу по модулю: писать в ЛС умеют три модуля из пятнадцати, и тянуть
  // историю остальных ради поиска одного контакта незачем.
  const { data, error } = await db.from('task_events')
    .select('payload, position, task_id, tasks!inner(module_key)')
    .eq('field', 'history')
    .in('tasks.module_key', DM_MODULES)
    .limit(20000)
  if (error) return null
  const out = []
  for (const row of data || []) {
    const h = row.payload
    if (h?.status !== 'sent' || !h?.text) continue
    if (peerKey(h.peer || h.target) !== key) continue
    if (opts.accountId && h.accountId && h.accountId !== opts.accountId) continue
    out.push({
      text: h.text,
      ts: h.ts,
      taskId: row.task_id,
      moduleKey: row.tasks?.module_key,
      accountId: h.accountId,
      accountName: h.accountName,
    })
  }
  return out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
}

/** Запасной путь: файлы задач. Остаётся для файлового бэкенда и для задач, ещё не перенесённых. */
async function outgoingFromFiles(key, opts = {}) {
  const out = []
  for (const moduleKey of DM_MODULES) {
    const dir = dataPath(path.join('modules', moduleKey, 'tasks'))
    let files = []
    try { files = await fs.readdir(dir) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      let task
      try { task = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) } catch { continue }
      for (const h of task.history || []) {
        if (h?.status !== 'sent' || !h?.text) continue
        if (peerKey(h.peer || h.target) !== key) continue
        if (opts.accountId && h.accountId && h.accountId !== opts.accountId) continue
        out.push({
          text: h.text,
          ts: h.ts,
          taskId: task.id,
          moduleKey,
          accountId: h.accountId,
          accountName: h.accountName,
        })
      }
    }
  }
  return out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
}
