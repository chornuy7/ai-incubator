/**
 * Сущность «Канал» (§3.7/§3.8/§3.9). Общая база каналов: повторный парсинг обновляет карточку
 * и связи, а не создаёт дубль (§4 «данные канала не теряются»). Дедуп по username/peerId.
 * Хранение — JSON data/channels.json; путь через env CHANNELS_FILE (тесты).
 */
import crypto from 'crypto'
import { dataPath, readJson, writeJson } from './lib/jsonStore.js'

const CHANNELS_FILE = process.env.CHANNELS_FILE || dataPath('channels.json')

// §10.2: каналы переехали в Supabase (таблица `channels`). Стор исторически работает
// со ВСЕМ списком (read-modify-write), и переписывать его логику на точечные запросы
// значило бы трогать дедуп и слияние карточек — самую тонкую часть парсера. Поэтому
// здесь адаптер: те же «прочитать список / записать список», но поверх БД.
// Записей десятки-сотни, и пишет их пакетный парсер, а не горячий путь.
import { getSupabase, supabaseEnabled } from './lib/supabase.js'
import { toDbTime, fromDbTime } from './lib/dbTime.js'

function sbCh() { return supabaseEnabled() ? getSupabase() : null }

/*
 * MR-290: карточка канала — колонками, а не мешком `data`.
 *
 * Мешок назывался «всё остальное», но остального в нём не было: тринадцать полей, и
 * каждое лежало у ВСЕХ каналов. Это обычная запись, случайно записанная в одну ячейку —
 * с понятной ценой: «каналы на русском с ER выше 3%» по json не индексируется, тип не
 * проверяется, а имена ключей остаются camelCase посреди snake_case-базы.
 *
 * Карта ниже — единственное место, где живёт соответствие «поле карточки ↔ колонка».
 * Раньше оно было размазано по двум функциям, и добавить поле означало не забыть про обе.
 */
const COLUMNS = [
  // поле карточки, колонка, как переводить
  ['title', 'title', 'text'],
  ['username', 'username', 'text'],
  ['link', 'link', 'text'],
  ['subscribers', 'subscribers', 'number'],
  ['hasComments', 'has_comments', 'bool?'],
  ['tgPeerId', 'tg_peer_id', 'text?'],
  ['rating', 'rating', 'number?'],
  ['userId', 'user_id', 'text?'],
  ['category', 'category', 'text'],
  ['language', 'language', 'text'],
  ['region', 'region', 'text'],
  ['activity', 'activity', 'text?'],
  ['activityLabel', 'activity_label', 'text?'],
  ['avgViews', 'avg_views', 'number?'],
  ['er', 'er', 'number?'],
  ['botInGroup', 'bot_in_group', 'bool'],
  ['statsBy', 'stats_by', 'text?'],
  ['lastPostAt', 'last_post_at', 'time'],
  ['lastStatsAt', 'last_stats_at', 'time'],
]

/**
 * Значение из колонки → значение поля карточки.
 *
 * Знак `?` в типе значит, что NULL сохраняется как есть. Разница не косметическая:
 * `er = null` — «вовлечённость не считали», а `er = 0` — «посчитали, вышло ноль».
 * Свести их к нулю значило бы соврать в отчёте.
 */
function fromCol(v, kind) {
  if (kind === 'time') return fromDbTime(v)
  if (kind.startsWith('bool')) return kind.endsWith('?') ? (v ?? null) : v === true
  if (kind.startsWith('number')) return kind.endsWith('?') ? (v == null ? null : Number(v)) : (Number(v) || 0)
  return kind.endsWith('?') ? (v || null) : (v || '')
}

/** Значение поля карточки → значение колонки. */
function toCol(v, kind) {
  if (kind === 'time') return toDbTime(v)
  if (kind.startsWith('bool')) return kind.endsWith('?') ? (v ?? null) : v === true
  if (kind.startsWith('number')) return kind.endsWith('?') ? (v == null ? null : Number(v)) : (Number(v) || 0)
  return kind.endsWith('?') ? (v || null) : (v || '')
}

