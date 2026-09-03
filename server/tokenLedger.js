/**
 * §5.1 SPEC (C1): журнал расхода токенов ИИ — сколько «выжирает» каждый запрос,
 * в разрезе модуля, аккаунта, задачи и кампании.
 *
 * Зачем отдельной сущностью: без этого C2 нечего списывать — курс «токен → монета»
 * считать не из чего, а на вопрос «почему списалось столько» ответить нечем.
 * Журнал — это ещё и доказательство для клиента: расход видно построчно.
 *
 * Хранение — JSONL `data/token-ledger.jsonl` (дописываем строку, не переписываем файл):
 * записей будет много, и read-modify-write целого файла на каждый запрос к OpenAI
 * означал бы и тормоза, и гонку — ту же, что была у accounts-meta.
 */
import fs from 'fs/promises'
import path from 'path'
import { dataPath } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

function sb() { return supabaseEnabled() ? getSupabase() : null }
const ledgerRowFromDb = (r) => ({
  ts: r.ts ? new Date(r.ts).getTime() : 0, module: r.module || '', accountId: r.account_id || '',
  taskId: r.task_id || '', campaignId: r.campaign_id || '', userId: r.user_id || '', model: r.model || '',
  tokens: Number(r.tokens) || 0, promptTokens: Number(r.prompt_tokens) || 0,
  completionTokens: Number(r.completion_tokens) || 0, coins: Number(r.coins) || 0,
})

const LEDGER_FILE = () => process.env.TOKEN_LEDGER_FILE || dataPath('token-ledger.jsonl')

/**
 * Внутренняя ledger-константа: 1000 токенов = 1 монета — ТОЛЬКО для справочного `coins`
 * в журнале расхода ИИ (отчёт клиенту). На БИЛЛИНГ не влияет (токены не списываются, MR-149).
 * Раньше это был «курс coinsPer1kTokens» из админки — убран как выдуманное значение (созвон 19.08).
 */
export const COINS_PER_1K_TOKENS = 1

/**
 * Токены → монеты по курсу `per1k` монет за 1000 токенов (по умолчанию — код-константа).
 * Точность — до ТЫСЯЧНЫХ (как COIN_PRECISION в balance.js): округление до сотых делало
 * 5 токенов = 0.005 → 0.01 (вдвое дороже), а 1–4 токена → 0 (бесплатно).
 * @param {number} tokens @param {number} [per1k] монет за 1000 токенов @returns {number}
 */
export function tokensToCoins(tokens, per1k = COINS_PER_1K_TOKENS) {
  const t = Math.max(0, Number(tokens) || 0)
  const rate = Number(per1k) > 0 ? Number(per1k) : COINS_PER_1K_TOKENS
  return Math.round((t / 1000) * rate * 1000) / 1000
}

/**
 * Записать расход. Best-effort: журнал не должен ронять генерацию — если запись
 * не удалась, работа модуля продолжается, а мы теряем строку статистики, но не задачу.
 * @param {{module?:string, accountId?:string, taskId?:string, campaignId?:string,
 *          userId?:string, tokens?:number, promptTokens?:number, completionTokens?:number,
 *          model?:string, coinMultiplier?:number}} entry
 *   `userId` — чей кошелёк платит за расход (без него списывается с общего).
 *   `coinMultiplier` (§10.5): множитель монет за расход — для анализа изображений
 *   (vision дороже текста, заказчик выставляет «картинка ×N» в админке). На токены
 *   не влияет: в журнале честное число токенов, дороже только пересчёт в монеты.
 */
