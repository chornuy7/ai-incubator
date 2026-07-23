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

const LEDGER_FILE = () => process.env.TOKEN_LEDGER_FILE || dataPath('token-ledger.jsonl')

/**
 * Курс пересчёта в монеты. Держим здесь одним местом: прайсы заказчик утверждает
 * отдельно, и менять их нужно будет в одной строке, а не по всему коду.
 * 1000 токенов = 1 монета — временное значение до утверждения прайса.
 */
export const COINS_PER_1K_TOKENS = 1

/** @param {number} tokens @returns {number} монеты с точностью до сотых */
export function tokensToCoins(tokens) {
  const t = Math.max(0, Number(tokens) || 0)
  return Math.round((t / 1000) * COINS_PER_1K_TOKENS * 100) / 100
}

/**
 * Записать расход. Best-effort: журнал не должен ронять генерацию — если запись
 * не удалась, работа модуля продолжается, а мы теряем строку статистики, но не задачу.
 * @param {{module?:string, accountId?:string, taskId?:string, campaignId?:string,
 *          tokens?:number, promptTokens?:number, completionTokens?:number, model?:string}} entry
 */
export async function recordTokens(entry = {}) {
  const tokens = Math.max(0, Number(entry.tokens) || 0)
  if (!tokens) return null
  const row = {
    ts: Date.now(),
    module: String(entry.module || ''),
    accountId: String(entry.accountId || ''),
    taskId: String(entry.taskId || ''),
    campaignId: String(entry.campaignId || ''),
    model: String(entry.model || ''),
    tokens,
    promptTokens: Math.max(0, Number(entry.promptTokens) || 0),
    completionTokens: Math.max(0, Number(entry.completionTokens) || 0),
    coins: tokensToCoins(tokens),
  }
  try {
    const file = LEDGER_FILE()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, JSON.stringify(row) + '\n', 'utf8')
  } catch {
    return null
  }
  // C2 (§5.1): за расход ИИ сразу списываем монеты. Best-effort по той же причине,
  // что и запись журнала: сбой биллинга не должен ронять работающую задачу — деньги
  // у OpenAI уже потрачены, и «откатить» действие всё равно нельзя.
  if (row.coins > 0) {
    try {
      const { changeCoins } = await import('./balance.js')
      await changeCoins(-row.coins, `${row.module || 'ИИ'}: ${row.tokens} токенов`)
    } catch { /* не роняем задачу из-за биллинга */ }
  }
  return row
}

/** Прочитать журнал (свежие сверху). @param {{limit?:number, taskId?:string, module?:string, accountId?:string, since?:number}} [filter] */
export async function readLedger(filter = {}) {
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
