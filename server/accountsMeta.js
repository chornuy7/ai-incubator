import fs from 'fs/promises'
import path from 'path'
import { SESSIONS_DIR } from './config.js'
import { buildStatusPatch, normalizeStatus, nextStatusAfterExpiry, canModuleUseAccount } from './lib/accountStatus.js'
import { appendAudit } from './lib/auditLog.js'

const META_FILE = path.join(path.dirname(SESSIONS_DIR), 'accounts-meta.json')

const DEFAULT_META = {
  role: 'Резерв',
  project: 'incubator_ai',
  country: 'ua',
  status: 'active',
  inTrash: false,
}

export async function loadAllMeta() {
  try {
    const raw = await fs.readFile(META_FILE, 'utf8')
    return /** @type {Record<string, object>} */ (JSON.parse(raw))
  } catch {
    return {}
  }
}

async function saveAllMeta(meta) {
  await fs.mkdir(path.dirname(META_FILE), { recursive: true })
  await fs.writeFile(META_FILE, JSON.stringify(meta, null, 2), 'utf8')
}

export async function getAccountMeta(accountId) {
  const all = await loadAllMeta()
  return { ...DEFAULT_META, ...(all[accountId] || {}) }
}

export async function setAccountMeta(accountId, patch) {
  const all = await loadAllMeta()
  all[accountId] = {
    ...DEFAULT_META,
    ...(all[accountId] || {}),
    ...patch,
    updatedAt: Date.now(),
  }
  if (!all[accountId].createdAt) all[accountId].createdAt = Date.now()
  await saveAllMeta(all)
  return all[accountId]
}

/**
 * Централизованная смена статуса через state machine + запись в аудит (§3.3/§4).
 * Проверяет допустимость перехода (бросает ILLEGAL_TRANSITION), пишет причину/срок/инициатора.
 * Используйте это вместо прямого setAccountMeta({status}) для переходов жизненного цикла.
 * @param {string} accountId
 * @param {string} to  целевой статус (accountStatus.STATUS.*)
 * @param {{ reason?: string, code?: string, until?: number|null, initiator?: string, module?: string, taskId?: string }} [opts]
 */
export async function setAccountStatus(accountId, to, opts = {}) {
  const current = await getAccountMeta(accountId)
  const from = normalizeStatus(current.status)
  const patch = buildStatusPatch(current, to, opts)
  if (patch.status === from) return current // no-op: тот же статус
  const saved = await setAccountMeta(accountId, patch)
  await appendAudit({
    action: 'account.status.change',
    module: opts.module || 'core',
    initiator: opts.initiator || 'system',
    code: patch.statusCode,
    reason: patch.statusReason,
    account: accountId,
    scope: { accounts: [accountId], ...(opts.taskId ? { taskId: opts.taskId } : {}) },
    meta: { from: patch.prevStatus, to: patch.status, until: patch.statusUntil },
  })
  return saved
}

/**
 * Reconciler: вернуть аккаунты, у которых истёк временный статус (floodwait/quarantine),
 * в рабочий/прогревный статус. Вызывать по интервалу и на старте API.
 * Аудит пишется через setAccountStatus. Идемпотентно (нечего — быстрый выход).
 * @param {number} [now]
 * @returns {Promise<{ accountId: string, from: string, to: string }[]>}
 */
export async function reconcileExpiredStatuses(now = Date.now()) {
  const all = await loadAllMeta()
  /** @type {{ accountId: string, from: string, to: string }[]} */
  const flipped = []
  for (const [accountId, meta] of Object.entries(all)) {
    const to = nextStatusAfterExpiry(meta, now)
    if (!to) continue
    const from = normalizeStatus(meta.status)
    try {
      await setAccountStatus(accountId, to, {
        initiator: 'system',
        reason: `Авто-выход из ${from}: срок истёк`,
        code: 'STATUS_EXPIRED',
      })
      flipped.push({ accountId, from, to })
    } catch { /* недопустимый переход — пропускаем */ }
  }
  return flipped
}

/**
 * Guard на границе назначения (§3.2/§3.3): вернуть текст ошибки, если хотя бы один аккаунт
 * нельзя назначить в этот модуль по статусу (прогрев/пауза/карантин/floodwait/…),
 * либо null если все допустимы. Не бросает — по образцу validateSettings.
 * @param {string[]} accountIds
 * @param {string} moduleKey
 * @returns {Promise<string|null>}
 */
export async function assertAccountsAssignable(accountIds, moduleKey) {
  if (!accountIds?.length) return null
  const all = await loadAllMeta()
  /** @type {string[]} */
  const blocked = []
  for (const id of accountIds) {
    const status = normalizeStatus((all[id] || {}).status)
    if (!canModuleUseAccount(moduleKey, status)) blocked.push(`${String(id).slice(-6)} (${status})`)
  }
  if (!blocked.length) return null
  return `Нельзя назначить профили в статусе, недоступном для модуля: ${blocked.join(', ')}. Дождитесь выхода из прогрева/карантина или выберите другие.`
}

export async function deleteAccountMeta(accountId) {
  const all = await loadAllMeta()
  delete all[accountId]
  await saveAllMeta(all)
}

export function countryFromPhone(phone) {
  const p = (phone || '').replace(/\D/g, '')
  if (p.startsWith('380')) return 'ua'
  if (p.startsWith('7')) return 'ru'
  if (p.startsWith('48')) return 'pl'
  if (p.startsWith('49')) return 'de'
  if (p.startsWith('77') || p.startsWith('76')) return 'kz'
  return 'ua'
}

export function avatarColor(accountId) {
  const palette = ['#0ec464', '#7145ff', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899']
  let h = 0
  for (let i = 0; i < accountId.length; i++) h = (h * 31 + accountId.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}
