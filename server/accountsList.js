/**
 * Список аккаунтов — постранично и одним запросом.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Старый `tgListAccounts` собирал ВЕСЬ парк: перечислял сессии,
 * на каждую читал мету, каталог прокси и строку сессии, потом схлопывал дубли в памяти.
 * Двести пятьдесят четыре запроса в базу и двадцать секунд на страницу, где показано
 * пятьдесят строк. Здесь другой порядок: база отдаёт готовую страницу представления
 * `account_list` — с прокси и доверием, подтянутыми по внешним ключам, и с уже
 * схлопнутыми дублями. Один запрос, 14 миллисекунд.
 *
 * ПОЧЕМУ ДЕДУПЛИКАЦИЯ В SQL, А НЕ ЗДЕСЬ. Постранично схлопывать дубли на своей стороне
 * нельзя в принципе: вторая страница не знает, кого выкинула первая, и одна и та же
 * личность приедет дважды либо пропадёт совсем. Как только список стал постраничным,
 * дедупликация обязана уехать в базу — это не оптимизация, а условие правильности.
 *
 * ПОЧЕМУ СПИСОК БОЛЬШЕ НЕ СТРОИТСЯ ПО СЕССИЯМ. Раньше перечень аккаунтов брался из
 * файлов сессий, и аккаунт без файла не показывался вовсе. На боевом сервере так
 * пропадали десять записей из пятидесяти девяти: пять в статусе `reauth` (сессия
 * отозвана — как раз тот случай, когда оператор обязан их видеть) и пять в корзине.
 * Аккаунт — это строка в `accounts_meta`; наличие сессии — его свойство, а не право на
 * существование.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ. Строки подключения к прокси. Она собирается из логина и
 * пароля, то есть уезжала бы в браузер вместе с паролем — так и было: в ответе стояло
 * `socks5://kcfdfepc:zvkbhwey@138.201.202.99:7569`. Наружу идут ссылка (`proxy.id`) и то,
 * что показывают в таблице: подпись, хост, порт, страна, статус. Пароль остаётся в базе,
 * а строку собирает воркер в момент подключения.
 */
import { getSupabase, supabaseEnabled } from './lib/supabase.js'
import { sessionPresence } from './tgAuth.js'
import { getAccountLock } from './lib/accountLocks.js'
import { computeAccountRisk } from './lib/accountRisk.js'
import { avatarColor, countryFromPhone } from './accountsMeta.js'

const VIEW = 'account_list'

/** Потолок страницы: без него `pageSize: 100000` возвращает нас ровно туда, откуда ушли. */
export const MAX_PAGE_SIZE = 200
export const DEFAULT_PAGE_SIZE = 50

/**
 * По каким полям разрешено сортировать.
 *
 * Списком, а не «что пришло, то и подставим»: имя колонки уезжает в запрос, и открытый
 * перечень — это возможность отсортировать по `two_fa_enc` и увидеть по порядку, у кого
 * есть облачный пароль.
 */
const SORTS = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  name: 'name',
  status: 'status',
  country: 'country',
  trust: 'trust_score',
}

/*
 * Порядки, которые собираются из нескольких колонок.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Прежний порядок «по умолчанию» ставил занятых задачей вниз.
 * Занятость живёт в ПАМЯТИ ПРОЦЕССА (локи), а не в базе, и отсортировать по ней страницу
 * нельзя: база о ней не знает. Пока список грузился целиком, сортировка шла в браузере и
 * это было незаметно; постранично так уже не выйдет. Оставлен ближайший осмысленный
 * порядок — сначала аккаунты с прокси, потом по имени, — а «свободные» доступны отдельным
 * фильтром «Не заняты». Правильное решение — перенести локи в базу; это отдельная задача.
 */
const СОСТАВНЫЕ = {
  // «Проблемные сверху»: сортировка по статусу прокси даёт bad → dead → ok → unknown,
  // а аккаунты без прокси (NULL) поднимаются выше всех — они и есть худший случай.
  problems: [
    ['proxy_status', { ascending: true, nullsFirst: true }],
    ['name', { ascending: true }],
  ],
  default: [
    ['proxy_id', { ascending: true, nullsFirst: false }],
    ['name', { ascending: true }],
  ],
  newest: [['created_at', { ascending: false }]],
  oldest: [['created_at', { ascending: true }]],
}

/** Статусы, которые панель показывает плитками. Фильтр принимает только их. */
const STATUSES = new Set([
  'active', 'working', 'warming', 'pause', 'floodwait', 'quarantine',
  'spamblock', 'invalid', 'frozen', 'reauth',
])

