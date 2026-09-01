import fs from 'fs/promises'
import path from 'path'
import { mutateJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'
import { SESSIONS_DIR } from './config.js'

function sbA() { return supabaseEnabled() ? getSupabase() : null }
// Полный объект меты живёт в data-jsonb; индексируемые колонки — для запросов
// (админка «проблемы»: бан/flood/без прокси).
const metaToRow = (id, m) => ({
  id, name: m.name || null, username: m.username || null, phone: m.phone || null,
  status: m.status || null, proxy: m.proxy || null, country: m.country || null,
  // MR-262: ССЫЛКА на строку каталога — источник истины. Колонка `proxy` рядом осталась
  // производной: её читают те, кто ещё работает со строкой подключения.
  proxy_id: m.proxyId || null,
  in_trash: !!m.inTrash, data: m, updated_at: new Date(m.updatedAt || Date.now()).toISOString(),
})
import { buildStatusPatch, normalizeStatus, nextStatusAfterExpiry, canModuleUseAccount } from './lib/accountStatus.js'
import { appendAudit } from './lib/auditLog.js'
import { getTrustCache } from './lib/trustCache.js'
import { withProxyStrings } from './lib/proxyLink.js'

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
  /*
   * Сервисный аккаунт платформы (решение владельца 26.08).
   *
   * Такие клиентам не продаются и не выдаются: ими идёт ревизия сохранённых запросов —
   * фоновое обновление общей базы каналов раз в 12 часов. Отдельный признак, а не роль:
   * роль это подпись для оператора, её меняют свободно, а от этого флага зависит, чьи
   * аккаунты и чьи деньги тратятся.
   */
  service: false,
  /*
   * Аккаунт ПЛАТФОРМЫ, а не клиента (правка 27.08: «только наши, которые мы законектим
   * именно для админ-панели, а не из общей базы чужих телеграм-аккаунтов»).
   *
   * Ставится один раз, при импорте с отметкой «для платформы», и только администратором.
   * Ревизия базы берёт исполнителей ТОЛЬКО отсюда: раньше сервисным можно было отметить
   * любой аккаунт из общего парка, то есть чужой рабочий профиль — а фоновое обновление
   * общей базы идёт по нашей инициативе и должно идти нашими руками.
   */
  platform: false,
}

export async function loadAllMeta() {
  return withProxyStrings(await loadAllMetaRaw())
}

/**
 * Мета КАК ЗАПИСАНА, без пересборки строки прокси.
 *
 * Нужна там, где мету пишут: пересобранная строка — производная, и записывать её обратно
 * значило бы снова размножить копии по аккаунтам (MR-262).
 */
export async function loadAllMetaRaw() {
  const db = sbA()
  if (db) {
    const { data } = await db.from('accounts_meta').select('id, data')
    const out = {}
    for (const r of data || []) out[r.id] = r.data || {}
    return out
  }
  try {
    const raw = await fs.readFile(metaFile(), 'utf8')
    return /** @type {Record<string, object>} */ (JSON.parse(raw))
  } catch {
    return {}
  }
}

/**
 * Подпись аккаунта для логов и таблиц результатов.
 *
 * Прогон 22.08: 48 аккаунтов из 98 импортированы без имени, и лог задачи на семи
 * аккаунтах выглядел как семь строк «—» — кто вступил, кто написал, кого выкинуло,
 * понять нельзя. Имя не всегда есть, но телефон или id есть всегда: безымянных строк
 * в логе быть не должно.
 */
export function accountLabel(meta, accountId) {
  const m = meta || {}
  if (m.name && String(m.name).trim()) return String(m.name).trim()
  if (m.username && String(m.username).trim()) return `@${String(m.username).trim().replace(/^@/, '')}`
  if (m.phone && String(m.phone).trim()) return String(m.phone).trim()
  return `#${String(accountId || '').slice(-6)}`
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
  const db = sbA()
  if (db) {
    const { data: row } = await db.from('accounts_meta').select('data').eq('id', accountId).maybeSingle()
    const cur = row?.data || {}
    const merged = { ...DEFAULT_META, ...cur, ...patch, updatedAt: Date.now() }
    if (!merged.createdAt) merged.createdAt = Date.now()
    await db.from('accounts_meta').upsert(metaToRow(accountId, merged), { onConflict: 'id' })
    return merged
  }
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
    // MR-134: имя аккаунта для понятного сообщения (раньше показывали хвост id вида «_hot_1»).
    const name = (all[id] || {}).name || (all[id] || {}).username || String(id).slice(-6)
    if (!canModuleUseAccount(moduleKey, status)) {
      blocked.push({ id, name, status, reason: 'статус' })
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
        blocked.push({ id, name, status, reason: t ? `trust ${t.score}` : 'нет trust' })
        continue
      }
    }
    usable.push(id)
  }
  if (!blocked.length) return { error: null, blocked: [], usable }
  const byStatus = blocked.filter((b) => b.reason === 'статус')
  const byLowTrust = blocked.filter((b) => b.reason.startsWith('trust'))
  const byNoTrust = blocked.filter((b) => b.reason === 'нет trust')
  // MR-134: человеческий статус вместо кода (reauth → «нужна авторизация» и т.п.).
  const STATUS_RU = { reauth: 'нужна авторизация', invalid: 'невалиден', spamblock: 'спамблок', quarantine: 'карантин', frozen: 'заморожен', floodwait: 'флудвейт', pause: 'на паузе', working: 'занят' }
  const nm = (b) => b.name || String(b.id).slice(-6)
  const parts = []
  if (byStatus.length) parts.push(`недоступны по статусу: ${byStatus.map((b) => `${nm(b)} (${STATUS_RU[b.status] || b.status})`).join(', ')}`)
  if (byLowTrust.length) parts.push(`ниже порога trust<${TRUST_MIN}: ${byLowTrust.map((b) => `${nm(b)} (${b.reason})`).join(', ')}`)
  if (byNoTrust.length) parts.push(`ещё не посчитан trust — в боевой модуль рано: ${byNoTrust.map((b) => nm(b)).join(', ')}`)
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