/**
 * Строка БД → объект канала.
 *
 * Мешок `data` раскрывается ПЕРВЫМ, колонки перекрывают его сверху: пока миграция ещё не
 * доехала, поле придёт из мешка, а как только колонка заполнена — из колонки. Обратный
 * порядок означал бы, что старое значение из мешка затирает свежее из колонки.
 */
const rowToChannel = (r) => {
  const out = { ...(r.data || {}), id: r.id }
  for (const [key, col, kind] of COLUMNS) {
    if (r[col] === undefined) continue // колонки ещё нет — оставляем то, что дал мешок
    const v = fromCol(r[col], kind)
    // Пустую колонку не даём затереть непустое значение из мешка: в промежутке между
    // накаткой миграции и выкатом кода писала предыдущая версия — в мешок, не в колонку.
    if (v === '' || v === null || v === 0) { if (out[key] !== undefined) continue }
    out[key] = v
  }
  out.createdAt = fromDbTime(r.created_at)
  out.updatedAt = fromDbTime(r.updated_at)
  if (!out.userId) out.userId = undefined
  return out
}

/** Поля, которые лежат в колонках и в мешке продублированы быть не должны. */
const COLUMN_KEYS = new Set([...COLUMNS.map(([key]) => key), 'id', 'createdAt', 'updatedAt'])

/**
 * Объект канала → строка БД.
 *
 * `data` пока пишется тоже: миграции применяются ДО выката кода, и в промежутке карточку
 * читает предыдущая версия, которая знает только мешок. Уберём вместе с колонкой.
 */
const channelToRow = (c) => {
  const row = { id: c.id, data: {} }
  for (const [key, col, kind] of COLUMNS) row[col] = toCol(c[key], kind)
  /*
   * Списки тоже дублируются в мешок на время перехода — включая `sources`.
   *
   * Соблазн не дублировать именно их велик: два места хранения одного списка однажды
   * разойдутся. Но здесь дороже другое. Миграции применяются ДО выката кода, и в это
   * окно каналы читает предыдущая версия — из мешка. Не написав туда источники, мы
   * сделали бы каналы НЕВИДИМЫМИ их владельцам: `channelsForRequest` показывает только
   * то, что нашли задачи оператора, и пустой список источников означает «не видно
   * никому». Расхождение на минуты лечится следующей записью; исчезнувшая база каналов
   * выглядит как потеря данных.
   */
  for (const [key, v] of Object.entries(c)) {
    if (COLUMN_KEYS.has(key)) continue
    row.data[key] = v
  }
  // Дубль в мешок — только на время перехода, и только для полей, которые предыдущая
  // версия кода читает именно оттуда.
  for (const [key] of COLUMNS) if (c[key] !== undefined) row.data[key] = c[key]
  row.created_at = new Date(c.createdAt || Date.now()).toISOString()
  row.updated_at = new Date(c.updatedAt || Date.now()).toISOString()
  return row
}

/*
 * Списки канала — строками в отдельных таблицах, а не массивами внутри мешка.
 *
 * `sources` — это НЕ справочная мелочь: по ней режется доступ. `channelsForRequest`
 * показывает оператору только те каналы, которые нашли его задачи, поэтому канал с
 * пустым списком источников не виден никому. Поле, от которого зависит видимость,
 * обязано быть проверяемым, а массив внутри json не проверяет никто.
 */
const LISTS = [
  { field: 'sources', table: 'channel_sources', column: 'task_id', ordered: false, prefix: 'parse:' },
  { field: 'categoriesExtra', table: 'channel_categories', column: 'category', ordered: true, prefix: '' },
]