export async function recordTokens(entry = {}) {
  const tokens = Math.max(0, Number(entry.tokens) || 0)
  if (!tokens) return null
  const mult = Math.max(1, Number(entry.coinMultiplier) || 1)
  // MR-149 (созвон 19.08): «курс токен→монета» из админки (coinsPer1kTokens) убран как
  // выдуманное значение — токены НЕ списываются (журнал справочный). `coins` считаем по
  // внутренней ledger-константе только для отчёта о расходе ИИ, не для биллинга.
  const per1k = COINS_PER_1K_TOKENS
  const row = {
    ts: Date.now(),
    module: String(entry.module || ''),
    accountId: String(entry.accountId || ''),
    taskId: String(entry.taskId || ''),
    campaignId: String(entry.campaignId || ''),
    userId: String(entry.userId || ''),
    model: String(entry.model || ''),
    tokens,
    promptTokens: Math.max(0, Number(entry.promptTokens) || 0),
    completionTokens: Math.max(0, Number(entry.completionTokens) || 0),
    coins: Math.round(tokensToCoins(tokens, per1k) * mult * 1000) / 1000,
  }
  const db = sb()
  if (db) {
    try {
      await db.from('token_ledger').insert({
        ts: new Date(row.ts).toISOString(), module: row.module, account_id: row.accountId,
        task_id: row.taskId, campaign_id: row.campaignId, user_id: row.userId, model: row.model,
        tokens: row.tokens, prompt_tokens: row.promptTokens, completion_tokens: row.completionTokens, coins: row.coins,
      })
    } catch { return null }
  } else {
    try {
      const file = LEDGER_FILE()
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.appendFile(file, JSON.stringify(row) + '\n', 'utf8')
    } catch {
      return null
    }
  }
  // MR-149 (созвон 12.08): оплата за отправку и за генерацию текста объединена в ОДНУ
  // цену за действие (`ACTION_PRICE`, списывается в actionBilling), и считается «как за
  // МАКСИМУМ символов» (лимит Telegram 4096 / 1024 с картинкой), а не по факту токенов.
  // Поэтому здесь монеты БОЛЬШЕ НЕ СПИСЫВАЕМ — журнал остаётся честным учётом расхода ИИ
  // (сколько токенов реально ушло, для отчёта клиенту и аналитики), но деньги берёт
  // фикс-цена действия. `row.coins` = справочная стоимость токенов, не фактическое списание.
  return row
}

/**
 * Учесть ответ OpenAI (`data.usage`) как расход. Обёртка нужна там, где вызов ИИ
 * живёт не в воркере: подсказки, классификация лидов, эмбеддинги. Без неё эти
 * токены не попадали в журнал вообще — отчёт клиенту показывал меньше, чем
 * потрачено на самом деле.
 * @param {{total_tokens?:number, prompt_tokens?:number, completion_tokens?:number}|undefined} usage
 * @param {string} module @param {string} [userId] чей кошелёк платит
 */
export async function noteUsage(usage, module, userId) {
  const tokens = Number(usage?.total_tokens) || 0
  if (!tokens) return null
  return recordTokens({
    module,
    tokens,
    promptTokens: Number(usage?.prompt_tokens) || 0,
    completionTokens: Number(usage?.completion_tokens) || 0,
    userId,
  }).catch(() => null)
}

/** Прочитать журнал (свежие сверху). @param {{limit?:number, taskId?:string, module?:string, accountId?:string, since?:number}} [filter] */
export async function readLedger(filter = {}) {
  const db = sb()
  if (db) {
    let q = db.from('token_ledger').select('*').order('ts', { ascending: false })
    if (filter.taskId) q = q.eq('task_id', filter.taskId)
    if (filter.module) q = q.eq('module', filter.module)
    if (filter.accountId) q = q.eq('account_id', filter.accountId)
    if (filter.since) q = q.gte('ts', new Date(Number(filter.since)).toISOString())
    if (filter.limit) q = q.limit(filter.limit)
    else q = q.limit(100000)
    const { data } = await q
    return (data || []).map(ledgerRowFromDb)
  }
  let raw = ''
  try {
    raw = await fs.readFile(LEDGER_FILE(), 'utf8')
  } catch {
    return []
  }
  const rows = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* битая строка не должна ронять отчёт */ }
  }
  const out = rows.filter((r) => (
    (!filter.taskId || r.taskId === filter.taskId)
    && (!filter.module || r.module === filter.module)
    && (!filter.accountId || r.accountId === filter.accountId)
    && (!filter.since || r.ts >= filter.since)
  ))
  out.reverse()
  return filter.limit ? out.slice(0, filter.limit) : out
}

/**
 * Свод: сколько потрачено всего и по разрезам. Нужен и для отчёта клиенту (§E2),
 * и для экрана задачи — «во сколько обошёлся этот запуск».
 * @param {{taskId?:string, module?:string, accountId?:string, since?:number}} [filter]
 */
export async function tokenSummary(filter = {}) {
  const rows = await readLedger(filter)
  const sum = { tokens: 0, coins: 0, calls: rows.length, byModule: {}, byAccount: {} }
  for (const r of rows) {
    sum.tokens += r.tokens
    sum.coins = Math.round((sum.coins + r.coins) * 100) / 100
    if (r.module) sum.byModule[r.module] = (sum.byModule[r.module] || 0) + r.tokens
    if (r.accountId) sum.byAccount[r.accountId] = (sum.byAccount[r.accountId] || 0) + r.tokens
  }
  return sum
}
