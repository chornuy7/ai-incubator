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
