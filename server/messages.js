/**
 * §11.1: хранение переписки аккаунтов.
 *
 * Решение владельца (30.07): храним ЦЕЛИКОМ — «нам нужно всё, чтобы был доступ ко
 * всему». Мотив со звонка 29.07: чужие люди работают нашими Telegram-аккаунтами, и за
 * то, что они пишут, отвечаем мы, а значит должны это видеть.
 *
 * Запись — всегда best-effort: переписка нужна для контроля, но упавшее логирование не
 * должно ронять сам диалог. Поэтому все ошибки глотаются, а вызывающий код не ждёт
 * результата как условия продолжения.
 *
 * Таблица растёт быстрее остальных, поэтому:
 *   • текст режем по MAX_TEXT — гигантские пересланные простыни не нужны для контроля,
 *     а строку раздувают; факт обрезки помечаем в самом тексте, чтобы не выглядело
 *     как будто человек так и написал;
 *   • читаем только с лимитом, «выбрать всё» наружу не даём.
 */
import { getSupabase, supabaseEnabled } from './lib/supabase.js'
import { dataPath, readJson, mutateJson } from './lib/jsonStore.js'

const MESSAGES_FILE = () => process.env.MESSAGES_FILE || dataPath('messages.json')
/** Больше 4000 символов для контроля переписки не нужно — это уже документ, а не реплика. */
const MAX_TEXT = 4000
const TRIM_MARK = '… [обрезано при сохранении]'

function sb() { return supabaseEnabled() ? getSupabase() : null }

const rowToMsg = (r) => ({
  id: String(r.id),
  accountId: r.account_id || '',
  userId: r.user_id || '',
  peer: r.peer || '',
  direction: r.direction === 'in' ? 'in' : 'out',
  text: r.text || '',
  moduleKey: r.module_key || '',
  taskId: r.task_id || '',
  campaignId: r.campaign_id || '',
  at: r.created_at ? new Date(r.created_at).getTime() : 0,
})

function clip(text) {
  const t = String(text ?? '')
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + TRIM_MARK : t
}

/**
 * Записать реплику. Ничего не бросает.
 * @param {{accountId:string, peer?:string, direction:'in'|'out', text?:string,
 *          userId?:string, moduleKey?:string, taskId?:string, campaignId?:string}} m
 */
export async function recordMessage(m = {}) {
  try {
    const accountId = String(m.accountId || '')
    const direction = m.direction === 'in' ? 'in' : 'out'
    // Без аккаунта запись бессмысленна: не к кому привязать и не по чему искать.
    if (!accountId) return
    const text = clip(m.text)
    // Пустые реплики (сервисные события без текста) не храним — только шум в таблице.
    if (!text) return

    const db = sb()
    if (db) {
      await db.from('messages').insert({
        account_id: accountId,
        user_id: m.userId || null,
        peer: String(m.peer || ''),
        direction,
        text,
        module_key: String(m.moduleKey || ''),
        task_id: String(m.taskId || ''),
        campaign_id: String(m.campaignId || ''),
      })
      return
    }
    await mutateJson(MESSAGES_FILE(), (all) => {
      const list = Array.isArray(all) ? all : []
      list.push({
        id: `msg_${Date.now()}_${list.length}`,
        accountId, userId: m.userId || '', peer: String(m.peer || ''), direction, text,
        moduleKey: String(m.moduleKey || ''), taskId: String(m.taskId || ''),
        campaignId: String(m.campaignId || ''), at: Date.now(),
      })
      return list
    }, [])
  } catch { /* контроль переписки не должен ронять сам диалог */ }
}

/**
 * Переписка с фильтрами. Свежие сверху.
 * @param {{accountId?:string, peer?:string, userId?:string, accountIds?:string[], limit?:number}} f
 */
export async function listMessages(f = {}) {
  const limit = Math.min(Number(f.limit) || 200, 1000)
  const db = sb()
  if (db) {
    let q = db.from('messages').select('*').order('created_at', { ascending: false }).limit(limit)
    if (f.accountId) q = q.eq('account_id', f.accountId)
    if (f.peer) q = q.eq('peer', f.peer)
    if (f.userId) q = q.eq('user_id', f.userId)
    if (f.accountIds?.length) q = q.in('account_id', f.accountIds)
    const { data, error } = await q
    if (error) return []
    return (data || []).map(rowToMsg)
  }
  const all = await readJson(MESSAGES_FILE(), [])
  if (!Array.isArray(all)) return []
  return all
    .filter((m) => (!f.accountId || m.accountId === f.accountId)
      && (!f.peer || m.peer === f.peer)
      && (!f.userId || m.userId === f.userId)
      && (!f.accountIds?.length || f.accountIds.includes(m.accountId)))
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, limit)
}
