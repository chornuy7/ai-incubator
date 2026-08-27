/**
 * SPEC §1.3 (C3): счётчик измеримого результата — переходов по ссылке.
 *
 * Без него цель «200 переходов» невозможно завершить: система не знает, сколько
 * человек реально кликнуло, и критерий завершения остаётся на честном слове оператора.
 *
 * Как работает: вместо прямой ссылки модуль отправляет короткую через наш сервер
 * (`/r/<code>`). Сервер считает переход и редиректит на настоящий адрес — для человека
 * это один лишний хоп, для цели это единственный способ измерить результат.
 *
 * С 27.08 (MR-186) хранение — в ОБЩЕЙ БАЗЕ (`tracked_links` + `link_hits`). До этого
 * ссылки лежали в data/links.json, а переходы дописывались строками в
 * data/link-hits.jsonl. При втором инстансе половина кликов уходила бы в файл одного
 * сервера, половина другого, и цель не набрала бы нужного числа никогда.
 *
 * Заодно ушла главная тормозная точка: «уникальность» проверялась чтением ВСЕГО журнала
 * переходов на каждый клик. Теперь это один запрос по индексу (code, fp).
 *
 * Файловый режим оставлен для локального запуска и тестов.
 */
import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { dataPath, readJson, mutateJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

const LINKS_FILE = () => process.env.LINKS_FILE || dataPath('links.json')
const HITS_FILE = () => process.env.LINK_HITS_FILE || dataPath('link-hits.jsonl')
function sb() { return supabaseEnabled() ? getSupabase() : null }

/** Таблиц ещё нет (миграция не накатана) — редирект должен работать, счётчик подождёт. */
const isMissingTable = (error) =>
  !!error && /tracked_links|link_hits|schema cache|does not exist|relation .* does not exist/i.test(String(error.message || ''))

/** Код короткой ссылки: короткий, но не угадываемый перебором. */
const newCode = () => crypto.randomBytes(5).toString('base64url')

const fromRow = (r) => ({
  id: r.id,
  code: r.code,
  userId: r.user_id ?? null,
  url: r.url,
  title: r.title || '',
  goalId: r.goal_id ?? null,
  campaignId: r.campaign_id ?? null,
  hits: Number(r.hits) || 0,
  uniqueHits: Number(r.unique_hits) || 0,
  createdAt: Number(r.created_at) || 0,
})

export async function listLinks() {
  const db = sb()
  if (db) {
    const { data, error } = await db.from('tracked_links').select('*').order('created_at', { ascending: false })
    if (error) {
      if (isMissingTable(error)) return []
      throw new Error(`Не удалось прочитать ссылки: ${error.message}`)
    }
    return (data || []).map(fromRow)
  }
  const all = await readJson(LINKS_FILE(), [])
  return Array.isArray(all) ? all : []
}

/**
 * Создать отслеживаемую ссылку.
 * @param {{url:string, goalId?:string|null, campaignId?:string|null, title?:string}} input
 */
export async function createLink(input = {}) {
  const url = String(input.url || '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('Нужна ссылка, начинающаяся с http:// или https://')
  const link = {
    id: `lnk_${crypto.randomUUID().slice(0, 8)}`,
    code: newCode(),
    // Чья ссылка. Аудит 21.08: владельца не было, и `GET /api/links` отдавал все
    // отслеживаемые ссылки платформы — то есть куда каждый клиент ведёт людей и
    // сколько переходов собрал. Это его воронка целиком, на виду у конкурента.
    userId: input.userId ? String(input.userId) : null,
    url,
    title: String(input.title || '').trim(),
    goalId: input.goalId ? String(input.goalId) : null,
    campaignId: input.campaignId ? String(input.campaignId) : null,
    hits: 0,
    uniqueHits: 0,
    createdAt: Date.now(),
  }
  const db = sb()
  if (db) {
    const { error } = await db.from('tracked_links').insert({
      id: link.id, code: link.code, user_id: link.userId, url: link.url, title: link.title,
      goal_id: link.goalId, campaign_id: link.campaignId, hits: 0, unique_hits: 0, created_at: link.createdAt,
    })
    if (error) {
      if (isMissingTable(error)) throw new Error('Счётчик переходов временно недоступен: не применена миграция базы')
      throw new Error(`Не удалось создать ссылку: ${error.message}`)
    }
    return link
  }
  await mutateJson(LINKS_FILE(), (all) => [link, ...(Array.isArray(all) ? all : [])])
  return link
}

export async function getLinkByCode(code) {
  const db = sb()
  if (db) {
    const { data, error } = await db.from('tracked_links').select('*').eq('code', String(code)).limit(1)
    if (error || !data?.length) return null
    return fromRow(data[0])
  }
  const all = await listLinks()
  return all.find((l) => l.code === code) || null
}

/**
 * Зафиксировать переход. Возвращает адрес для редиректа или null, если ссылки нет.
 *
 * «Уникальность» считаем по отпечатку (IP + user-agent): точнее без кук и трекинга
 * не сделать, а куки на редиректе — лишняя сущность и вопросы к приватности.
 * Отпечаток хешируем: хранить сырые IP посетителей ради счётчика незачем.
 */
export async function registerHit(code, meta = {}) {
  const link = await getLinkByCode(code)
  if (!link) return null

  const fp = crypto.createHash('sha256')
    .update(`${meta.ip || ''}|${meta.ua || ''}`)
    .digest('hex')
    .slice(0, 16)
  const now = Date.now()
  const ref = String(meta.ref || '')

  const db = sb()
  if (db) {
    // Ни одна ошибка учёта не должна помешать редиректу: человек кликнул по ссылке и
    // обязан попасть на сайт, даже если счётчик прямо сейчас не работает.
    try {
      // Уникальность — ОДИН запрос по индексу (code, fp). В файловом варианте на это
      // уходило чтение всего журнала переходов, и с ростом кликов оно только росло.
      const { data: seen } = await db.from('link_hits').select('id').eq('code', code).eq('fp', fp).limit(1)
      const isUnique = !seen?.length
      await db.from('link_hits').insert({ id: `hit_${crypto.randomUUID()}`, code, fp, ref, ts: now })
      await db.from('tracked_links').update({
        hits: (link.hits || 0) + 1,
        unique_hits: (link.uniqueHits || 0) + (isUnique ? 1 : 0),
      }).eq('code', code)
    } catch { /* счётчик не должен ломать редирект */ }
    return link.url
  }

  let isUnique = true
  try {
    const raw = await fs.readFile(HITS_FILE(), 'utf8').catch(() => '')
    isUnique = !raw.includes(`"${fp}"`) || !raw.split('\n').some((l) => {
      if (!l.trim()) return false
      try { const r = JSON.parse(l); return r.code === code && r.fp === fp } catch { return false }
    })
  } catch { /* нет файла — переход первый */ }

  try {
    const file = HITS_FILE()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, JSON.stringify({ ts: now, code, fp, ref }) + '\n', 'utf8')
  } catch { /* счётчик не должен ломать редирект — человек всё равно должен попасть на сайт */ }

  await mutateJson(LINKS_FILE(), (all) => (Array.isArray(all) ? all : []).map((l) => (
    l.code === code ? { ...l, hits: (l.hits || 0) + 1, uniqueHits: (l.uniqueHits || 0) + (isUnique ? 1 : 0) } : l
  ))).catch(() => {})

  return link.url
}

/**
 * Сколько переходов набрала цель — по всем её ссылкам. Это и есть измеримый
 * результат из §1.3, по которому цель можно закрыть.
 */
export async function goalHits(goalId) {
  const links = await listLinks()
  const mine = links.filter((l) => l.goalId === goalId)
  return {
    links: mine.length,
    hits: mine.reduce((n, l) => n + (l.hits || 0), 0),
    uniqueHits: mine.reduce((n, l) => n + (l.uniqueHits || 0), 0),
  }
}

export async function deleteLink(id) {
  const db = sb()
  if (db) {
    // Переходы уходят сами: внешний ключ на code объявлен с `on delete cascade`.
    const { data, error } = await db.from('tracked_links').delete().eq('id', String(id)).select('id')
    if (error) {
      if (isMissingTable(error)) return false
      throw new Error(`Не удалось удалить ссылку: ${error.message}`)
    }
    return (data || []).length > 0
  }
  let removed = false
  await mutateJson(LINKS_FILE(), (all) => {
    const list = Array.isArray(all) ? all : []
    const next = list.filter((l) => l.id !== id)
    removed = next.length !== list.length
    return next
  })
  return removed
}
