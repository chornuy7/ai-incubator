/**
 * §5.1: БАЗА ОПЛАТ — queryable-индекс всех платежей поверх источников истины.
 *
 * Файлы (`wallet-log.jsonl`, журнал подписок) остаются источником правды — их пишут
 * биллинг и подписка. Здесь они собираются в SQLite (`data/payments.db`), чтобы
 * админка могла спрашивать «покупки за месяц назад» диапазоном дат и листать страницами,
 * а не упираться в срез последних N. Индекс ПЕРЕСОБИРАЕТСЯ из файлов (идемпотентно),
 * поэтому рассинхрона с деньгами быть не может: БД — витрина для чтения, не второй кошелёк.
 *
 * ГДЕ ЛЕЖИТ (правка 24.08). Раньше — всегда локальный SQLite. Вопрос владельца «зачем
 * нам две базы» справедлив вдвойне именно здесь: на проде источник витрины (`wallet_log`)
 * УЖЕ в общей БД, и выходило, что мы тянем сто тысяч строк из Postgres в файл на диске,
 * чтобы делать по ним запросы, которые Postgres делает сам. Плюс файл жил на диске одной
 * машины — второй инстанс означал бы вторую витрину со своими цифрами.
 * Теперь как у остальных сторов: включён Supabase — витрина там же, иначе SQLite
 * (локальная разработка и тесты).
 *
 * Правила «что считать доходом» (§3.2/MR-22) остаются ЗДЕСЬ, в JS, и не дублируются в
 * SQL: иначе две формулы дохода неизбежно разъедутся.
 *
 * SQLite — встроенный `node:sqlite` (Node 24), без нативных зависимостей. Когда
 * подключим платёжного провайдера, сюда добавятся статусы pending/failed/refunded и
 * ссылка на платёж — схема уже это предусматривает.
 */
import { DatabaseSync } from 'node:sqlite'
import { dataPath } from './lib/jsonStore.js'
import { readAudit } from './lib/auditLog.js'
import { supabaseEnabled, getSupabase, isMissingTable } from './lib/supabase.js'
import { walletHistory } from './balance.js'
import { toDbTime, fromDbTime } from './lib/dbTime.js'

const DB_FILE = () => process.env.PAYMENTS_DB || dataPath('payments.db')

/** Общая БД, если она включена; иначе null — витрина живёт в локальном SQLite. */
function sb() { return supabaseEnabled() ? getSupabase() : null }

const round3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000

let _db = null
function db() {
  if (_db) return _db
  const d = new DatabaseSync(DB_FILE())
  d.exec(`CREATE TABLE IF NOT EXISTS payments(
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    user_id TEXT,
    kind TEXT,            -- 'usd' (пополнение баланса $) | 'coins' (пополнение ⚡) | 'plan' (подписка $)
    coins REAL,           -- сколько монет начислено (для kind='coins')
    amount_fiat REAL,     -- сумма в валюте (для kind='plan' и 'usd')
    currency TEXT,        -- '⚡' | '$'
    modules INTEGER,      -- число модулей в плане (-1 = все)
    status TEXT,          -- 'paid' | (в будущем) 'pending'|'failed'|'refunded'
    reason TEXT
  )`)
  d.exec('CREATE INDEX IF NOT EXISTS idx_payments_ts ON payments(ts)')
  _db = d
  return _db
}

// Одно соединение на процесс, поэтому две параллельные пересборки открывали бы
// транзакцию поверх транзакции. Коалесцируем одновременные вызовы в один прогон.
let _syncing = null

/**
 * Пересобрать индекс из источников истины. Идемпотентно: id детерминированный, повтор
 * лишь перезаписывает ту же строку (INSERT OR REPLACE). Дёшево на текущем объёме.
 */
/** Отметка «источники были вот такими на прошлой сборке»: строк и время последней. */
let _собрано = ''

