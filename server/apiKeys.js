/**
 * §10.3: закрытые API-ключи для внешнего AI-оркестратора («мозги»).
 *
 * Ключом внешний AI создаёт цели/кампании/задачи и спрашивает, что умеет модуль.
 * Хранение — data/api-keys.json. Ключ показывается ОДИН раз при создании; дальше
 * в списке только префикс (как у Stripe/GitHub), чтобы утёкший список не отдал
 * рабочие ключи. Проверка — по полному значению из заголовка Authorization.
 *
 * Демо-упрощение: полное значение лежит в файле рядом (для сверки). Продакшн-шаг —
 * хранить только хэш и сверять хэшем; интерфейс (issue/verify/revoke) не изменится.
 */
import crypto from 'node:crypto'
import { dataPath, readJson, mutateJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'

const KEYS_FILE = () => process.env.API_KEYS_FILE || dataPath('api-keys.json')

/** Префикс — чтобы ключ узнавался в логах и не путался с чужими токенами. */
const PREFIX = 'aii_live_sk_'

function sb() { return supabaseEnabled() ? getSupabase() : null }
const hash = (v) => crypto.createHash('sha256').update(String(v || '')).digest('hex')

/** @returns {Promise<Array<object>>} */
export async function listKeys() {
  const db = sb()
  if (db) {
    const { data } = await db.from('api_keys').select('id, name, prefix, account_id, created_at, last_used_at, revoked').order('created_at', { ascending: false })
    return (data || []).map((k) => ({
      id: k.id, name: k.name, prefix: k.prefix, accountId: k.account_id || '',
      createdAt: k.created_at ? new Date(k.created_at).getTime() : 0,
      lastUsedAt: k.last_used_at ? new Date(k.last_used_at).getTime() : 0, revoked: !!k.revoked,
    }))
  }
  const raw = await readJson(KEYS_FILE(), [])
  const arr = Array.isArray(raw) ? raw : []
  // Наружу — без секрета: только префикс для узнавания + к какому аккаунту привязан.
  return arr.map((k) => ({
    id: k.id, name: k.name, prefix: k.prefix, accountId: k.accountId || '', createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt || 0, revoked: !!k.revoked,
  }))
}

/**
 * Выпустить ключ. Возвращает ПОЛНОЕ значение — единственный раз, дальше его нет.
 * @param {{name?:string, ownerId?:string}} input
 */
export async function issueKey(input = {}) {
  const name = String(input.name || '').trim() || 'API-ключ'
  // Ключ генерируется ПОД ОДИН аккаунт (решение заказчика): «мозги» работают только
  // с ним. Без аккаунта ключ выпускать нельзя — иначе он «висит в пустоте».
  const accountId = String(input.accountId || '').trim()
  if (!accountId) throw new Error('Ключ выпускается под конкретный аккаунт — выберите аккаунт')
  const secret = PREFIX + crypto.randomBytes(24).toString('hex')
  const rec = {
    id: `key_${crypto.randomUUID().slice(0, 8)}`,
    name,
    key: secret,
    prefix: secret.slice(0, PREFIX.length + 6) + '…',
    ownerId: input.ownerId || '',
    accountId,
    createdAt: Date.now(),
    lastUsedAt: 0,
    revoked: false,
  }
  const db = sb()
  if (db) {
    // В БД храним ХЭШ, не значение: утёкшая таблица не отдаёт рабочие ключи.
    await db.from('api_keys').insert({
      id: rec.id, name: rec.name, key_hash: hash(secret), prefix: rec.prefix,
      owner_id: rec.ownerId || null, account_id: accountId,
      created_at: new Date(rec.createdAt).toISOString(), revoked: false,
    })
    return { id: rec.id, name: rec.name, key: secret, prefix: rec.prefix, accountId, createdAt: rec.createdAt }
  }
  await mutateJson(KEYS_FILE(), (raw) => {
    const arr = Array.isArray(raw) ? raw : []
    return [rec, ...arr]
  }, [])
  return { id: rec.id, name: rec.name, key: secret, prefix: rec.prefix, accountId, createdAt: rec.createdAt }
}

/** Отозвать ключ (мягко: помечаем revoked, чтобы аудит помнил, что он был). */
export async function revokeKey(id) {
  const db = sb()
  if (db) {
    const { data } = await db.from('api_keys').update({ revoked: true }).eq('id', id).select('id')
    return !!(data && data.length)
  }
  let found = false
  await mutateJson(KEYS_FILE(), (raw) => {
    const arr = Array.isArray(raw) ? raw : []
    return arr.map((k) => {
      if (k.id === id) { found = true; return { ...k, revoked: true } }
      return k
    })
  }, [])
  return found
}

/**
 * Проверить ключ из заголовка. Возвращает запись или null. Обновляет lastUsedAt.
 * @param {string} raw значение Authorization (с «Bearer » или без)
 */
export async function verifyKey(raw) {
  const token = String(raw || '').replace(/^Bearer\s+/i, '').trim()
  if (!token.startsWith(PREFIX)) return null
  const db = sb()
  if (db) {
    const { data: rec } = await db.from('api_keys').select('id, name, owner_id, account_id').eq('key_hash', hash(token)).eq('revoked', false).maybeSingle()
    if (!rec) return null
    db.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', rec.id).then(() => {}, () => {})
    return { id: rec.id, name: rec.name, ownerId: rec.owner_id || '', accountId: rec.account_id || '' }
  }
  const arr = await readJson(KEYS_FILE(), [])
  const rec = (Array.isArray(arr) ? arr : []).find((k) => k.key === token && !k.revoked)
  if (!rec) return null
  // Отметку «последнее использование» пишем best-effort, не роняя запрос.
  mutateJson(KEYS_FILE(), (r) => (Array.isArray(r) ? r : []).map((k) => (k.id === rec.id ? { ...k, lastUsedAt: Date.now() } : k)), []).catch(() => {})
  return { id: rec.id, name: rec.name, ownerId: rec.ownerId, accountId: rec.accountId || '' }
}

/**
 * Express-middleware: пускает только с валидным ключом. Кладёт req.apiKey.
 * Отдельный слой от сессионного x-user-id: «мозги» ходят ключом, а не логином.
 */
export function requireApiKey() {
  return async (req, res, next) => {
    const key = await verifyKey(req.header('authorization'))
    if (!key) return res.status(401).json({ ok: false, error: 'Нужен действующий API-ключ (Authorization: Bearer …)' })
    req.apiKey = key
    next()
  }
}
