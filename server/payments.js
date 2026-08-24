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
export async function syncPayments() {
  if (_syncing) return _syncing
  _syncing = doSync().finally(() => { _syncing = null })
  return _syncing
}

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
      const { error } = await base.from('payments').upsert(rows.slice(i, i + 500), { onConflict: 'id' })
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
    const uid = r.userId || '—'
    if (r.currency === 'usd') {
      // Пополнение баланса ДЕНЬГАМИ ($).
      out.push({ id: `u:${ts}:${uid}:${amount}`, ts, user_id: uid, kind: 'usd', coins: null, amount_fiat: round3(amount), currency: '$', modules: null, status: 'paid', reason: String(r.reason || '') })
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
    out.push({ id: `w:${ts}:${uid}:${amount}`, ts, user_id: uid, kind: bought ? 'coins' : 'grant', coins: round3(amount), amount_fiat: null, currency: '⚡', modules: null, status: 'paid', reason: String(r.reason || '') })
  }
  // Покупки планов ($): события подписки с ценой (набор «все»/пустой — не покупка).
  const audit = await readAudit({ action: 'subscription.set', limit: 100000 }).catch(() => [])
  for (const e of audit) {
    const sum = Number(e.meta?.paid ?? e.meta?.cost?.sum) || 0
    if (sum <= 0) continue
    const ts = Number(e.ts) || 0
    const uid = e.initiator && e.initiator !== 'system' ? e.initiator : '—'
    const mods = e.meta?.modules
    out.push({ id: `p:${ts}:${uid}`, ts, user_id: uid, kind: 'plan', coins: null, amount_fiat: round3(sum), currency: '$', modules: mods === 'all' ? -1 : (Array.isArray(mods) ? mods.length : 0), status: 'paid', reason: String(e.reason || '') })
  }
  return out
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
    if (from) sel = sel.gte('ts', Number(from))
    if (to) sel = sel.lte('ts', Number(to))
    if (userId) sel = sel.eq('user_id', String(userId))
    if (kind === 'coins' || kind === 'plan' || kind === 'usd' || kind === 'grant') sel = sel.eq('kind', kind)
    if (q) sel = sel.or(`user_id.ilike.%${q}%,reason.ilike.%${q}%`)
    const { data, count, error } = await sel.order('ts', { ascending: false }).range(off0, off0 + lim0 - 1)
    if (!error) return { total: Number(count) || 0, rows: data || [] }
    if (!isMissingTable(error)) throw new Error(error.message)
  }
  const d = db()
  const cond = []
  const args = []
  if (from) { cond.push('ts >= ?'); args.push(Number(from)) }
  if (to) { cond.push('ts <= ?'); args.push(Number(to)) }
  if (userId) { cond.push('user_id = ?'); args.push(String(userId)) }
  if (kind === 'coins' || kind === 'plan' || kind === 'usd' || kind === 'grant') { cond.push('kind = ?'); args.push(kind) }
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
    if (from) sel = sel.gte('ts', Number(from))
    if (to) sel = sel.lte('ts', Number(to))
    const { data, error } = await sel.limit(100000)
    if (error && !isMissingTable(error)) throw new Error(error.message)
    if (!error) {
      const acc = { coins: [0, 0], grant: [0, 0], plan: [0, 0], usd: [0, 0] }
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
  const coins = d.prepare(`SELECT COALESCE(SUM(coins),0) s, COUNT(*) c FROM payments ${wCoins}`).get(...args)
  const plans = d.prepare(`SELECT COALESCE(SUM(amount_fiat),0) s, COUNT(*) c FROM payments ${wPlans}`).get(...args)
  const usd = d.prepare(`SELECT COALESCE(SUM(amount_fiat),0) s, COUNT(*) c FROM payments ${wUsd}`).get(...args)
  const grant = d.prepare(`SELECT COALESCE(SUM(coins),0) s, COUNT(*) c FROM payments ${wGrant}`).get(...args)
  return {
    coinsTotal: round3(coins.s), coinsCount: coins.c,
    grantTotal: round3(grant.s), grantCount: grant.c,
    planTotal: round3(plans.s), planCount: plans.c,
    usdTotal: round3(usd.s), usdCount: usd.c,
  }
}