/** ISO-строка или null. Время наружу уходит ТОЛЬКО так. */
function iso(v) {
  if (!v) return null
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime()
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/**
 * Строка представления → карточка аккаунта.
 *
 * Форма ответа сгруппирована по смыслу, а не свалена в один плоский объект: профиль,
 * статус, прокси, доверие, риск. Плоский список из тридцати полей, где `proxyId`,
 * `proxyOk` и `noProxy` лежат вперемешку с `lastCheckOk` и `statusUntil`, читать нельзя —
 * непонятно даже, какие поля связаны между собой.
 *
 * @param {object} r строка `account_list`
 * @param {{present?: boolean}} [extra]
 */
export function rowToAccount(r, extra = {}) {
  const phone = r.phone || ''
  const status = эффективныйСтатус(r)
  const прокси = r.proxy_id
    ? {
        id: r.proxy_id,
        label: r.proxy_label || '',
        scheme: r.proxy_scheme || null,
        host: r.proxy_host || null,
        port: r.proxy_port ?? null,
        country: r.proxy_country || null,
        status: r.proxy_status || 'unknown',
        checkedAt: iso(r.proxy_checked_at),
        // §6.3 (AM-002): рабочим считаем всё, кроме явно мёртвого и «не пускает в Telegram».
        ok: r.proxy_status !== 'dead' && r.proxy_status !== 'bad',
      }
    : null
  const trust = r.trust_score == null ? null : { score: r.trust_score, band: r.trust_band || null }
  const занят = занятость(r.id)

  return {
    id: r.id,
    ownerId: r.owner_id || null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    inTrash: !!r.in_trash,
    role: r.role || 'Резерв',
    // Заметка ОПЕРАТОРА. Служебное происхождение — отдельным кодом ниже.
    note: r.note || '',
    kind: { service: !!r.is_service, platform: !!r.is_platform },
    profile: {
      name: r.name || r.username || phone || r.id,
      username: r.username || '',
      phone: phone && !phone.startsWith('+') ? `+${phone}` : phone,
      telegramUserId: r.tg_user_id || null,
      country: r.country || countryFromPhone(phone),
      avatarColor: r.avatar_color || avatarColor(r.id),
    },
    status: {
      value: status,
      /*
       * Код, а не фраза. В базе рядом с кодом лежала его же формулировка по-русски
       * («Спамблок — аккаунт помечен и пропускается»), причём у части записей код был
       * пуст, а числа вплавлены в текст. Текст — дело интерфейса, он и переводится, и
       * переписывается; база хранит код и параметры к нему.
       */
      code: r.status_code || null,
      params: r.status_params && typeof r.status_params === 'object' ? r.status_params : {},
      since: iso(r.status_since),
      until: iso(r.status_until),
      previous: r.prev_status || null,
    },
    security: { twoFactor: !!r.has_two_fa },
    session: {
      // На боевом сервере сессии пока файлами: `account_sessions` заполнится переносом.
      // До тех пор истину знает файловая проверка, поэтому её результат сильнее колонки.
      present: extra.present ?? !!r.has_session,
      checkedAt: iso(r.last_checked_at),
      ok: typeof r.last_check_ok === 'boolean' ? r.last_check_ok : null,
      healthCheckedAt: iso(r.health_checked_at),
    },
    proxy: прокси,
    trust,
    risk: computeAccountRisk({
      status,
      proxyOk: !прокси || прокси.ok,
      noProxy: !прокси,
      trustBand: trust?.band,
    }),
    busy: занят,
    origin: { code: r.origin_code || null, params: r.origin_params || {} },
  }
}

/**
 * Спамблок хранится отдельным полем (результат проверки @SpamBot), и в карточке он виден,
 * а в списке — нет: аккаунт светился «Активные». Отражаем блокировку статусом, если
 * базовый статус рабочий. Снимется сам, когда проверка вернёт `clean`.
 */
function эффективныйСтатус(r) {
  const s = r.status || 'active'
  if (r.spamblock === 'blocked' && ['active', 'working', 'warming', 'pause'].includes(s)) return 'spamblock'
  return s
}

/** Кем занят аккаунт прямо сейчас. Локи живут в памяти процесса — запроса не требуют. */
function занятость(accountId) {
  const lock = getAccountLock(accountId)
  if (!lock) return null
  return {
    taskId: lock.taskId,
    // Многомодульность: аккаунт может числиться сразу в нескольких модулях.
    modules: (lock.holders || []).map((h) => ({ key: h.moduleKey, label: h.moduleLabel })),
  }
}

/**
 * Страница списка.
 *
 * @param {object} opts
 * @param {number} [opts.page] с единицы
 * @param {number} [opts.pageSize]
 * @param {string} [opts.search] имя, username, телефон
 * @param {string[]} [opts.statuses]
 * @param {boolean} [opts.inTrash] показывать корзину вместо рабочего списка
 * @param {string|null} [opts.ownerId] чьё пространство; null — весь парк (админ)
 * @param {string[]|null} [opts.ids] сотруднику видно только перечисленное; null — без ограничения
 * @param {string[]} [opts.countries] коды стран; регион раскрывает клиент — карта регионов у него
 * @param {'deadProxy'|'noProxy'|'lowTrust'} [opts.risk]
 * @param {string} [opts.campaignId] id кампании либо 'pool' — «не в кампании»
 * @param {string} [opts.busyModule] ключ модуля либо 'idle' — «свободные»
 * @param {number} [opts.fatigueMin] порог усталости в процентах
 * @param {boolean} [opts.trashAlive] в корзине скрыть невалидные и требующие входа
 * @param {{field?: string, dir?: string}} [opts.sort]
 * @returns {Promise<{items: object[], page: object, counts: object}>}
 */
export async function listAccountsPage(opts = {}) {
  const db = supabaseEnabled() ? getSupabase() : null
  if (!db) throw new Error('Список аккаунтов доступен только с базой (DATA_BACKEND=supabase)')

  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(opts.pageSize) || DEFAULT_PAGE_SIZE)))
  const number = Math.max(1, Math.floor(Number(opts.page) || 1))
  const from = (number - 1) * size

  const порядок = СОСТАВНЫЕ[opts.sort?.field]
  const колонка = SORTS[opts.sort?.field] || SORTS.createdAt
  const поВозрастанию = String(opts.sort?.dir || 'desc').toLowerCase() === 'asc'

  let q = db.from(VIEW).select('*', { count: 'exact' })
  q = q.eq('in_trash', opts.inTrash === true)
  if (opts.ownerId) q = q.eq('owner_id', String(opts.ownerId))
  /*
   * Сотруднику видно только выданное — и это условие уезжает В ЗАПРОС.
   *
   * Фильтровать после выборки страницы нельзя: получилась бы страница на пятьдесят
   * строк, из которых показано семь, и счётчик «всего», посчитанный по чужим аккаунтам.
   * Перечень конечный: подстановочного «все аккаунты» для сотрудника не бывает, каждый
   * доступ выдан точечно или группой.
   */
  if (Array.isArray(opts.ids)) {
    if (!opts.ids.length) {
      return { items: [], page: { number, size, total: 0, pages: 1 }, counts: {}, facets: { countries: {} } }
    }
    q = q.in('id', opts.ids.map(String))
  }

  /*
   * Статус — ЭФФЕКТИВНЫЙ, а не колонка.
   *
   * Спамблок хранится отдельным полем (результат проверки @SpamBot), и аккаунт с рабочим
   * базовым статусом показывается в списке как «Спамблок». Отфильтровать по колонке
   * `status` значит не найти ровно тех, кого оператор видит в этой плитке. Разворачиваем
   * то же правило в условие запроса.
   */
  const statuses = (opts.statuses || []).map(String).filter((s) => STATUSES.has(s))
  if (statuses.length) {
    const части = []
    for (const s of statuses) {
      if (s === 'spamblock') {
        части.push('status.eq.spamblock')
        части.push(`and(spamblock.eq.blocked,status.in.(${ПЕРЕКРЫВАЕМЫЕ.join(',')}))`)
      } else if (ПЕРЕКРЫВАЕМЫЕ.includes(s)) {
        // Базовый статус рабочий — значит спамблока быть не должно, иначе строка «уехала»
        // бы в плитку «Спамблок», а здесь показалась бы вторым экземпляром.
        части.push(`and(status.eq.${s},or(spamblock.is.null,spamblock.neq.blocked))`)
      } else {
        части.push(`status.eq.${s}`)
      }
    }
    q = q.or(части.join(','))
  }

  // Страна. Регион («Европа», «СНГ») раскрывает клиент — карта регионов живёт у него,
  // и дублировать её на сервере значило бы завести второй источник правды.
  const страны = (opts.countries || []).map((c) => String(c || '').toLowerCase()).filter(Boolean)
  if (страны.length) q = q.in('country', страны)

  /*
   * Зона риска — из тех же колонок, из которых её считает `computeAccountRisk`.
   * Условие в запросе, а не отбор после выборки: отобранная страница иначе окажется
   * короче запрошенной, а «всего» посчитается по нефильтрованному набору.
   */
  if (opts.risk === 'noProxy') q = q.is('proxy_id', null)
  else if (opts.risk === 'deadProxy') q = q.not('proxy_id', 'is', null).in('proxy_status', ['dead', 'bad'])
  else if (opts.risk === 'lowTrust') q = q.eq('trust_band', 'low')

  // Корзина: «только живые» — то есть без невалидных и требующих повторного входа.
  if (opts.inTrash === true && opts.trashAlive) q = q.not('status', 'in', '(invalid,reauth)')

  /*
   * Признаки, которых нет в базе: занятость (локи живут в памяти процесса), усталость и
   * состав кампании. Разворачиваем их в перечень идентификаторов и кладём в тот же
   * запрос — иначе они снова превратились бы в отбор после страницы.
   */
  const поИдентификаторам = await спискиПоПризнакам(opts)
  if (поИдентификаторам.include) {
    if (!поИдентификаторам.include.length) {
      return { items: [], page: { number, size, total: 0, pages: 1 }, ...(await сводкаПарка(db, opts.ownerId)) }
    }
    q = q.in('id', поИдентификаторам.include)
  }
  if (поИдентификаторам.exclude?.length) q = q.not('id', 'in', `(${поИдентификаторам.exclude.join(',')})`)

  const строка = String(opts.search || '').trim()
  if (строка) {
    /*
     * Поиск идёт в базе, а не фильтром по уже полученному массиву: фильтровать после
     * выборки страницы значит искать в пятидесяти строках вместо всего парка — оператор
     * ищет по всей базе, а находит в текущей странице, и это выглядит как «не нашлось».
     */
    const образец = `%${строка.replace(/[%_,()]/g, ' ')}%`
    q = q.or(`name.ilike.${образец},username.ilike.${образец},phone.ilike.${образец}`)
  }

  if (порядок) for (const [c, o] of порядок) q = q.order(c, o)
  else q = q.order(колонка, { ascending: поВозрастанию, nullsFirst: false })
  // Вторым ключом — id: без него строки с одинаковым значением сортировки могут менять
  // порядок между страницами, и одна и та же запись показывается дважды или ни разу.
  q = q.order('id', { ascending: true })
  q = q.range(from, from + size - 1)

  const { data, error, count } = await q
  if (error) throw new Error(`[${VIEW}] список аккаунтов не прочитан: ${error.message}`)

  const rows = data || []
  // Наличие сессии — одним запросом на страницу плюс проверка файлов (перенос сессий в
  // базу ещё не прогоняли, и на боевом сервере они лежат файлами).
  const сСессией = await sessionPresence(rows.map((r) => r.id)).catch(() => new Set())

  const items = rows.map((r) => rowToAccount(r, { present: сСессией.has(r.id) || !!r.has_session }))
  const total = Number(count || 0)

  return {
    items,
    page: { number, size, total, pages: Math.max(1, Math.ceil(total / size)) },
    ...(await сводкаПарка(db, opts.ownerId)),
  }
}