/** Списки всех каналов разом: id канала → значения. Один запрос на таблицу, не N+1. */
async function readLists(db) {
  const out = {}
  for (const { field, table, column, ordered, prefix } of LISTS) {
    let q = db.from(table).select(`channel_id, ${column}`)
    if (ordered) q = q.order('position', { ascending: true })
    const { data, error } = await q
    // Таблицы ещё нет — миграция не доехала; пусть списки придут из мешка, как раньше.
    if (error) return null
    const map = new Map()
    for (const r of data || []) {
      if (!map.has(r.channel_id)) map.set(r.channel_id, [])
      map.get(r.channel_id).push(prefix + r[column])
    }
    out[field] = map
  }
  return out
}

/**
 * Переписать списки записываемых каналов.
 *
 * Снос ограничен ТЕМИ каналами, что пришли на запись, а не всей таблицей. Первая редакция
 * сносила `channel_sources` целиком (`delete().neq('channel_id','')`) и заново наполняла
 * из переданного списка. Пока список полный, результат тот же — но стоит вызвать запись с
 * частью каналов, и у остальных источники исчезают. А от источников зависит ВИДИМОСТЬ:
 * `channelsForRequest` показывает оператору только каналы, найденные его задачами, так что
 * это не «потерялось служебное поле», а «база каналов пропала у владельцев».
 *
 * @returns {Promise<boolean>} false — записать не удалось; вызывающий обязан это заметить.
 */
async function writeLists(db, all) {
  const ids = (all || []).map((c) => c?.id).filter(Boolean)
  if (!ids.length) return true
  for (const { field, table, column, ordered, prefix } of LISTS) {
    const rows = []
    for (const c of all || []) {
      const list = Array.isArray(c?.[field]) ? c[field] : []
      const seen = new Set()
      list.forEach((raw, i) => {
        const v = String(raw ?? '').replace(new RegExp(`^${prefix}`), '').trim()
        if (!v || seen.has(v)) return
        seen.add(v)
        rows.push({ channel_id: c.id, [column]: v, ...(ordered ? { position: i } : {}) })
      })
    }
    // Снимаем только у своих каналов и пачками: `in` с тысячей значений уезжает в адрес
    // запроса, а у него есть предел, за которым PostgREST отвечает ошибкой.
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await db.from(table).delete().in('channel_id', ids.slice(i, i + 200))
      if (error) { console.warn(`[channels] не удалось очистить ${table}:`, error.message); return false }
    }
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from(table).upsert(rows.slice(i, i + 500), { onConflict: `channel_id,${column}` })
      if (error) { console.warn(`[channels] не удалось записать ${table}:`, error.message); return false }
    }
  }
  return true
}

/** Прочитать весь список — из БД либо из файла. */
async function readAll() {
  const db = sbCh()
  if (db) {
    const { data, error } = await db.from('channels').select('*').order('updated_at', { ascending: false })
    // Таблицы ещё нет (миграция не применена) — работаем по файлу, не роняя парсер.
    if (error) return readJson(CHANNELS_FILE, [])
    const channels = (data || []).map(rowToChannel)
    const lists = await readLists(db)
    if (lists) {
      for (const c of channels) {
        for (const { field } of LISTS) {
          const изТаблицы = lists[field].get(c.id)
          /*
           * Пустой результат таблицы НЕ затирает непустой список из мешка.
           *
           * Пока мешок ещё пишется (переходный выпуск), у канала список есть в обоих
           * местах, и они совпадают: их пишет одна и та же `writeAll`. А вот у канала,
           * заведённого предыдущей версией кода в окно выката, строк в таблице нет вовсе —
           * и «нет строк» означало бы «источников нет», то есть канал, невидимый своему
           * владельцу. Намеренное опустошение при этом опустошает и мешок, так что откат
           * вернёт тот же пустой список, а не воскресит снятые источники.
           *
           * Снимается вместе с записью в мешок — следующим выпуском.
           */
          if (изТаблицы?.length) c[field] = изТаблицы
          else if (!Array.isArray(c[field])) c[field] = []
        }
      }
    }
    return channels
  }
  return readJson(CHANNELS_FILE, [])
}

