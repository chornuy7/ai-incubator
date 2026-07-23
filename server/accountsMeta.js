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

/**
 * Путь к метаданным — лениво и с возможностью подмены.
 *
 * Вычисление при импорте не давало изолировать тесты: подменить файл после того,
 * как модуль подтянулся по цепочке импортов, было уже нельзя, и тест писал в боевые
 * данные (так уже случилось с целями).
 */
const metaFile = () => process.env.ACCOUNTS_META_FILE || path.join(path.dirname(SESSIONS_DIR), 'accounts-meta.json')

const DEFAULT_META = {
  role: 'Резерв',
  project: 'incubator_ai',
  country: 'ua',
  status: 'active',
  inTrash: false,
}

export async function loadAllMeta() {
  try {
    const raw = await fs.readFile(metaFile(), 'utf8')
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
  await mutateJson(metaFile(), (all) => {
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
  await backfillMissingStatusUntil(now)
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

/** Сколько держится временный статус, если срок не был проставлен (часы). */
const DEFAULT_HOLD_HOURS = { spamblock: 24, quarantine: 24, floodwait: 1 }

/**
 * Долечить аккаунты, попавшие во временный статус ДО того, как мы начали писать срок.
 *
 * Такие висят вечно: reconciler снимает статус по `statusUntil`, а его нет — и аккаунт
 * навсегда выпадает из работы. Ровно это случилось с 20 аккаунтами в прогоне 21–22.07.
 * Срок отсчитываем от момента постановки статуса, а не от «сейчас», — иначе каждый
 * рестарт продлевал бы наказание заново.
 * @param {number} [now] @returns {Promise<number>} скольким проставили срок
 */
export async function backfillMissingStatusUntil(now = Date.now()) {
  const all = await loadAllMeta()
  let fixed = 0
  for (const [accountId, meta] of Object.entries(all)) {
    const hours = DEFAULT_HOLD_HOURS[normalizeStatus(meta?.status)]
    if (!hours || typeof meta?.statusUntil === 'number') continue
    const since = typeof meta?.statusSince === 'number' ? meta.statusSince : now
    await setAccountMeta(accountId, { statusUntil: since + hours * 3600 * 1000 })
    fixed += 1
  }
  return fixed
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
  return (await checkAccountsAssignable(accountIds, moduleKey)).error
}

/**
 * Тот же guard, но с разбором: КТО именно не проходит и что останется, если их убрать.
 *
 * Раньше наружу отдавался только текст ошибки, и один аккаунт в карантине валил весь
 * запуск: человек шёл в менеджер, искал виноватого, правил набор, возвращался. При
 * трёх десятках аккаунтов, часть которых постоянно в спамблоке, это тупик — поэтому
 * теперь можно предложить «исключить недоступные и запустить на оставшихся».
 *
 * @param {string[]} accountIds
 * @param {string} moduleKey
 * @returns {Promise<{ error: string|null, blocked: {id:string,status:string,reason:string}[], usable: string[] }>}
 */
export async function checkAccountsAssignable(accountIds, moduleKey) {
  if (!accountIds?.length) return { error: null, blocked: [], usable: [] }
  const all = await loadAllMeta()
  /** @type {{id:string,status:string,reason:string}[]} */
  const blocked = []
  /** @type {string[]} */
  const usable = []
  const gated = TRUST_GATED_MODULES.has(moduleKey)
  for (const id of accountIds) {
    const status = normalizeStatus((all[id] || {}).status)
    if (!canModuleUseAccount(moduleKey, status)) {
      blocked.push({ id, status, reason: 'статус' })
      continue
    }
    if (gated) {
      // Кэшированный trust. РАНЬШЕ здесь был fail-open: «если ни разу не считался —
      // не блокируем». Но именно свежедобавленный аккаунт §6 и должен останавливать:
      // у него нет ни истории, ни отлёжки, он максимально уязвим к спам-блоку, а гейт
      // защищал только тех, кто уже поработал и получил оценку (прогон 21–22.07,
      // тест 12.6: удалили запись из кэша — аккаунт спокойно ушёл в боевой модуль).
      // Теперь нет оценки — сначала прогрев.
      const t = await getTrustCache(id)
      // Fail-closed: нет оценки ИЛИ ниже порога — не пускаем (тест 12.6). Свежий
      // аккаунт без истории максимально уязвим, гейт должен его останавливать.
      if (!t || Number(t.score) < TRUST_MIN) {
        blocked.push({ id, status, reason: t ? `trust ${t.score}` : 'нет trust' })
        continue
      }
    }
    usable.push(id)
  }
  if (!blocked.length) return { error: null, blocked: [], usable }
  const byStatus = blocked.filter((b) => b.reason === 'статус')
  const byLowTrust = blocked.filter((b) => b.reason.startsWith('trust'))
  const byNoTrust = blocked.filter((b) => b.reason === 'нет trust')
  const parts = []
  if (byStatus.length) parts.push(`недоступны по статусу: ${byStatus.map((b) => `${String(b.id).slice(-6)} (${b.status})`).join(', ')}`)
  if (byLowTrust.length) parts.push(`ниже порога trust<${TRUST_MIN}: ${byLowTrust.map((b) => `${String(b.id).slice(-6)} (${b.reason})`).join(', ')}`)
  if (byNoTrust.length) parts.push(`ещё не посчитан trust — в боевой модуль рано: ${byNoTrust.map((b) => String(b.id).slice(-6)).join(', ')}`)
  return {
    error: `Часть профилей запустить нельзя — ${parts.join('; ')}.`,
    blocked,
    usable,
  }
}

export async function deleteAccountMeta(accountId) {
  // Тоже через mutateJson — иначе удаление одного аккаунта могло затереть правки соседних.
  await mutateJson(metaFile(), (all) => {
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
