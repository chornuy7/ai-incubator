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
 * Хранение: `data/links.json` — сами ссылки, `data/link-hits.jsonl` — переходы.
 * Переходы дописываются строкой, а не переписывают файл: кликов может быть много,
 * и read-modify-write на каждый клик дал бы гонку и тормоза (та же болезнь, что
 * была у accounts-meta).
 */
import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { dataPath, readJson, mutateJson } from './lib/jsonStore.js'

const LINKS_FILE = () => process.env.LINKS_FILE || dataPath('links.json')
const HITS_FILE = () => process.env.LINK_HITS_FILE || dataPath('link-hits.jsonl')

/** Код короткой ссылки: короткий, но не угадываемый перебором. */
const newCode = () => crypto.randomBytes(5).toString('base64url')

export async function listLinks() {
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
  await mutateJson(LINKS_FILE(), (all) => [link, ...(Array.isArray(all) ? all : [])])
  return link
}

export async function getLinkByCode(code) {
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
    await fs.appendFile(file, JSON.stringify({ ts: Date.now(), code, fp, ref: String(meta.ref || '') }) + '\n', 'utf8')
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
  let removed = false
  await mutateJson(LINKS_FILE(), (all) => {
    const list = Array.isArray(all) ? all : []
    const next = list.filter((l) => l.id !== id)
    removed = next.length !== list.length
    return next
  })
  return removed
}