/** Записать весь список: upsert всех + удаление тех, кого в списке больше нет. */
async function writeAll(all) {
  const db = sbCh()
  if (!db) return writeJson(CHANNELS_FILE, all)
  const rows = (all || []).map(channelToRow)
  if (rows.length) {
    const { error } = await db.from('channels').upsert(rows, { onConflict: 'id' })
    if (error) { console.warn('[channels] запись в БД не удалась:', error.message); return writeJson(CHANNELS_FILE, all) }
  }
  // Удалённые каналы: чего нет в списке — нет и в таблице.
  const { data: existing } = await db.from('channels').select('id')
  const keep = new Set(rows.map((r) => r.id))
  const gone = (existing || []).map((r) => r.id).filter((id) => !keep.has(id))
  if (gone.length) await db.from('channels').delete().in('id', gone)
  // Списки пишем ПОСЛЕ каналов: у дочерних таблиц внешний ключ на channels, и до
  // появления самого канала строка источника просто не вставится.
  //
  // Отказ здесь НЕ проглатываем. От источников зависит видимость канала, а `console.warn`
  // рядом с успешным ответом означает «сохранили» в интерфейсе и пустую таблицу в базе.
  // Уходим в тот же файловый откат, что и при отказе записи самих каналов.
  if (!await writeLists(db, all)) {
    console.warn('[channels] списки каналов не записаны — сохраняю в файл, чтобы не потерять источники')
    return writeJson(CHANNELS_FILE, all)
  }
  return all
}


/** Нормализовать ключ дедупа: username в нижнем регистре без @, либо peerId. */
export function channelKey(input = {}) {
  const u = String(input.username || '').replace(/^@/, '').toLowerCase()
  if (u) return `u:${u}`
  if (input.tgPeerId) return `p:${input.tgPeerId}`
  const link = String(input.link || '').toLowerCase().replace(/\/+$/, '')
  return link ? `l:${link}` : null
}

export async function listChannels() {
  return readAll()
}

export async function getChannel(id) {
  return (await listChannels()).find((c) => c.id === id) || null
}

/**
 * Upsert канала: если есть по ключу — обновляем поля и добавляем источник, иначе создаём.
 * @param {object} input @param {string} [source] метка источника (запуск парсинга/категория)
 */
export async function upsertChannel(input = {}, source) {
  const key = channelKey(input)
  const all = await listChannels()
  const idx = key ? all.findIndex((c) => channelKey(c) === key) : -1
  const now = Date.now()

  const fields = {
    title: input.title ?? '',
    link: input.link ?? (input.username ? `https://t.me/${String(input.username).replace(/^@/, '')}` : ''),
    username: input.username ? String(input.username).replace(/^@/, '') : '',
    category: input.category ?? '',
    language: input.language ?? '',
    region: input.region ?? '',
    subscribers: Number(input.subscribers) || 0,
    activity: input.activity ?? null,
    hasComments: input.hasComments ?? null,
    rating: input.rating ?? null,
    tgPeerId: input.tgPeerId ?? null,
    botInGroup: input.botInGroup, // true → авто ~раз в час, иначе раз в день (решение 14.07)
  }

  if (idx >= 0) {
    const cur = all[idx]
    const sources = new Set(cur.sources || [])
    if (source) sources.add(source)
    const merged = { ...cur }
    // Обновляем поле только если новое значение осмысленное — непустое старое не затираем.
    for (const [k, v] of Object.entries(fields)) {
      const meaningful = v !== undefined && v !== '' && v !== null && !(typeof v === 'number' && v === 0)
      if (meaningful) merged[k] = v
    }
    merged.sources = [...sources]
    merged.updatedAt = now
    all[idx] = merged
    await writeAll(all)
    return merged
  }

  const channel = {
    id: `ch_${crypto.randomUUID().slice(0, 8)}`,
    ...fields,
    botInGroup: input.botInGroup ?? false,
    sources: source ? [source] : [],
    categoriesExtra: [],
    lastStatsAt: null,
    statsBy: null,
    createdAt: now,
    updatedAt: now,
  }
  all.unshift(channel)
  await writeAll(all)
  return channel
}

