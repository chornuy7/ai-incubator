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
import { supabaseEnabled, getSupabase, isMissingTable, isMissingColumn } from './lib/supabase.js'

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
  // Колонки слежения добавляем по одной и молча: файл мог быть создан прошлой версией,
  // а `CREATE TABLE IF NOT EXISTS` его не тронет. SQLite не умеет `ADD COLUMN IF NOT
  // EXISTS`, поэтому ловим ошибку «duplicate column» и идём дальше.
  for (const col of [
    'owner_id TEXT', 'settings TEXT', 'watch INTEGER NOT NULL DEFAULT 0',
    'period_h INTEGER NOT NULL DEFAULT 24', 'next_run_at INTEGER', 'last_run_at INTEGER',
    'last_new INTEGER NOT NULL DEFAULT 0', 'last_gone INTEGER NOT NULL DEFAULT 0',
    'last_error TEXT', 'fail_count INTEGER NOT NULL DEFAULT 0', 'title TEXT',
  ]) {
    try { d.exec(`ALTER TABLE parser_cache ADD COLUMN ${col}`) } catch { /* колонка уже есть */ }
  }
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
  /*
   * TGStat — отдельный вид запроса: он ходит не аккаунтами, а куками каталога, и
   * описывается ФИЛЬТРАМИ (категория, регион, порог подписчиков), а не словами и не
   * источниками. Поля добавляются в конец и только для него — сигнатуры остальных
   * парсеров от этого не меняются.
   */
  if (String(kind || '') === 'tgstat') {
    sig.tgstat = stable(s.filters)
    sig.pages = Number(s.maxPages) || 0
    return JSON.stringify(sig)
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

/**
 * Что из настроек стоит запомнить, чтобы через сутки перезапустить ТОТ ЖЕ запрос.
 *
 * Только описание отбора. Аккаунты, задержки, защита и прочая обвязка запуска к составу
 * результата отношения не имеют: при перепроверке их подставит сам планировщик по
 * текущему состоянию парка, а не по слепку месячной давности.
 */
function watchableSettings(s = {}) {
  const out = {}
  for (const k of ['keywords', 'endings', 'targets', 'filters', 'maxPages', 'searchMode', 'minMembers', 'maxMembers', 'commentFilter', 'intersect', 'intersectionMode', 'intersectionMin', 'filters', 'limits', 'limit', 'maxActions']) {
    if (s[k] !== undefined && s[k] !== null && s[k] !== '') out[k] = s[k]
  }
  return out
}

/** Ключ строки: sha256 сигнатуры (сырой JSON слишком длинный для индекса Postgres). */
const sigKey = (sig) => createHash('sha256').update(sig).digest('hex')

/** Что показать человеку в колонке `keywords`: слова, а если их нет — источники. */
function label(kind, settings) {
  if (String(kind || '') === 'tgstat') {
    const f = stable(settings?.filters)
    return Object.entries(f).map(([k, v]) => `${k}: ${v}`).join(', ').slice(0, 500) || 'каталог TGStat'
  }
  const kw = norm(settings?.keywords)
  return (kw.length ? kw : norm(settings?.targets)).join(', ').slice(0, 500)
}

/** Есть ли вообще чем описать запрос: без слов, источников и фильтров кэшировать нечего. */
const describable = (kind, s) => String(kind || '') === 'tgstat'
  ? Object.keys(stable(s?.filters)).length > 0
  : norm(s?.keywords).length > 0 || norm(s?.targets).length > 0

/**
 * Сохранить результат парсинга в кэш (перезаписывает прежний для той же сигнатуры —
 * свежий проход обновляет дату и состав).
 * @returns {Promise<string|undefined>} сигнатуру, под которой сохранили (или undefined)
 */
export async function saveParserResults(kind, settings, results, ownerId = null) {
  if (!describable(kind, settings)) return
  const list = Array.isArray(results) ? results : []
  const sig = parserSignature(kind, settings)
  const row = {
    sig: sigKey(sig),
    kind: String(kind || ''),
    keywords: label(kind, settings),
    updated_at: Date.now(),
    count: list.length,
    // Сам запрос — чтобы перепроверка могла его перезапустить: от sha256 обратной
    // дороги нет. Храним ТОЛЬКО то, что описывает отбор: аккаунты, задержки и прочая
    // обвязка запуска к составу результата отношения не имеют и в ключ не входят.
    settings: watchableSettings(settings),
    owner_id: ownerId ? String(ownerId) : null,
  }
  /*
   * Каждый сохранённый запрос сразу встаёт в очередь на ревизию (решение владельца
   * 26.08: «обновлять все запросы раз в 12 часов»). Раньше слежение включали вручную —
   * от этого база старела: обновлялось только то, о чём вспомнили.
   *
   * Срок ставим ТОЛЬКО при первой записи (в БД — через `onConflict`-поля ниже, в SQLite —
   * веткой INSERT): свежий проход не должен отодвигать назначенную ревизию, иначе часто
   * запрашиваемый поиск не обновится никогда.
   */
  const firstPlan = { watch: true, period_h: DEFAULT_PERIOD_H, next_run_at: Date.now() + DEFAULT_PERIOD_H * 3600_000 }
  const base = sb()
  if (base) {
    // upsert перечисляет ТОЛЬКО свои поля: не указанные колонки (watch, period_h,
    // next_run_at и прочее слежение) при конфликте остаются как были.
    // Есть строка — обновляем только состав и дату; нет — заводим вместе с планом ревизии.
    const { data: exists } = await base.from('parser_cache').select('sig').eq('sig', row.sig).maybeSingle()
    const payload = exists ? { ...row, results: list } : { ...row, results: list, ...firstPlan }
    const { error } = await base.from('parser_cache').upsert(payload, { onConflict: 'sig' })
    if (!error) return sig
    if (!isMissingTable(error)) throw new Error(error.message)
    console.warn('[parserCache] таблица parser_cache не найдена — миграция 2026-08-24 не накатана, пишу в локальный SQLite')
  }
  // INSERT OR REPLACE затёр бы настройки слежения (watch/period_h/next_run_at), поэтому
  // сначала пробуем обновить существующую строку, и только если её нет — вставляем.
  const d = db()
  const upd = d.prepare('UPDATE parser_cache SET kind=?,keywords=?,updated_at=?,count=?,results=?,settings=?,owner_id=COALESCE(?,owner_id) WHERE sig=?')
    .run(row.kind, row.keywords, row.updated_at, row.count, JSON.stringify(list), JSON.stringify(row.settings), row.owner_id, row.sig)
  if (!upd.changes) {
    d.prepare('INSERT INTO parser_cache(sig,kind,keywords,updated_at,count,results,settings,owner_id,watch,period_h,next_run_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)')
      .run(row.sig, row.kind, row.keywords, row.updated_at, row.count, JSON.stringify(list), JSON.stringify(row.settings), row.owner_id, firstPlan.period_h, firstPlan.next_run_at)
  }
  return sig
}

/**
 * Найти сохранённый результат по совпадающему запросу.
 * @returns {Promise<{updatedAt:number,count:number,results:object[]}|null>} null — совпадения не было
 */
export async function lookupParserResults(kind, settings) {
  if (!describable(kind, settings)) return null
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

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * СЛЕЖЕНИЕ ЗА ЗАПРОСОМ (просьба владельца 24.08).
 *
 * «Перепроверять актуальность и искать новые каналы по тем же ключевым словам, раз в
 * сутки; ошибки видно в админке». Механика: у сохранённого запроса поднимается флаг
 * `watch`, планировщик раз в N часов перезапускает ТОТ ЖЕ парс обычной задачей модуля
 * (значит работают лимиты, списание, логи и блокировки аккаунтов), а результат
 * сравнивается с прошлым — сколько появилось нового и сколько пропало.
 *
 * Слежение ВЫКЛЮЧЕНО по умолчанию: перепроверка тратит аккаунты и монеты владельца,
 * включать её за человека молча нельзя.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Сколько неудач подряд терпим, прежде чем снять слежение и оставить ошибку в админке. */
export const WATCH_MAX_FAILS = 3

/** Как часто обновляем базу. Решение владельца 26.08: раз в 12 часов. */
export const DEFAULT_PERIOD_H = 12

/** Устойчивая личность записи: по ней считаем «новое» и «пропало». */
function identityOf(row) {
  const r = row || {}
  return String(r.username || r.link || r.id || r.title || '').toLowerCase().replace(/^@/, '')
}

/**
 * Что изменилось между прошлым и новым проходом.
 * @returns {{added:string[], gone:string[]}}
 */
export function diffResults(prev = [], next = []) {
  const a = new Set((prev || []).map(identityOf).filter(Boolean))
  const b = new Set((next || []).map(identityOf).filter(Boolean))
  return {
    added: [...b].filter((x) => !a.has(x)),
    gone: [...a].filter((x) => !b.has(x)),
  }
}

/** Включить/выключить слежение за уже сохранённым запросом. */
export async function setWatch(kind, settings, { watch = true, periodH = DEFAULT_PERIOD_H, ownerId = null } = {}) {
  const key = sigKey(parserSignature(kind, settings))
  const period = Math.min(24 * 30, Math.max(1, Number(periodH) || DEFAULT_PERIOD_H))
  const patch = {
    watch: !!watch,
    period_h: period,
    // Включили — первый заход через период, а не сию секунду: результат только что собран.
    next_run_at: watch ? Date.now() + period * 3600_000 : null,
    last_error: null,
    fail_count: 0,
  }
  if (ownerId) patch.owner_id = String(ownerId)
  const base = sb()
  if (base) {
    const { error } = await base.from('parser_cache').update(patch).eq('sig', key)
    if (!error) return true
    if (!isMissingTable(error)) throw new Error(error.message)
  }
  const d = db()
  const r = d.prepare('UPDATE parser_cache SET watch=?,period_h=?,next_run_at=?,last_error=NULL,fail_count=0,owner_id=COALESCE(?,owner_id) WHERE sig=?')
    .run(patch.watch ? 1 : 0, period, patch.next_run_at, ownerId ? String(ownerId) : null, key)
  return r.changes > 0
}

/** Строки, которым пора на перепроверку. */
export async function dueWatches(now = Date.now(), limit = 20) {
  const base = sb()
  if (base) {
    const { data, error } = await base.from('parser_cache')
      .select('sig, kind, keywords, settings, owner_id, results, period_h, next_run_at, fail_count')
      .eq('watch', true).lte('next_run_at', now).order('next_run_at', { ascending: true }).limit(limit)
    if (!error) return (data || []).map(fromRow)
    if (!isMissingTable(error)) throw new Error(error.message)
  }
  const rows = db().prepare('SELECT sig,kind,keywords,settings,owner_id,results,period_h,next_run_at,fail_count FROM parser_cache WHERE watch=1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT ?').all(now, limit)
  return rows.map(fromRow)
}

/** Строка БД → удобный объект (JSON-поля в файловой ветке лежат текстом). */
function fromRow(r) {
  const parse = (v, def) => {
    if (v === null || v === undefined) return def
    if (typeof v !== 'string') return v
    try { return JSON.parse(v) } catch { return def }
  }
  return {
    sig: r.sig,
    kind: r.kind,
    label: r.keywords,
    settings: parse(r.settings, {}),
    ownerId: r.owner_id || null,
    results: parse(r.results, []),
    periodH: Number(r.period_h) || DEFAULT_PERIOD_H,
    nextRunAt: Number(r.next_run_at) || 0,
    lastRunAt: Number(r.last_run_at) || 0,
    lastNew: Number(r.last_new) || 0,
    lastGone: Number(r.last_gone) || 0,
    lastError: r.last_error || null,
    failCount: Number(r.fail_count) || 0,
    watch: !!r.watch,
    count: Number(r.count) || 0,
    updatedAt: Number(r.updated_at) || 0,
  }
}

/**
 * Записать итог перепроверки.
 *
 * При ошибке слежение НЕ снимаем сразу: сеть моргнула, аккаунт словил FloodWait — это
 * не повод бросать запрос. Но и бесконечно долбиться в сломанное нельзя: после
 * WATCH_MAX_FAILS неудач подряд слежение выключается, а причина остаётся в `last_error` —
 * её и показывает админка.
 */
export async function markWatchRun(sig, { added = 0, gone = 0, error = null, failCount = 0, periodH = DEFAULT_PERIOD_H } = {}) {
  const now = Date.now()
  const fails = error ? Number(failCount) + 1 : 0
  const stop = fails >= WATCH_MAX_FAILS
  const patch = {
    last_run_at: now,
    last_new: Number(added) || 0,
    last_gone: Number(gone) || 0,
    last_error: error ? String(error).slice(0, 500) : null,
    fail_count: fails,
    watch: !stop,
    next_run_at: stop ? null : now + (Math.max(1, Number(periodH) || DEFAULT_PERIOD_H)) * 3600_000,
  }
  const base = sb()
  if (base) {
    const { error: e } = await base.from('parser_cache').update(patch).eq('sig', sig)
    if (!e) return stop
    if (!isMissingTable(e)) throw new Error(e.message)
  }
  db().prepare('UPDATE parser_cache SET last_run_at=?,last_new=?,last_gone=?,last_error=?,fail_count=?,watch=?,next_run_at=? WHERE sig=?')
    .run(patch.last_run_at, patch.last_new, patch.last_gone, patch.last_error, patch.fail_count, patch.watch ? 1 : 0, patch.next_run_at, sig)
  return stop
}

/**
 * Список отслеживаемых запросов — для витрины и для админки.
 * @param {{ownerId?:string, onlyErrors?:boolean, limit?:number}} opts
 */
export async function listWatches(opts = {}) {
  const { ownerId = '', onlyErrors = false, limit = 200 } = opts
  const base = sb()
  if (base) {
    let sel = base.from('parser_cache').select('sig,kind,keywords,settings,owner_id,period_h,next_run_at,last_run_at,last_new,last_gone,last_error,fail_count,watch,count,updated_at')
    if (ownerId) sel = sel.eq('owner_id', String(ownerId))
    sel = onlyErrors ? sel.not('last_error', 'is', null) : sel.eq('watch', true)
    const { data, error } = await sel.order('updated_at', { ascending: false }).limit(limit)
    if (!error) return (data || []).map(fromRow)
    if (!isMissingTable(error)) throw new Error(error.message)
  }
  const cond = []
  const args = []
  if (ownerId) { cond.push('owner_id = ?'); args.push(String(ownerId)) }
  cond.push(onlyErrors ? 'last_error IS NOT NULL' : 'watch = 1')
  const rows = db().prepare(`SELECT sig,kind,keywords,settings,owner_id,period_h,next_run_at,last_run_at,last_new,last_gone,last_error,fail_count,watch,count,updated_at FROM parser_cache WHERE ${cond.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...args, limit)
  return rows.map(fromRow)
}

/**
 * Последние запросы парсинга — то, что человек уже искал (просьба владельца 26.08:
 * «везде в парсинге нужно сделать последние запросы, и там список всех найденных
 * тгшек, назвать можно, переименовать и удалить»).
 *
 * Отдельного хранилища для этого не заводим: каждый прогон и так ложится в кэш со
 * всеми результатами, датой и подписью запроса. Здесь только чтение той же таблицы
 * в обратном порядке + человеческое имя поверх автоматической подписи.
 *
 * `title` — имя, которое дал человек; пусто — показываем `keywords` (слова запроса
 * или источники). Так «назвать по умолчанию» не требует выдумывания: запрос уже
 * описан тем, что в нём искали.
 */
export async function listQueries({ kind = '', ownerId = '', limit = 50 } = {}) {
  const base = sb()
  if (base) {
    // Пробуем с `title`, а если колонки ещё нет (код уехал раньше миграции) — без неё:
    // имена просто будут автоподписями, а список останется рабочим.
    for (const cols of ['sig,kind,keywords,title,updated_at,count,watch,owner_id', 'sig,kind,keywords,updated_at,count,watch,owner_id']) {
      let sel = base.from('parser_cache').select(cols)
      if (kind) sel = sel.eq('kind', String(kind))
      if (ownerId) sel = sel.eq('owner_id', String(ownerId))
      const { data, error } = await sel.order('updated_at', { ascending: false }).limit(limit)
      if (!error) return (data || []).map(queryRow)
      if (isMissingColumn(error)) continue
      if (!isMissingTable(error)) throw new Error(error.message)
      break
    }
  }
  const cols = 'sig,kind,keywords,title,updated_at,count,watch,owner_id'
  const cond = []
  const args = []
  if (kind) { cond.push('kind = ?'); args.push(String(kind)) }
  if (ownerId) { cond.push('owner_id = ?'); args.push(String(ownerId)) }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : ''
  const rows = db().prepare(`SELECT ${cols} FROM parser_cache ${where} ORDER BY updated_at DESC LIMIT ?`).all(...args, limit)
  return rows.map(queryRow)
}

/**
 * Короткое имя из подписи запроса: три первых слова, остальное — «+N». Полсотни
 * ключевых слов в строку списка не влезут, а обрезка по символам режет слово пополам.
 */
function shortName(keywords = '') {
  const parts = String(keywords).split(',').map((x) => x.trim()).filter(Boolean)
  if (!parts.length) return ''
  const head = parts.slice(0, 3).join(', ')
  return parts.length > 3 ? `${head} +${parts.length - 3}` : head
}

function queryRow(r) {
  return {
    sig: String(r.sig),
    kind: String(r.kind || ''),
    // Имя от человека главнее автоподписи, но автоподпись отдаём тоже: витрина
    // показывает её как расшифровку «что на самом деле искали».
    name: String(r.title || '').trim() || shortName(r.keywords) || 'Без названия',
    query: String(r.keywords || ''),
    renamed: !!r.title,
    updatedAt: Number(r.updated_at) || 0,
    count: Number(r.count) || 0,
    watch: !!r.watch,
    ownerId: r.owner_id ? String(r.owner_id) : '',
  }
}

/** Результаты одного сохранённого запроса — по нему витрина показывает найденные каналы. */
export async function queryResults(sig) {
  const key = String(sig || '')
  if (!key) return null
  const base = sb()
  if (base) {
    for (const cols of ['sig,kind,keywords,title,updated_at,count,results,owner_id', 'sig,kind,keywords,updated_at,count,results,owner_id']) {
      const { data, error } = await base.from('parser_cache').select(cols).eq('sig', key).maybeSingle()
      if (!error) return data ? { ...queryRow(data), results: Array.isArray(data.results) ? data.results : [] } : null
      if (isMissingColumn(error)) continue
      if (!isMissingTable(error)) throw new Error(error.message)
      break
    }
  }
  const r = db().prepare('SELECT sig,kind,keywords,title,updated_at,count,results,owner_id FROM parser_cache WHERE sig = ?').get(key)
  if (!r) return null
  let list = []
  try { list = JSON.parse(r.results || '[]') } catch { list = [] }
  return { ...queryRow(r), results: Array.isArray(list) ? list : [] }
}

/**
 * Переименовать запрос. Пустое имя снимает своё название и возвращает автоподпись —
 * отдельной кнопки «сбросить» для этого не нужно.
 */
export async function renameQuery(sig, title) {
  const key = String(sig || '')
  const name = String(title || '').trim().slice(0, 120) || null
  if (!key) return false
  const base = sb()
  if (base) {
    const { data, error } = await base.from('parser_cache').update({ title: name }).eq('sig', key).select('sig')
    if (!error) return (data || []).length > 0
    // Колонки ещё нет — переименовать нельзя, но и падать незачем: скажем честно.
    if (isMissingColumn(error)) throw new Error('Переименование появится после обновления базы — миграция ещё не применена')
    if (!isMissingTable(error)) throw new Error(error.message)
  }
  return db().prepare('UPDATE parser_cache SET title = ? WHERE sig = ?').run(name, key).changes > 0
}

/**
 * Удалить запрос вместе с результатами и слежением. Кэш общий на платформу, поэтому
 * удаление — это ещё и «собрать заново при следующем запуске», а не только уборка
 * в списке; вызывающая сторона обязана проверить владельца.
 */
export async function deleteQuery(sig) {
  const key = String(sig || '')
  if (!key) return false
  const base = sb()
  if (base) {
    const { data, error } = await base.from('parser_cache').delete().eq('sig', key).select('sig')
    if (!error) return (data || []).length > 0
    if (!isMissingTable(error)) throw new Error(error.message)
  }
  return db().prepare('DELETE FROM parser_cache WHERE sig = ?').run(key).changes > 0
}

/** Для тестов/обслуживания: закрыть и сбросить соединение (следующий вызов пересоздаст). */
export function _resetParserCacheDb() {
  try { _db?.close() } catch { /* already closed */ }
  _db = null
}
