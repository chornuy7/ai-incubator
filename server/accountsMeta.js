import fs from 'fs/promises'
import path from 'path'
import { mutateJson } from './lib/jsonStore.js'
import { getSupabase, supabaseEnabled } from './lib/supabase.js'
import { decryptSecret, secretForStorage } from './lib/secretBox.js'
import { withProxyStrings } from './lib/proxyLink.js'
import { SESSIONS_DIR } from './config.js'

function sbA() { return supabaseEnabled() ? getSupabase() : null }

/*
 * MR-290: облачный пароль (2FA) больше не лежит в jsonb.
 *
 * Он уехал в отдельную колонку `two_fa_enc` и шифруется приложением
 * (server/lib/secretBox.js). Причина не в красоте: `loadAllMeta` читает `data` целиком,
 * и пока пароль был внутри, каждый список аккаунтов тянул 47 паролей открытым текстом
 * через сеть и держал их в памяти процесса — при том, что нужен из них ровно один бит
 * «пароль есть».
 *
 * Поэтому наружу из меты отдаётся только `has2fa`. Сам пароль достаётся ЯВНЫМ вызовом
 * `getAccountTwoFa(id)` — так видно в коде, кто и зачем его берёт.
 */
const stripSecrets = (m) => { const { twoFA: _secret, ...rest } = m || {}; return rest }

/**
 * MR-290: карта «поле меты → колонка таблицы».
 *
 * Раньше вся мета лежала одним jsonb, а типизированные колонки рядом заполнялись «для
 * запросов» и не читались никем: `loadAllMeta` брал только `data`. Из-за этого типы
 * стояли, но не работали — `userId` хранился то числом, то строкой, девять моментов
 * времени лежали числом epoch внутри json, а колонка владельца `user_id` с внешним ключом
 * была ПУСТА на всех 63 строках, пока доступ резался по `data.ownerId`.
 *
 * Отображение объявлено списком, а не расписано вручную в двух функциях: две руками
 * написанные таблицы соответствия однажды разойдутся, и поле начнёт теряться при
 * сохранении. Тест сверяет этот список с миграцией.
 *
 * Типы: `text` | `ts` (в мете — epoch-мс, в базе — timestamptz) | `bool` (может быть
 * неизвестен) | `flag` (всегда true/false) | `num`.
 */
const COLUMNS = [
  ['name',            'name',              'text'],
  ['username',        'username',          'text'],
  ['phone',           'phone',             'text'],
  ['status',          'status',            'text'],
  ['country',         'country',           'text'],
  // Прокси — ССЫЛКОЙ. Строка подключения (`meta.proxy`) производная: её собирают из
  // строки каталога при чтении, а в базу она не попадает вовсе. Хранили и то, и другое —
  // и связь потерялась: у 55 аккаунтов остался proxyId, а строка подключения обнулилась,
  // из-за чего все они ходили в Telegram напрямую с адреса сервера (MR-290/MR-262).
  ['proxyId',         'proxy_id',          'text'],
  ['ownerId',         'user_id',           'text'],
  ['inTrash',         'in_trash',          'flag'],
  ['createdAt',       'created_at',        'ts'],
  ['userId',          'tg_user_id',        'text'],
  ['role',            'role',              'text'],
  ['project',         'project',           'text'],
  ['note',            'note',              'text'],
  ['avatarColor',     'avatar_color',      'text'],
  ['service',         'is_service',        'flag'],
  ['platform',        'is_platform',       'flag'],
  ['statusSince',     'status_since',      'ts'],
  ['statusUntil',     'status_until',      'ts'],
  ['statusReason',    'status_reason',     'text'],
  ['statusCode',      'status_code',       'text'],
  ['statusBy',        'status_by',         'text'],
  ['prevStatus',      'prev_status',       'text'],
  ['statusBefore',    'status_before',     'text'],
  ['healthCheckedAt', 'health_checked_at', 'ts'],
  ['healthError',     'health_error',      'text'],
  ['lastValid',       'last_valid',        'bool'],
  ['lastValidAt',     'last_valid_at',     'ts'],
  ['lastCheckedAt',   'last_checked_at',   'ts'],
  ['lastCheckOk',     'last_check_ok',     'bool'],
  ['spamblock',       'spamblock',         'text'],
  ['spamblockAt',     'spamblock_at',      'ts'],
  ['spamblockText',   'spamblock_text',    'text'],
  ['ggrScore',        'ggr_score',         'num'],
]

/*
 * Те же поля ВРЕМЕННО остаются и в jsonb.
 *
 * Миграции применяются до выката кода: между ними на сервере работает предыдущая версия,
 * которая читает мету из `data`. Перестань писать туда сразу — и на эти минуты у
 * аккаунтов пропадут статусы, имена и владельцы. Дубль снимается ОДНОЙ СТРОКОЙ здесь,
 * следующим релизом, вместе с миграцией, вычищающей ключи из `data`.
 */