/**
 * Изменились ли источники с прошлой сборки.
 * @returns {Promise<{нужно: boolean, отметка: string}>}
 */
async function проверитьИсточники() {
  const base = sb()
  if (!base) return { нужно: true, отметка: '' } // файловый режим: дёшево и без запросов
  try {
    const [журнал, подписки] = await Promise.all([
      base.from('wallet_log').select('ts', { count: 'exact', head: false }).order('ts', { ascending: false }).limit(1),
      base.from('user_subscriptions').select('updated_at', { count: 'exact', head: false }).order('updated_at', { ascending: false }).limit(1),
    ])
    if (журнал.error || подписки.error) return { нужно: true, отметка: '' }
    const отметка = [
      журнал.count, журнал.data?.[0]?.ts ?? '',
      подписки.count, подписки.data?.[0]?.updated_at ?? '',
    ].join('|')
    return { нужно: отметка !== _собрано, отметка }
  } catch {
    return { нужно: true, отметка: '' } // не смогли проверить — собираем, как раньше
  }
}

export async function syncPayments() {
  if (_syncing) return _syncing
  const { нужно, отметка } = await проверитьИсточники()
  if (!нужно) return
  _syncing = doSync().then(() => { _собрано = отметка }).finally(() => { _syncing = null })
  return _syncing
}

/** Пересобрать витрину принудительно — для тестов и ручного «обновить». */
export function invalidatePaymentsCache() { _собрано = '' }

