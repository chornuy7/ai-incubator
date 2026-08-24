/**
 * §6 (MR-38): КЭШ РЕЗУЛЬТАТОВ ПАРСИНГА.
 *
 * При повторном совпадающем запросе (тот же модуль + те же ключевые слова / источники +
 * те же фильтры) сначала отдаём СОХРАНЁННОЕ, показывая дату последнего обновления, —
 * чтобы не гонять аккаунты и не платить за то же самое. Свежий проход всегда рядом.
 *
 * ГДЕ ЛЕЖИТ (правка 24.08). Раньше — всегда локальный SQLite `data/parser-cache.db`.
 * Вопрос владельца «зачем нам две базы» справедлив: кэш жил файлом на диске ОДНОЙ
 * машины, то есть при втором инстансе у каждого сервера был бы свой; и это был третий
 * шаблон хранения — у всех прочих сторов есть переключатель «есть Supabase → туда,
 * нет → в файлы», а здесь его не было. Теперь как у всех: включён Supabase — пишем в
 * общую БД, иначе остаётся SQLite (он же нужен для локальной разработки и тестов).
 *
 * КЛЮЧ — sha256 от сигнатуры запроса, а не сама сигнатура: у парсера бывает полсотни
 * ключевых слов, и сырой JSON не влезает в btree-индекс Postgres (лимит ~2.7 КБ).
 * Сигнатура детерминированная: одинаковый поиск, набранный в другом порядке или
 * регистре, даёт тот же ключ.
 *
 * Данные каналов публичные (та же общая база каналов §3.8), поэтому кэш общий на
 * платформу, а не пер-юзерный.
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { dataPath } from './lib/jsonStore.js'
import { supabaseEnabled, getSupabase, isMissingTable } from './lib/supabase.js'

const DB_FILE = () => process.env.PARSER_CACHE_DB || dataPath('parser-cache.db')

/** Общая БД, если она включена; иначе null — работаем на SQLite. */
function sb() { return supabaseEnabled() ? getSupabase() : null }

let _db = null
function db() {
  if (_db) return _db
  const d = new DatabaseSync(DB_FILE())
  d.exec(`CREATE TABLE IF NOT EXISTS parser_cache(
    sig        TEXT PRIMARY KEY,
    kind       TEXT,
    keywords   TEXT,
    updated_at INTEGER NOT NULL,
    count      INTEGER NOT NULL,
    results    TEXT NOT NULL
  )`)
  d.exec('CREATE INDEX IF NOT EXISTS idx_parser_cache_updated ON parser_cache(updated_at)')
  _db = d
  return _db
}

/** Нормализация списка (ключи/окончания/источники): trim + lower + уникальные + сортировка. */
const norm = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((x) => String(x).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))].sort()

/** Объект с ОТСОРТИРОВАННЫМИ ключами: иначе один и тот же набор фильтров даёт разный JSON. */
function stable(obj) {
  const o = obj && typeof obj === 'object' ? obj : {}
  const out = {}
  for (const k of Object.keys(o).sort()) {
    const v = o[k]
    if (v === undefined || v === null || v === '' || v === false || v === 0) continue // умолчания в ключ не тащим
    out[k] = v
  }
  return out
}

/**
 * Детерминированная сигнатура запроса — одинаковый поиск даёт одинаковый ключ.
 * В неё входит только то, что влияет на СОСТАВ результата: тип модуля, ключи, окончания
 * и фильтры отбора. Аккаунты, задержки, лимит показа и т.п. на состав базы не влияют.
 *
 * Парсеры АУДИТОРИИ (участники/сообщения/комментарии) описываются не словами, а списком
 * источников — плюс своими фильтрами и лимитами сбора: с `limit 20` и `limit 1000`
 * состав разный, отдавать одно за другое нельзя. Эти поля добавляются В КОНЕЦ и только
 * когда источники заданы — чтобы у парсера каналов сигнатура осталась прежней и старый
 * кэш не обнулился на ровном месте.
 */