/**
 * Пакетный upsert (для парсера): один read-modify-write на весь список.
 * Дедуп по ключу, обновляет карточку + источник, не создаёт дубли (§3.8/§4).
 * @param {object[]} items @param {string} [source]
 */
export async function upsertMany(items = [], source) {
  if (!items.length) return 0
  const all = await listChannels()
  const byKey = new Map()
  all.forEach((c, i) => { const k = channelKey(c); if (k) byKey.set(k, i) })
  const now = Date.now()
  let n = 0
  for (const input of items) {
    const key = channelKey(input)
    if (!key) continue
    const fields = {
      title: input.title ?? '',
      username: input.username ? String(input.username).replace(/^@/, '') : '',
      link: input.link ?? (input.username ? `https://t.me/${String(input.username).replace(/^@/, '')}` : ''),
      subscribers: Number(input.subscribers) || 0,
      hasComments: input.hasComments ?? null,
      tgPeerId: input.tgPeerId ?? null,
    }
    if (byKey.has(key)) {
      const c = all[byKey.get(key)]
      for (const [k, v] of Object.entries(fields)) {
        const ok = v !== undefined && v !== '' && v !== null && !(typeof v === 'number' && v === 0)
        if (ok) c[k] = v
      }
      const src = new Set(c.sources || []); if (source) src.add(source); c.sources = [...src]
      c.updatedAt = now
    } else {
      const c = {
        id: `ch_${crypto.randomUUID().slice(0, 8)}`, ...fields, category: '', language: '', region: '',
        activity: null, rating: null, botInGroup: false, sources: source ? [source] : [], categoriesExtra: [],
        lastStatsAt: null, statsBy: null, createdAt: now, updatedAt: now,
      }
      all.unshift(c); byKey.set(key, 0)
    }
    n += 1
  }
  await writeAll(all)
  return n
}

/** Записать свежую статистику канала (кто обновил, когда). @param {string} id @param {object} stats @param {string} [statsBy] */
export async function recordChannelStats(id, stats = {}, statsBy) {
  const all = await listChannels()
  const i = all.findIndex((c) => c.id === id)
  if (i === -1) return null
  if (stats.subscribers != null) all[i].subscribers = Number(stats.subscribers) || 0
  if (stats.activity != null) all[i].activity = stats.activity
  if (stats.hasComments != null) all[i].hasComments = stats.hasComments
  // 2-й проход (§3.9): метка свежести контента (отдельно от числового activity парсера).
  if (stats.activityLabel != null) all[i].activityLabel = stats.activityLabel
  if (stats.lastPostAt != null) all[i].lastPostAt = stats.lastPostAt
  if (stats.er !== undefined) all[i].er = stats.er // §6: вовлечённость (ER)
  if (stats.avgViews != null) all[i].avgViews = stats.avgViews
  all[i].lastStatsAt = Date.now()
  all[i].statsBy = statsBy || 'system'
  all[i].updatedAt = Date.now()
  await writeAll(all)
  return all[i]
}

/** Обновить редактируемые поля канала (напр. botInGroup, category). @param {string} id @param {object} patch */
export async function updateChannel(id, patch = {}) {
  const all = await listChannels()
  const i = all.findIndex((c) => c.id === id)
  if (i === -1) return null
  const EDITABLE = ['botInGroup', 'category', 'language', 'region', 'title', 'hasComments']
  for (const k of EDITABLE) if (patch[k] !== undefined) all[i][k] = patch[k]
  all[i].updatedAt = Date.now()
  await writeAll(all)
  return all[i]
}

export async function deleteChannel(id) {
  const all = await listChannels()
  const next = all.filter((c) => c.id !== id)
  if (next.length === all.length) return false
  await writeAll(next)
  return true
}