const KEEP_LEGACY_JSON_KEYS = true

/** Значение меты → значение колонки. `null` означает «пусто», а не «не трогать». */
function toCol(v, type) {
  if (type === 'flag') return !!v
  if (v === undefined || v === null || v === '') return null
  if (type === 'ts') { const t = Number(v); return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null }
  if (type === 'bool') return !!v
  if (type === 'num') { const n = Number(v); return Number.isFinite(n) ? n : null }
  return String(v)
}

/** Значение колонки → значение меты. `undefined` означает «в колонке пусто». */
function fromCol(v, type) {
  if (v === undefined || v === null) return undefined
  if (type === 'ts') { const t = new Date(v).getTime(); return Number.isFinite(t) ? t : undefined }
  if (type === 'bool' || type === 'flag') return !!v
  if (type === 'num') { const n = Number(v); return Number.isFinite(n) ? n : undefined }
  return String(v)
}

/**
 * Строка таблицы из объекта меты.
 * @param {string} id @param {object} m
 * @param {string|null|undefined} twoFaEnc готовый шифротекст; undefined — не трогать колонку
 */
function metaToRow(id, m, twoFaEnc) {
  const rest = stripSecrets({ ...m })
  const row = { id }
  for (const [json, col, type] of COLUMNS) {
    row[col] = toCol(rest[json], type)
    if (!KEEP_LEGACY_JSON_KEYS) delete rest[json]
  }
  // Производные значения в базу не едут: `has2fa` считается при чтении, а `proxy` —
  // строка подключения, собранная из каталога. Записать её значит снова завести второй
  // источник связи с прокси, который однажды разойдётся со ссылкой.
  delete rest.has2fa
  delete rest.proxy
  /*
   * Колонка `proxy` ПУСТЕЕТ, как только есть ссылка (MR-262).
   *
   * Раньше здесь её просто не трогали, и прежняя строка подключения оставалась в базе
   * навсегда. В окно выката её читает предыдущая версия — то есть показывает и использует
   * прокси, который аккаунту уже не назначен. Колонка сносится следующим выпуском, но до
   * тех пор обязана быть согласована со ссылкой.
   */
  row.proxy = m.proxyId ? null : (m.proxy || null)
  row.data = rest
  row.updated_at = new Date(m.updatedAt || Date.now()).toISOString()
  if (twoFaEnc !== undefined) row.two_fa_enc = twoFaEnc
  return row
}

/**
 * Подставить строку подключения к прокси всем, у кого есть ссылка.
 *
 * Делается ОДНИМ проходом по каталогу на всю выборку, а не по запросу на аккаунт. Каталог
 * прокси кэшируется на секунды в самом proxies.js, поэтому список аккаунтов (горячий путь)
 * не превращается в сотню обращений.
 *
 * Импорт динамический: proxies.js — сосед по слою, и статическая ссылка отсюда завела бы
 * цикл, как только каталогу понадобится что-то из меты.
 * @param {Record<string, {proxyId?: string, proxy?: string}>} metas
 */
/**
 * MR-262 (вобрано в MR-290): строка подключения — ПРОИЗВОДНАЯ, и хранить её нельзя.
 *
 * Здесь была своя сборка строки, и в ней была ошибка: у аккаунта, чей прокси удалили из
 * каталога, строка обнулялась — то есть аккаунт молча уходил в Telegram напрямую с адреса
 * сервера. Заметно такое только по банам. Помощник из MR-262 в этом случае оставляет
 * прежнюю строку и ставит признак `proxyGone`, чтобы витрина сказала об этом словами.
 *
 * Он же применяется в ОБОИХ режимах, а не только в базе: в файловом аккаунт со ссылкой
 * тоже должен получать строку подключения.
 */
function безПроизводной(meta) {
  // Есть ключ — строки в записи нет: копия протухнет при первой же смене пароля в
  // каталоге, а это ровно та болезнь, от которой уходим.
  if (!meta || !meta.proxyId) return meta
  const { proxy, ...остальное } = meta
  void proxy
  return остальное
}

/** Строка таблицы → объект меты. Колонка сильнее json: она теперь источник правды. */
function rowToMeta(r) {
  const m = stripSecrets({ ...(r.data || {}) })
  for (const [json, col, type] of COLUMNS) {
    const v = fromCol(r[col], type)
    if (v !== undefined) m[json] = v
  }
  m.has2fa = !!(r.two_fa_enc || r.data?.twoFA)
  return m
}
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

