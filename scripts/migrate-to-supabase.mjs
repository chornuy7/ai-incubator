/**
 * §10.2: миграция server/data/*.json → Supabase (Postgres).
 *
 * Идемпотентно (upsert по id) — можно гонять повторно. Порядок учитывает FK
 * (users до coin_balance/subscriptions). Креденшлы — из .env (SUPABASE_URL +
 * SUPABASE_SECRET_KEY), секрет в репозиторий не попадает.
 *
 * Запуск: node scripts/migrate-to-supabase.mjs
 */
import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(__dirname, '..', 'server', 'data')

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE
if (!url || !key) {
  console.error('Нет SUPABASE_URL / SUPABASE_SECRET_KEY в .env — заполните и повторите.')
  process.exit(1)
}
const db = createClient(url, key, { auth: { persistSession: false } })

const ts = (ms) => (ms ? new Date(Number(ms)).toISOString() : null)
async function readJson(name, fallback) {
  try { return JSON.parse(await readFile(path.join(DATA, name), 'utf8')) } catch { return fallback }
}
async function readJsonl(name) {
  try {
    const raw = await readFile(path.join(DATA, name), 'utf8')
    return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
async function upsert(table, rows, opts) {
  if (!rows.length) { console.log(`  ${table}: 0`); return }
  const { error } = await db.from(table).upsert(rows, opts)
  if (error) { console.error(`  ${table}: ОШИБКА — ${error.message}`); throw error }
  console.log(`  ${table}: ${rows.length}`)
}

console.log('Миграция в Supabase…')

// 1. Роли
const roles = await readJson('roles.json', [])
await upsert('roles', (Array.isArray(roles) ? roles : []).map((r) => ({
  id: r.id, name: r.name, permissions: r.permissions || {}, builtin: !!r.builtin,
})), { onConflict: 'id' })

// 2. Пользователи (до баланса/подписок — FK)
const users = await readJson('users.json', [])
const userIds = new Set((Array.isArray(users) ? users : []).map((u) => u.id))
await upsert('users', (Array.isArray(users) ? users : []).map((u) => ({
  id: u.id, email: u.email, name: u.name || '', password_hash: u.passwordHash || null,
  role_ids: u.roleIds || (u.roleId ? [u.roleId] : []), active: u.active !== false,
  parent_id: u.parentId || null, created_at: ts(u.createdAt), updated_at: ts(u.updatedAt),
})), { onConflict: 'id' })

// 3. Баланс + подписки (из balance.json)
const balance = await readJson('balance.json', {})
const coinRows = []
const subRows = []
for (const [k, v] of Object.entries(balance || {})) {
  if (k === '__subscription') {
    subRows.push({ id: 'workspace', scope: 'workspace', user_id: null, modules: v.modules ?? 'all', expires_at: ts(v.expiresAt), updated_at: ts(v.updatedAt) })
    continue
  }
  if (k === '__default') continue
  if (!userIds.has(k)) continue // FK: только существующие пользователи
  if (typeof v.coins === 'number') coinRows.push({ user_id: k, coins: v.coins, updated_at: ts(v.updatedAt) })
  if (v.modules !== undefined) subRows.push({ id: k, scope: 'user', user_id: k, modules: v.modules, expires_at: ts(v.expiresAt), updated_at: ts(v.updatedAt) })
}
await upsert('coin_balance', coinRows, { onConflict: 'user_id' })
await upsert('subscriptions', subRows, { onConflict: 'id' })

// 4. Переопределения цен (одна строка)
const prices = await readJson('prices.json', null)
if (prices && Object.keys(prices).length) {
  await upsert('price_overrides', [{
    id: 'default', modules: prices.modules || {}, annual_discount: prices.annualDiscount ?? null,
    coins_per_1k_tokens: prices.coinsPer1kTokens ?? null, token_usd: prices.tokenUsd ?? null,
    image_multiplier: prices.imageMultiplier ?? null, coin_packs: prices.coinPacks ?? null,
  }], { onConflict: 'id' })
} else { console.log('  price_overrides: 0 (дефолты в коде)') }

// 5. Наборы
const bundles = await readJson('bundles.json', [])
await upsert('bundles', (Array.isArray(bundles) ? bundles : []).map((b) => ({
  id: b.id, name: b.name, hint: b.hint || '', modules: b.modules || [], price: b.price, created_at: ts(b.createdAt),
})), { onConflict: 'id' })

// 6. API-ключи (значение → хэш; полного значения в БД не храним)
const apiKeys = await readJson('api-keys.json', [])
await upsert('api_keys', (Array.isArray(apiKeys) ? apiKeys : []).map((k) => ({
  id: k.id, name: k.name, key_hash: crypto.createHash('sha256').update(String(k.key || '')).digest('hex'),
  prefix: k.prefix, owner_id: userIds.has(k.ownerId) ? k.ownerId : null,
  created_at: ts(k.createdAt), last_used_at: ts(k.lastUsedAt), revoked: !!k.revoked,
})), { onConflict: 'id' })

// 7. Ядро: цели / кампании / лиды
const goals = await readJson('goals.json', [])
await upsert('goals', (Array.isArray(goals) ? goals : []).map((g) => {
  const { id, name, createdAt, updatedAt, ...rest } = g
  return { id, name: name || '', data: rest, created_at: ts(createdAt), updated_at: ts(updatedAt) }
}), { onConflict: 'id' })

const campaignsRaw = await readJson('campaigns.json', [])
const campaigns = Array.isArray(campaignsRaw) ? campaignsRaw : (campaignsRaw.campaigns || [])
await upsert('campaigns', campaigns.map((c) => {
  const { id, name, goalId, modules, createdAt, updatedAt, ...rest } = c
  return { id, name: name || '', goal_id: goalId || null, modules: modules || [], data: rest, created_at: ts(createdAt), updated_at: ts(updatedAt) }
}), { onConflict: 'id' })

const leadsRaw = await readJson('leads.json', [])
const leads = Array.isArray(leadsRaw) ? leadsRaw : (leadsRaw.leads || [])
await upsert('leads', leads.map((l) => ({
  id: l.id, goal_id: l.goalId || null, account_id: l.accountId || null, peer: l.peer || null,
  status: l.status || 'cold', is_hot: !!l.isHot, result: l.result || '', note: l.note || '',
  created_at: ts(l.createdAt), updated_at: ts(l.updatedAt),
})), { onConflict: 'id' })

// 8. Аккаунты (мета)
const meta = await readJson('accounts-meta.json', {})
await upsert('accounts_meta', Object.entries(meta || {}).map(([id, m]) => ({
  id, name: m.name || null, username: m.username || null, phone: m.phone || null,
  status: m.status || null, proxy: m.proxy || null, country: m.country || null,
  in_trash: !!m.inTrash, data: m, updated_at: ts(m.updatedAt),
})), { onConflict: 'id' })

// 9. Журналы денег (append-only — вставляем, дубли по id идентити не грозят)
const wallet = await readJsonl('wallet-log.jsonl')
if (wallet.length) {
  const { error } = await db.from('wallet_log').insert(wallet.map((w) => ({
    ts: ts(w.ts), user_id: w.userId || null, amount: w.amount, before_val: w.before ?? null, after_val: w.after ?? null, reason: w.reason || null,
  })))
  console.log(`  wallet_log: ${error ? 'ОШИБКА ' + error.message : wallet.length}`)
}
const ledger = await readJsonl('token-ledger.jsonl')
if (ledger.length) {
  const { error } = await db.from('token_ledger').insert(ledger.map((e) => ({
    ts: ts(e.ts), user_id: e.userId || null, module: e.module || null, account_id: e.accountId || null,
    task_id: e.taskId || null, campaign_id: e.campaignId || null, model: e.model || null,
    tokens: e.tokens || 0, prompt_tokens: e.promptTokens || 0, completion_tokens: e.completionTokens || 0, coins: e.coins || 0,
  })))
  console.log(`  token_ledger: ${error ? 'ОШИБКА ' + error.message : ledger.length}`)
}

console.log('Готово.')
