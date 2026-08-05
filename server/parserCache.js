/**
 * §6 (MR-38): КЭШ РЕЗУЛЬТАТОВ ПАРСИНГА в своей БД.
 *
 * При повторном совпадающем запросе (те же ключевые слова + окончания + фильтры + тип
 * модуля) сначала отдаём СОХРАНЁННОЕ, показывая дату последнего обновления, — чтобы не
 * гонять аккаунты и не платить за то же самое. Свежий проход всегда доступен рядом.
 *
 * Ключ — детерминированная сигнатура запроса (нормализованные ключи/окончания/фильтры):
 * одинаковый поиск, набранный в другом порядке или регистре, даёт тот же ключ. Результаты
 * храним JSON-блобом. SQLite через встроенный node:sqlite — как payments.js, без нативных
 * зависимостей. Данные каналов публичные (та же общая база каналов §3.8), поэтому кэш
 * общий, не пер-юзерный.
 */
import { DatabaseSync } from 'node:sqlite'
import { dataPath } from './lib/jsonStore.js'

const DB_FILE = () => process.env.PARSER_CACHE_DB || dataPath('parser-cache.db')

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

/** Нормализация списка (ключи/окончания): trim + lower + уникальные + сортировка. */
const norm = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))].sort()

/**
 * Детерминированная сигнатура запроса — одинаковый поиск даёт одинаковый ключ.
 * В неё входит только то, что влияет на СОСТАВ результата: тип модуля, ключи, окончания
 * и фильтры отбора. Аккаунты, задержки, лимит показа и т.п. на состав базы не влияют.
 */
export function parserSignature(kind, s = {}) {
  return JSON.stringify({
    kind: String(kind || ''),
    keywords: norm(s.keywords),
    endings: norm(s.endings),
    minMembers: Number(s.minMembers) || 0,
    maxMembers: Number(s.maxMembers) || 0,
    comments: Number(s.commentFilter) || 0,
    intersect: !!s.intersect,
  })
}

/**
 * Сохранить результат парсинга в кэш (перезаписывает прежний для той же сигнатуры —
 * свежий проход обновляет дату и состав). Без ключевых слов кэшировать нечего.
 * @returns {string|undefined} сигнатуру, под которой сохранили (или undefined)
 */
export function saveParserResults(kind, settings, results) {
  if (!norm(settings?.keywords).length) return
  const list = Array.isArray(results) ? results : []
  const sig = parserSignature(kind, settings)
  db().prepare('INSERT OR REPLACE INTO parser_cache(sig,kind,keywords,updated_at,count,results) VALUES(?,?,?,?,?,?)')
    .run(sig, String(kind || ''), norm(settings?.keywords).join(', '), Date.now(), list.length, JSON.stringify(list))
  return sig
}

/**
 * Найти сохранённый результат по совпадающему запросу.
 * @returns {{updatedAt:number,count:number,results:object[]}|null} null — совпадения не было
 */
export function lookupParserResults(kind, settings) {
  const row = db().prepare('SELECT updated_at, count, results FROM parser_cache WHERE sig = ?').get(parserSignature(kind, settings))
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