/** Мета как она лежит в хранилище — без собранных строк подключения. */
async function loadAllMetaRaw() {
  const db = sbA()
  if (db) {
    // `*` вместо `id, data`: мета теперь собирается из колонок, а не из одного jsonb.
    // Пароль при этом НЕ расшифровывается — списку нужен один бит, а не 47 паролей в
    // памяти (см. rowToMeta: наружу идёт только has2fa).
    const { data } = await db.from('accounts_meta').select('*')
    const out = {}
    for (const r of data || []) out[r.id] = rowToMeta(r)
    return out
  }
  try {
    const raw = await fs.readFile(metaFile(), 'utf8')
    const all = /** @type {Record<string, object>} */ (JSON.parse(raw))
    // Файловый режим (тесты, локальный запуск) хранит пароль как раньше — там нет ни
    // общей базы, ни бэкапов. Но наружу отдаём тот же признак, чтобы поведение совпадало.
    for (const [id, m] of Object.entries(all || {})) all[id] = { ...stripSecrets(m), has2fa: !!m?.twoFA }
    return all
  } catch {
    return {}
  }
}

/**
 * Облачный пароль аккаунта — ЯВНЫМ вызовом и по одному.
 *
 * Отдельная функция, а не поле в мете: пароль нужен ровно там, где аккаунт
 * реавторизуют, и каждый такой вызов должно быть видно в коде. Пока сессия жива, он не
 * нужен вовсе — и не должен путешествовать вместе со списком аккаунтов.
 * @param {string} accountId @returns {Promise<string|null>}
 */
export async function getAccountTwoFa(accountId) {
  const db = sbA()
  if (db) {
    const { data } = await db.from('accounts_meta').select('two_fa_enc, data').eq('id', accountId).maybeSingle()
    // До перешифровки значение может лежать ещё открытым текстом в data — decryptSecret
    // такое возвращает как есть, поэтому обе дороги ведут в одно место.
    return decryptSecret(data?.two_fa_enc ?? data?.data?.twoFA ?? null)
  }
  const all = await (async () => { try { return JSON.parse(await fs.readFile(metaFile(), 'utf8')) } catch { return {} } })()
  return decryptSecret(all?.[accountId]?.twoFA ?? null)
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

/**
 * Мета одного аккаунта из УЖЕ прочитанной карты — с теми же умолчаниями.
 *
 * Нужна там, где перебирают парк: `getAccountMeta` на каждом шаге цикла читает таблицу
 * целиком (а с MR-262 — ещё и каталог прокси), поэтому на списке из сотни аккаунтов
 * получалось сто чтений всей меты вместо одного. Читаем карту один раз — берём из неё.
 * @param {Record<string, object>} all @param {string} accountId
 */
export function metaOf(all, accountId) {
  return { ...DEFAULT_META, ...(all?.[accountId] || {}) }
}

export async function getAccountMeta(accountId) {
  return metaOf(await loadAllMeta(), accountId)
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
    // Читаем строку ЦЕЛИКОМ: мета собрана из колонок, и слияние по одному только `data`
    // потеряло бы всё, что уже переехало (статус, владельца, даты).
    const { data: row } = await db.from('accounts_meta').select('*').eq('id', accountId).maybeSingle()
    const cur = row ? rowToMeta(row) : {}
    const merged = безПроизводной({ ...DEFAULT_META, ...stripSecrets(cur), ...stripSecrets(patch), updatedAt: Date.now() })
    if (!merged.createdAt) merged.createdAt = Date.now()
    /*
     * Секрет трогаем ТОЛЬКО когда он пришёл в patch.
     *
     * metaToRow собирает строку целиком, и если бы колонка попадала в неё всегда, то
     * любое сохранение статуса затирало бы пароль пустым значением. Ровно так уже
     * теряли пароли раньше (см. комментарий выше про read-modify-write), только тогда
     * через файл. `undefined` означает «в запрос колонку не класть» — при upsert
     * PostgREST не трогает то, чего в теле нет.
     */
    const twoFaEnc = patch && Object.hasOwn(patch, 'twoFA')
      ? secretForStorage(patch.twoFA, true)
      : undefined
    await db.from('accounts_meta').upsert(metaToRow(accountId, merged, twoFaEnc), { onConflict: 'id' })
    // Признак берём из уже прочитанной меты (`cur.has2fa`), а не из `cur.twoFA`: пароля в
    // объекте меты больше нет, и обращение к нему молча вернуло бы undefined.
    return { ...merged, has2fa: twoFaEnc === undefined ? !!cur.has2fa : !!twoFaEnc }
  }
  let result = null
  await mutateJson(metaFile(), (all) => {
    const next = all && typeof all === 'object' ? all : {}
    next[accountId] = безПроизводной({
      ...DEFAULT_META,
      ...(next[accountId] || {}),
      ...patch,
      updatedAt: Date.now(),
    })
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