export function parserSignature(kind, s = {}) {
  const sig = {
    kind: String(kind || ''),
    keywords: norm(s.keywords),
    endings: norm(s.endings),
    minMembers: Number(s.minMembers) || 0,
    maxMembers: Number(s.maxMembers) || 0,
    comments: Number(s.commentFilter) || 0,
    intersect: !!s.intersect,
  }
  const sources = norm(s.targets)
  if (sources.length) {
    sig.targets = sources
    sig.filters = stable(s.filters)
    sig.limits = stable(s.limits)
    if (s.intersectionMode) sig.intersectionMin = Number(s.intersectionMin) || sources.length
  }
  return JSON.stringify(sig)
}

/** Ключ строки: sha256 сигнатуры (сырой JSON слишком длинный для индекса Postgres). */
const sigKey = (sig) => createHash('sha256').update(sig).digest('hex')

/** Что показать человеку в колонке `keywords`: слова, а если их нет — источники. */
function label(settings) {
  const kw = norm(settings?.keywords)
  return (kw.length ? kw : norm(settings?.targets)).join(', ').slice(0, 500)
}

/** Есть ли вообще чем описать запрос: без слов и без источников кэшировать нечего. */
const describable = (s) => norm(s?.keywords).length > 0 || norm(s?.targets).length > 0

/**
 * Сохранить результат парсинга в кэш (перезаписывает прежний для той же сигнатуры —
 * свежий проход обновляет дату и состав).
 * @returns {Promise<string|undefined>} сигнатуру, под которой сохранили (или undefined)
 */
export async function saveParserResults(kind, settings, results) {
  if (!describable(settings)) return
  const list = Array.isArray(results) ? results : []
  const sig = parserSignature(kind, settings)
  const row = {
    sig: sigKey(sig),
    kind: String(kind || ''),
    keywords: label(settings),
    updated_at: Date.now(),
    count: list.length,
  }
  const base = sb()
  if (base) {
    const { error } = await base.from('parser_cache').upsert({ ...row, results: list }, { onConflict: 'sig' })
    if (!error) return sig
    if (!isMissingTable(error)) throw new Error(error.message)
    console.warn('[parserCache] таблица parser_cache не найдена — миграция 2026-08-24 не накатана, пишу в локальный SQLite')
  }
  db().prepare('INSERT OR REPLACE INTO parser_cache(sig,kind,keywords,updated_at,count,results) VALUES(?,?,?,?,?,?)')
    .run(row.sig, row.kind, row.keywords, row.updated_at, row.count, JSON.stringify(list))
  return sig
}

/**
 * Найти сохранённый результат по совпадающему запросу.
 * @returns {Promise<{updatedAt:number,count:number,results:object[]}|null>} null — совпадения не было
 */
export async function lookupParserResults(kind, settings) {
  if (!describable(settings)) return null
  const key = sigKey(parserSignature(kind, settings))
  const base = sb()
  if (base) {
    const { data, error } = await base.from('parser_cache').select('updated_at, count, results').eq('sig', key).maybeSingle()
    // Таблицы нет — миграция не накатана: смотрим в локальный SQLite, а не отвечаем «кэша нет».
    if (!error || !isMissingTable(error)) {
      if (error || !data) return null
      return {
        updatedAt: Number(data.updated_at),
        count: Number(data.count),
        results: Array.isArray(data.results) ? data.results : [],
      }
    }
  }
  const row = db().prepare('SELECT updated_at, count, results FROM parser_cache WHERE sig = ?').get(key)
  if (!row) return null
  let results = []
  try { results = JSON.parse(row.results) } catch { results = [] }
  return { updatedAt: Number(row.updated_at), count: Number(row.count), results }
}

/** Для тестов/обслуживания: закрыть и сбросить соединение (следующий вызов пересоздаст). */
export function _resetParserCacheDb() {
  try { _db?.close() } catch { /* already closed */ }
  _db = null
}
