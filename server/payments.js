/**
 * §5.1: БАЗА ОПЛАТ — queryable-индекс всех платежей поверх источников истины.
 *
 * Файлы (`wallet-log.jsonl`, журнал подписок) остаются источником правды — их пишут
 * биллинг и подписка. Здесь они собираются в SQLite (`data/payments.db`), чтобы
 * админка могла спрашивать «покупки за месяц назад» диапазоном дат и листать страницами,
 * а не упираться в срез последних N. Индекс ПЕРЕСОБИРАЕТСЯ из файлов (идемпотентно),
 * поэтому рассинхрона с деньгами быть не может: БД — витрина для чтения, не второй кошелёк.
 *
 * SQLite — встроенный `node:sqlite` (Node 24), без нативных зависимостей. Когда
 * подключим платёжного провайдера, сюда добавятся статусы pending/failed/refunded и
 * ссылка на платёж — схема уже это предусматривает.
 */
import { DatabaseSync } from 'node:sqlite'
import { dataPath } from './lib/jsonStore.js'
import { readAudit } from './lib/auditLog.js'

const DB_FILE = () => process.env.PAYMENTS_DB || dataPath('payments.db')
const WALLET_LOG = () => process.env.WALLET_LOG_FILE || dataPath('wallet-log.jsonl')

const round3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000

let _db = null
function db() {
  if (_db) return _db
  const d = new DatabaseSync(DB_FILE())
  d.exec(`CREATE TABLE IF NOT EXISTS payments(
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    user_id TEXT,
    kind TEXT,            -- 'coins' (пополнение ⚡) | 'plan' (покупка/продление подписки $)
    coins REAL,           -- сколько монет начислено (для kind='coins')
    amount_fiat REAL,     -- сумма в валюте (для kind='plan')
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
  const fs = await import('node:fs/promises')
  const d = db()
  const upsert = d.prepare(
    'INSERT OR REPLACE INTO payments(id,ts,user_id,kind,coins,amount_fiat,currency,modules,status,reason) VALUES(?,?,?,?,?,?,?,?,?,?)',
  )
  d.exec('BEGIN')
  try {
    // Пополнения монет (⚡): положительные операции кошелька.
    let raw = ''
    try { raw = await fs.readFile(WALLET_LOG(), 'utf8') } catch { /* нет файла — нет пополнений */ }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let r
      try { r = JSON.parse(line) } catch { continue }
      const amount = Number(r.amount) || 0
      if (amount <= 0) continue
      const ts = Number(r.ts) || 0
      upsert.run(`w:${ts}:${r.userId || '-'}:${amount}`, ts, r.userId || '—', 'coins', round3(amount), null, '⚡', null, 'paid', String(r.reason || ''))
    }
    // Покупки планов ($): события подписки с ценой (набор «все»/пустой — не покупка).
    const audit = await readAudit({ action: 'subscription.set', limit: 100000 }).catch(() => [])
    for (const e of audit) {
      const sum = Number(e.meta?.cost?.sum) || 0
      if (sum <= 0) continue
      const ts = Number(e.ts) || 0
      const uid = e.initiator && e.initiator !== 'system' ? e.initiator : '—'
      const mods = e.meta?.modules
      upsert.run(`p:${ts}:${uid}`, ts, uid, 'plan', null, round3(sum), '$', mods === 'all' ? -1 : (Array.isArray(mods) ? mods.length : 0), 'paid', String(e.reason || ''))
    }
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
}

/**
 * Запрос оплат с диапазоном дат (from..to по ts), фильтрами и пагинацией.
 * @param {{from?:number,to?:number,userId?:string,kind?:string,q?:string,limit?:number,offset?:number}} opts
 * @returns {{total:number, rows:object[]}}
 */
export function queryPayments(opts = {}) {
  const { from = 0, to = 0, userId = '', kind = '', q = '', limit = 50, offset = 0 } = opts
  const d = db()
  const cond = []
  const args = []
  if (from) { cond.push('ts >= ?'); args.push(Number(from)) }
  if (to) { cond.push('ts <= ?'); args.push(Number(to)) }
  if (userId) { cond.push('user_id = ?'); args.push(String(userId)) }
  if (kind === 'coins' || kind === 'plan') { cond.push('kind = ?'); args.push(kind) }
  if (q) { cond.push('(user_id LIKE ? OR reason LIKE ?)'); args.push(`%${q}%`, `%${q}%`) }
  const w = cond.length ? 'WHERE ' + cond.join(' AND ') : ''
  const total = d.prepare(`SELECT COUNT(*) c FROM payments ${w}`).get(...args).c
  const lim = Math.min(500, Math.max(1, Number(limit) || 50))
  const off = Math.max(0, Number(offset) || 0)
  const rows = d.prepare(`SELECT * FROM payments ${w} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...args, lim, off)
  return { total, rows }
}

/** Итоги за диапазон: монеты (⚡) и планы ($) отдельно. */
export function paymentsSummary(opts = {}) {
  const { from = 0, to = 0 } = opts
  const d = db()
  const base = []
  const args = []
  if (from) { base.push('ts >= ?'); args.push(Number(from)) }
  if (to) { base.push('ts <= ?'); args.push(Number(to)) }
  const wCoins = 'WHERE ' + [...base, "kind = 'coins'"].join(' AND ')
  const wPlans = 'WHERE ' + [...base, "kind = 'plan'"].join(' AND ')
  const coins = d.prepare(`SELECT COALESCE(SUM(coins),0) s, COUNT(*) c FROM payments ${wCoins}`).get(...args)
  const plans = d.prepare(`SELECT COALESCE(SUM(amount_fiat),0) s, COUNT(*) c FROM payments ${wPlans}`).get(...args)
  return { coinsTotal: round3(coins.s), coinsCount: coins.c, planTotal: round3(plans.s), planCount: plans.c }
}