/** Статусы, поверх которых спамблок перекрывает базовый (см. `эффективныйСтатус`). */
const ПЕРЕКРЫВАЕМЫЕ = ['active', 'working', 'warming', 'pause']

/**
 * Признаки, которых нет в представлении, — в перечни идентификаторов.
 *
 * Занятость аккаунта задачей хранится в памяти процесса (локи), усталость — в
 * `account_activity`, состав кампании — в `campaign_accounts`. Каждый из них читается
 * ОДИН раз на запрос, и результат уезжает в тот же самый запрос к базе условием по `id`.
 *
 * @param {object} opts
 * @returns {Promise<{include: string[]|null, exclude: string[]}>}
 */
async function спискиПоПризнакам(opts) {
  /** Пересечение: каждый следующий признак только сужает набор. */
  let include = null
  const exclude = []
  const сузить = (ids) => { include = include === null ? [...new Set(ids)] : include.filter((x) => ids.includes(x)) }

  if (opts.busyModule) {
    const { getAllAccountLocksDetailed } = await import('./lib/accountLocks.js')
    const занятые = await getAllAccountLocksDetailed()
    if (opts.busyModule === 'idle') exclude.push(...Object.keys(занятые || {}))
    else {
      сузить(Object.entries(занятые || {})
        .filter(([, l]) => (l?.holders || [{ moduleKey: l?.moduleKey }]).some((h) => h.moduleKey === opts.busyModule))
        .map(([id]) => id))
    }
  }

  const порог = Number(opts.fatigueMin) || 0
  if (порог > 0) {
    const { listActivity } = await import('./accountActivity.js')
    const все = await listActivity().catch(() => ({}))
    сузить(Object.entries(все)
      .filter(([, a]) => a?.threshold > 0 && Math.round((a.fatigue / a.threshold) * 100) >= порог)
      .map(([id]) => id))
  }

  if (opts.campaignId) {
    const { listCampaigns } = await import('./campaigns.js')
    const кампании = await listCampaigns().catch(() => [])
    if (opts.campaignId === 'pool') {
      // «Свободные от кампаний» — вычитаем всех, кто хоть в одной состоит.
      for (const c of кампании) exclude.push(...(c.accountIds || []))
    } else {
      const c = кампании.find((x) => x.id === opts.campaignId)
      сузить(c?.accountIds || [])
    }
  }

  return { include, exclude: [...new Set(exclude)] }
}

