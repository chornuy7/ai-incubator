import fs from 'fs/promises'
import path from 'path'
import { mutateJson } from './lib/jsonStore.js'
import { SESSIONS_DIR } from './config.js'
import { buildStatusPatch, normalizeStatus, nextStatusAfterExpiry, canModuleUseAccount } from './lib/accountStatus.js'
import { appendAudit } from './lib/auditLog.js'
import { getTrustCache } from './lib/trustCache.js'

// Боевые модули с реальными рискованными действиями — сюда не пускаем аккаунты с trust<40
// (§6: авто-стоп → прогрев). Прогрев/парсинг/просмотр/автопостинг в своих каналах — не гейтим.
const TRUST_GATED_MODULES = new Set(['neuro-commenting', 'neuro-chatting', 'neuro-dialogs', 'mass-react', 'mailing'])
const TRUST_MIN = 40

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

export async function getAccountMeta(accountId) {
  const all = await loadAllMeta()
  return { ...DEFAULT_META, ...(all[accountId] || {}) }
}

/**
 * ВАЖНО: запись идёт через mutateJson — он сериализует операции над файлом.
 * Раньше здесь было read-modify-write с await посередине: при параллельных задачах
 * (а их может быть десяток) потоки читали файл, правили СВОЙ аккаунт и переписывали
 * файл ЦЕЛИКОМ. Последний писавший затирал чужие правки — так были потеряны прокси,
 * отпечатки и облачные пароли у 37 аккаунтов.
 */
export async function setAccountMeta(accountId, patch) {
  let result = null
  await mutateJson(META_FILE, (all) => {
    const next = all && typeof all === 'object' ? all : {}
    next[accountId] = {
      ...DEFAULT_META,
      ...(next[accountId] || {}),
      ...patch,
      updatedAt: Date.now(),
    }
    if (!next[accountId].createdAt) next[accountId].createdAt = Date.now()
    result = next[accountId]
    return next
  }, {})
  return result
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
  // Аудит best-effort: его сбой не должен откатывать уже сохранённый статус, но и не молчит (§5.2).
  try {
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
  } catch (err) {
    console.warn(`[audit] не удалось записать account.status.change (${from}→${patch.status}):`, err?.message || err)
  }
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
  /** @type {string[]} */
  const lowTrust = []
  /** @type {string[]} Профили без посчитанного trust — их тоже не пускаем (§6). */
  const noTrust = []
  const gated = TRUST_GATED_MODULES.has(moduleKey)
  for (const id of accountIds) {
    const status = normalizeStatus((all[id] || {}).status)
    if (!canModuleUseAccount(moduleKey, status)) { blocked.push(`${String(id).slice(-6)} (${status})`); continue }
    if (gated) {
      // Кэшированный trust. РАНЬШЕ здесь был fail-open: «если ни разу не считался —
      // не блокируем». Но именно свежедобавленный аккаунт §6 и должен останавливать:
      // у него нет ни истории, ни отлёжки, он максимально уязвим к спам-блоку, а гейт
      // защищал только тех, кто уже поработал и получил оценку (прогон 21–22.07,
      // тест 12.6: удалили запись из кэша — аккаунт спокойно ушёл в боевой модуль).
      // Теперь нет оценки — сначала прогрев.
      const t = await getTrustCache(id)
      if (!t) noTrust.push(String(id).slice(-6))
      else if (Number(t.score) < TRUST_MIN) lowTrust.push(`${String(id).slice(-6)} (trust ${t.score})`)
    }
  }
  if (blocked.length) return `Нельзя назначить профили в статусе, недоступном для модуля: ${blocked.join(', ')}. Дождитесь выхода из прогрева/карантина или выберите другие.`
  if (lowTrust.length) return `Профили с trust<${TRUST_MIN} нельзя брать в боевой модуль (§6, авто-стоп → прогрев): ${lowTrust.join(', ')}. Отправьте их на прогрев или выберите другие.`
  if (noTrust.length) return `У профилей ещё не посчитан trust — в боевой модуль их пускать рано (§6): ${noTrust.join(', ')}. Отправьте на прогрев: балл появится после первых действий.`
  return null
}

export async function deleteAccountMeta(accountId) {
  // Тоже через mutateJson — иначе удаление одного аккаунта могло затереть правки соседних.
  await mutateJson(META_FILE, (all) => {
    const next = all && typeof all === 'object' ? all : {}
    delete next[accountId]
    return next
  }, {})
}

export function countryFromPhone(phone) {
  const p = (phone || '').replace(/\D/g, '')
  // GEO-модель Европа+Украина/СНГ (§8.3). Порядок важен: длинные префиксы — раньше.
  if (p.startsWith('380')) return 'ua'
  if (p.startsWith('420')) return 'cz'
  if (p.startsWith('77') || p.startsWith('76')) return 'kz' // Казахстан — до кода России (7)
  if (p.startsWith('7')) return 'ru'
  if (p.startsWith('48')) return 'pl'
  if (p.startsWith('49')) return 'de'
  if (p.startsWith('44')) return 'gb'
  if (p.startsWith('33')) return 'fr'
  if (p.startsWith('34')) return 'es'
  if (p.startsWith('39')) return 'it'
  if (p.startsWith('31')) return 'nl'
  if (p.startsWith('40')) return 'ro'
  if (p.startsWith('370')) return 'lt'
  if (p.startsWith('371')) return 'lv'
  // США/Канада: по префиксу их не различить (общий план нумерации), пишем us — их подавляющее
  // большинство. Без этой строки американские номера молча становились украинскими.
  if (p.startsWith('1')) return 'us'
  if (p.startsWith('90')) return 'tr'
  if (p.startsWith('91')) return 'in'
  if (p.startsWith('62')) return 'id'
  if (p.startsWith('55')) return 'br'
  if (p.startsWith('998')) return 'uz'
  if (p.startsWith('995')) return 'ge'
  if (p.startsWith('374')) return 'am'
  // Неизвестный префикс — честное «не знаю». Раньше здесь стояло 'ua', и любой
  // нераспознанный номер выдавал себя за украинский.
  return ''
}

export function avatarColor(accountId) {
  const palette = ['#0ec464', '#7145ff', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899']
  let h = 0
  for (let i = 0; i < accountId.length; i++) h = (h * 31 + accountId.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}