async function doSync() {
  // Строки витрины собираем ОДИН раз, общим кодом: правила «что считать доходом» не
  // должны зависеть от того, где лежит витрина.
  const rows = await buildRows()
  const base = sb()
  if (base) {
    /*
     * Upsert без предварительной очистки. DELETE+INSERT оставил бы окно, в котором
     * админка видит пустой отчёт (а при двух инстансах — ещё и гонку). Источники
     * append-only: строки не исчезают, только добавляются, поэтому осиротевшим тут
     * взяться неоткуда. Пачками — у запроса есть предел размера.
     */
    let ok = true
    for (let i = 0; i < rows.length && ok; i += 500) {
      // Время конвертируем на ГРАНИЦЕ: строки витрины общие с запасным SQLite, где
      // ts по-прежнему число.
      const batch = rows.slice(i, i + 500).map((r) => ({ ...r, ts: toDbTime(r.ts) }))
      const { error } = await base.from('payments').upsert(batch, { onConflict: 'id' })
      if (!error) continue
      if (!isMissingTable(error)) throw new Error(error.message)
      console.warn('[payments] таблица payments не найдена — миграция 2026-08-24 не накатана, собираю витрину в локальный SQLite')
      ok = false
    }
    if (ok) return
  }
  const d = db()
  const upsert = d.prepare(
    'INSERT OR REPLACE INTO payments(id,ts,user_id,kind,coins,amount_fiat,currency,modules,status,reason) VALUES(?,?,?,?,?,?,?,?,?,?)',
  )
  d.exec('BEGIN')
  try {
    // Полная пересборка: индекс — проекция источников истины. Раньше источником был
    // файл, теперь БД; чтобы старые файловые строки не остались сиротами, чистим и
    // строим заново (объём небольшой, дёшево).
    d.exec('DELETE FROM payments')
    for (const r of rows) {
      upsert.run(r.id, r.ts, r.user_id, r.kind, r.coins, r.amount_fiat, r.currency, r.modules, r.status, r.reason)
    }
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
}

/**
 * Собрать строки витрины из источников правды. Здесь и только здесь живут правила
 * «что считать доходом» — витрина их не переизобретает, где бы она ни лежала.
 */
async function buildRows() {
  const out = []
  // §11.4: читаем журнал кошелька через walletHistory (backend-aware: файл ИЛИ Supabase),
  // а не напрямую из файла — иначе в supabase-режиме индекс собирался бы из устаревшего
  // файла и не видел бы реальных пополнений. Валюта из записи разводит деньги ($) и токены (⚡).
  const wallet = await walletHistory({ limit: 100000 }).catch(() => [])
  for (const r of wallet) {
    const amount = Number(r.amount) || 0
    if (amount <= 0) continue // только пополнения/начисления, не списания
    const ts = Number(r.ts) || 0
    const uid = r.userId || null
    if (r.currency === 'usd') {
      /*
       * Пополнение ДЕНЬГАМИ ($) — но не всякое зачисление доллара есть выручка.
       *
       * Владелец 26.08: «$80 я выдавал через админку». Такие деньги лежали в витрине
       * рядом с настоящими пополнениями и попадали в итог как доход. Для токенов различие
       * «куплено / выдано» было с §3.2 (MR-22), для долларов — нет, и ручная выдача,
       * компенсация или подарок раздували выручку.
       *
       * Пометку ставит тот, кто зачисляет (админская ручка шлёт 'grant'). У старых записей
       * пометки нет — считаем их оплатой, как и вели себя все записи до этой правки:
       * задним числом объявлять прошлые пополнения подарками мы не вправе.
       */
      const выдано = r.kind === 'grant'
      out.push({ id: `u:${ts}:${uid ?? 'anon'}:${amount}`, ts, user_id: uid, kind: выдано ? 'usd_grant' : 'usd', coins: null, amount_fiat: round3(amount), currency: '$', modules: null, status: 'paid', reason: String(r.reason || '') })
      continue
    }
    /*
     * §3.2 (MR-22): «подарочные токены из подписки не учитывать как отдельный
     * доход — доходом является покупка плана; покупку дополнительных токенов
     * учитывать как отдельную денежную операцию».
     *
     * Раньше в доход шло ЛЮБОЕ начисление ⚡: и купленные токены, и подарок за
     * подписку, и месячная выдача, и ручное начисление админом. Подписка за $20
     * попадала в доход дважды — как оплата плана и как выданные ⚡ по курсу.
     *
     * kind проставляется при записи (balance.js). У старых строк его нет — их
     * разбираем по тексту причины: покупка токенов пишется как «Куплено за $…».
     */
    const bought = r.kind ? r.kind === 'purchase' : /^Куплено за \$/.test(String(r.reason || ''))
    out.push({ id: `w:${ts}:${uid ?? 'anon'}:${amount}`, ts, user_id: uid, kind: bought ? 'coins' : 'grant', coins: round3(amount), amount_fiat: null, currency: '⚡', modules: null, status: 'paid', reason: String(r.reason || '') })
  }
  // Покупки планов ($): события подписки с ценой (набор «все»/пустой — не покупка).
  const audit = await readAudit({ action: 'subscription.set', limit: 100000 }).catch(() => [])
  for (const e of audit) {
    const sum = Number(e.meta?.paid ?? e.meta?.cost?.sum) || 0
    if (sum <= 0) continue
    // `readAudit` отдаёт время СТРОКОЙ ISO (см. rowToEntry), а `Number('2026-08-11T…')`
    // это NaN. Стояло `Number(e.ts) || 0`, и от этого ломалось сразу две вещи: все
    // покупки планов получали время 0 (в витрине 1970 год), а вместе с ним и
    // ОДИНАКОВЫЙ id `p:0:<человек>`. У кого больше одной оплаченной подписки — а таких
    // на боевой девять — в один upsert прилетали строки с одним ключом, и Postgres
    // отвечал «ON CONFLICT DO UPDATE command cannot affect row a second time» (21000).
    // Падала пересборка витрины целиком, а вместе с ней и вся админ-статистика.
    const ts = Date.parse(e.ts) || Number(e.ts) || 0
    const uid = e.initiator && e.initiator !== 'system' ? e.initiator : null
    const mods = e.meta?.modules
    // Ключ — собственный id события аудита: две оплаты одного человека остаются двумя
    // строками, даже если случились в одну миллисекунду. Время в ключ не годится:
    // оно повторяется, а у события есть настоящий уникальный идентификатор.
    const key = e.id != null ? String(e.id) : `${ts}:${uid}:${round3(sum)}`
    out.push({ id: `p:${key}`, ts, user_id: uid, kind: 'plan', coins: null, amount_fiat: round3(sum), currency: '$', modules: mods === 'all' ? -1 : (Array.isArray(mods) ? mods.length : 0), status: 'paid', reason: String(e.reason || '') })
  }
  return dedupeById(out)
}

/**
 * Страховка от одинаковых ключей В ОДНОЙ пачке.
 *
 * Postgres отвергает весь upsert, если в нём дважды встречается один ключ, — и падает
 * не строка, а вся пересборка витрины. Причину выше мы починили, но источники живые:
 * пусть лучше совпавшая строка молча схлопнется, чем админка перестанет открываться.
 * Если такое случилось — говорим об этом в лог, чтобы не искать потом причину расхождения.
 */
function dedupeById(rows) {
  const byId = new Map()
  for (const r of rows) byId.set(r.id, r)
  if (byId.size !== rows.length) {
    console.warn(`[payments] в витрине совпали ключи: строк ${rows.length}, уникальных ${byId.size} — проверьте buildRows`)
  }
  return [...byId.values()]
}

/**
 * Запрос оплат с диапазоном дат (from..to по ts), фильтрами и пагинацией.
 * @param {{from?:number,to?:number,userId?:string,kind?:string,q?:string,limit?:number,offset?:number}} opts
 * @returns {{total:number, rows:object[]}}
 */
export async function queryPayments(opts = {}) {
  const { from = 0, to = 0, userId = '', kind = '', q = '', limit = 50, offset = 0 } = opts
  const lim0 = Math.min(500, Math.max(1, Number(limit) || 50))
  const off0 = Math.max(0, Number(offset) || 0)
  const base = sb()
  if (base) {
    let sel = base.from('payments').select('*', { count: 'exact' })
    if (from) sel = sel.gte('ts', toDbTime(from))
    if (to) sel = sel.lte('ts', toDbTime(to))
    if (userId) sel = sel.eq('user_id', String(userId))
    if (['coins', 'plan', 'usd', 'grant', 'usd_grant'].includes(kind)) sel = sel.eq('kind', kind)
    if (q) sel = sel.or(`user_id.ilike.%${q}%,reason.ilike.%${q}%`)
    const { data, count, error } = await sel.order('ts', { ascending: false }).range(off0, off0 + lim0 - 1)
    // Наружу отдаём миллисекунды, как и раньше: витрина оплат и фронт считают время
    // числом, и менять это ради формы хранения незачем.
    if (!error) return { total: Number(count) || 0, rows: (data || []).map((r) => ({ ...r, ts: fromDbTime(r.ts) })) }
    if (!isMissingTable(error)) throw new Error(error.message)
  }
  const d = db()
  const cond = []
  const args = []
  if (from) { cond.push('ts >= ?'); args.push(Number(from)) }
  if (to) { cond.push('ts <= ?'); args.push(Number(to)) }
  if (userId) { cond.push('user_id = ?'); args.push(String(userId)) }
  if (['coins', 'plan', 'usd', 'grant', 'usd_grant'].includes(kind)) { cond.push('kind = ?'); args.push(kind) }
  if (q) { cond.push('(user_id LIKE ? OR reason LIKE ?)'); args.push(`%${q}%`, `%${q}%`) }
  const w = cond.length ? 'WHERE ' + cond.join(' AND ') : ''
  const total = d.prepare(`SELECT COUNT(*) c FROM payments ${w}`).get(...args).c
  const rows = d.prepare(`SELECT * FROM payments ${w} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...args, lim0, off0)
  return { total, rows }
}

/** Итоги за диапазон: монеты (⚡) и планы ($) отдельно. */
export async function paymentsSummary(opts = {}) {
  const { from = 0, to = 0 } = opts
  const remote = sb()
  if (remote) {
    /*
     * Суммируем в JS, а не в SQL. Причина не в лени: в SQL пришлось бы завести вторую
     * формулу дохода (агрегат по kind), а разъехавшиеся формулы денег — худшее, что
     * можно сделать с отчётом. Витрина маленькая (только пополнения и покупки планов),
     * тянуть её диапазоном дёшево.
     */
    let sel = remote.from('payments').select('kind, coins, amount_fiat')
    if (from) sel = sel.gte('ts', toDbTime(from))
    if (to) sel = sel.lte('ts', toDbTime(to))
    const { data, error } = await sel.limit(100000)
    if (error && !isMissingTable(error)) throw new Error(error.message)
    if (!error) {
      const acc = { coins: [0, 0], grant: [0, 0], plan: [0, 0], usd: [0, 0], usd_grant: [0, 0] }
      for (const r of data || []) {
        const cell = acc[r.kind]
        if (!cell) continue
        cell[0] += Number(r.kind === 'coins' || r.kind === 'grant' ? r.coins : r.amount_fiat) || 0
        cell[1] += 1
      }
      return {
        coinsTotal: round3(acc.coins[0]), coinsCount: acc.coins[1],
        grantTotal: round3(acc.grant[0]), grantCount: acc.grant[1],
        planTotal: round3(acc.plan[0]), planCount: acc.plan[1],
        usdTotal: round3(acc.usd[0]), usdCount: acc.usd[1],
        usdGrantTotal: round3(acc.usd_grant[0]), usdGrantCount: acc.usd_grant[1],
      }
    }
  }
  const d = db()
  const base = []
  const args = []
  if (from) { base.push('ts >= ?'); args.push(Number(from)) }
  if (to) { base.push('ts <= ?'); args.push(Number(to)) }
  const wCoins = 'WHERE ' + [...base, "kind = 'coins'"].join(' AND ')
  // Выданные токены (подарок, месячная выдача, ручное начисление) — НЕ доход, но видеть
  // их надо: сколько мы раздали, тоже часть картины.
  const wGrant = 'WHERE ' + [...base, "kind = 'grant'"].join(' AND ')
  const wPlans = 'WHERE ' + [...base, "kind = 'plan'"].join(' AND ')
  const wUsd = 'WHERE ' + [...base, "kind = 'usd'"].join(' AND ')
  // Выданные руками деньги — отдельно от выручки (см. buildRows).
  const wUsdGrant = 'WHERE ' + [...base, "kind = 'usd_grant'"].join(' AND ')
  const coins = d.prepare(`SELECT COALESCE(SUM(coins),0) s, COUNT(*) c FROM payments ${wCoins}`).get(...args)
  const plans = d.prepare(`SELECT COALESCE(SUM(amount_fiat),0) s, COUNT(*) c FROM payments ${wPlans}`).get(...args)
  const usd = d.prepare(`SELECT COALESCE(SUM(amount_fiat),0) s, COUNT(*) c FROM payments ${wUsd}`).get(...args)
  const grant = d.prepare(`SELECT COALESCE(SUM(coins),0) s, COUNT(*) c FROM payments ${wGrant}`).get(...args)
  const usdGrant = d.prepare(`SELECT COALESCE(SUM(amount_fiat),0) s, COUNT(*) c FROM payments ${wUsdGrant}`).get(...args)
  return {
    coinsTotal: round3(coins.s), coinsCount: coins.c,
    grantTotal: round3(grant.s), grantCount: grant.c,
    planTotal: round3(plans.s), planCount: plans.c,
    usdTotal: round3(usd.s), usdCount: usd.c,
    usdGrantTotal: round3(usdGrant.s), usdGrantCount: usdGrant.c,
  }
}