/**
 * Сводка по всему парку: счётчики плиток и набор стран для фильтра.
 *
 * И то и другое считается по ВСЕМУ парку, а не по показанной странице: плитка «Спамблок»
 * обязана показывать всех, а не тех, кто попал в текущие двадцать пять строк, и в
 * выпадающем списке стран должны быть все страны парка, а не страны одной страницы.
 * Раньше и то и другое считал фронт по полному списку — то есть плитки и были причиной,
 * по которой список грузился целиком.
 */
async function сводкаПарка(db, ownerId) {
  const [счётчики, срез, локи] = await Promise.all([
    db.rpc('account_status_counts', { p_owner: ownerId ? String(ownerId) : null }),
    (() => {
      // Четыре колонки на весь парк — несколько килобайт. Группировки в PostgREST нет,
      // а заводить ради этого функцию в базе дороже, чем сложить числа здесь.
      let s = db.from(VIEW).select('id, country, proxy_id, proxy_status, trust_band').eq('in_trash', false)
      if (ownerId) s = s.eq('owner_id', String(ownerId))
      return s
    })(),
    import('./lib/accountLocks.js').then((m) => m.getAllAccountLocksDetailed()).catch(() => ({})),
  ])
  if (счётчики.error) throw new Error(`[account_status_counts] счётчики не прочитаны: ${счётчики.error.message}`)

  const строки = срез.data || []
  const свои = new Set(строки.map((r) => r.id))

  const countries = {}
  // Причины риска считаются по тем же правилам, что и `computeAccountRisk`: один аккаунт
  // может попасть сразу в несколько (и прокси мёртвый, и доверие низкое).
  const risk = { deadProxy: 0, noProxy: 0, lowTrust: 0 }
  for (const r of строки) {
    const c = String(r.country || '').toLowerCase()
    if (c) countries[c] = (countries[c] || 0) + 1
    if (!r.proxy_id) risk.noProxy += 1
    else if (r.proxy_status === 'dead' || r.proxy_status === 'bad') risk.deadProxy += 1
    if (r.trust_band === 'low') risk.lowTrust += 1
  }

  // Занятость — из локов в памяти процесса, запроса не требует. Чужие аккаунты
  // отсеиваем по тому же срезу, иначе сотрудник увидел бы работу чужого пространства.
  const modules = {}
  for (const [id, lock] of Object.entries(локи || {})) {
    if (!свои.has(id)) continue
    for (const h of lock?.holders || [{ moduleKey: lock?.moduleKey, moduleLabel: lock?.moduleLabel }]) {
      if (!h?.moduleKey) continue
      modules[h.moduleKey] = modules[h.moduleKey] || { label: h.moduleLabel || h.moduleKey, count: 0 }
      modules[h.moduleKey].count += 1
    }
  }

  return {
    counts: счётчики.data && typeof счётчики.data === 'object' ? счётчики.data : {},
    facets: { countries, risk, modules, busyTotal: Object.keys(локи || {}).filter((id) => свои.has(id)).length },
  }
}

/**
 * Один аккаунт по идентификатору — тем же представлением и с той же формой ответа.
 *
 * Отдельная функция, чтобы карточка и список не разошлись: раньше список считал
 * работоспособность прокси по одной формуле, а вкладка карточки — по другой, и они
 * противоречили друг другу прямо на экране.
 * @param {string} accountId
 */
export async function getAccountCard(accountId) {
  const db = supabaseEnabled() ? getSupabase() : null
  if (!db) throw new Error('Карточка аккаунта доступна только с базой (DATA_BACKEND=supabase)')
  const { data, error } = await db.from(VIEW).select('*').eq('id', String(accountId)).maybeSingle()
  if (error) throw new Error(`[${VIEW}] аккаунт не прочитан: ${error.message}`)
  if (!data) return null
  const есть = await sessionPresence([data.id]).catch(() => new Set())
  return rowToAccount(data, { present: есть.has(data.id) || !!data.has_session })
}
