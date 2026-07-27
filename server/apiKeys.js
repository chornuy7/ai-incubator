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

const KEYS_FILE = () => process.env.API_KEYS_FILE || dataPath('api-keys.json')

/** Префикс — чтобы ключ узнавался в логах и не путался с чужими токенами. */
const PREFIX = 'aii_live_sk_'

/** @returns {Promise<Array<object>>} */
export async function listKeys() {
  const raw = await readJson(KEYS_FILE(), [])
  const arr = Array.isArray(raw) ? raw : []
  // Наружу — без секрета: только префикс для узнавания.
  return arr.map((k) => ({
    id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt || 0, revoked: !!k.revoked,
  }))
}

/**
 * Выпустить ключ. Возвращает ПОЛНОЕ значение — единственный раз, дальше его нет.
 * @param {{name?:string, ownerId?:string}} input
 */
export async function issueKey(input = {}) {
  const name = String(input.name || '').trim() || 'API-ключ'
  const secret = PREFIX + crypto.randomBytes(24).toString('hex')
  const rec = {
    id: `key_${crypto.randomUUID().slice(0, 8)}`,
    name,
    key: secret,
    prefix: secret.slice(0, PREFIX.length + 6) + '…',
    ownerId: input.ownerId || '',
    createdAt: Date.now(),
    lastUsedAt: 0,
    revoked: false,
  }
  await mutateJson(KEYS_FILE(), (raw) => {
    const arr = Array.isArray(raw) ? raw : []
    return [rec, ...arr]
  }, [])
  return { id: rec.id, name: rec.name, key: secret, prefix: rec.prefix, createdAt: rec.createdAt }
}

/** Отозвать ключ (мягко: помечаем revoked, чтобы аудит помнил, что он был). */
export async function revokeKey(id) {
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
  const arr = await readJson(KEYS_FILE(), [])
  const rec = (Array.isArray(arr) ? arr : []).find((k) => k.key === token && !k.revoked)
  if (!rec) return null
  // Отметку «последнее использование» пишем best-effort, не роняя запрос.
  mutateJson(KEYS_FILE(), (r) => (Array.isArray(r) ? r : []).map((k) => (k.id === rec.id ? { ...k, lastUsedAt: Date.now() } : k)), []).catch(() => {})
  return { id: rec.id, name: rec.name, ownerId: rec.ownerId }
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
