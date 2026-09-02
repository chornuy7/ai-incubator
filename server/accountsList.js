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
  trust: 'trust_score',
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
 * @param {{field?: string, dir?: string}} [opts.sort]
 * @returns {Promise<{items: object[], page: object, counts: object}>}
 */
export async function listAccountsPage(opts = {}) {
  const db = supabaseEnabled() ? getSupabase() : null
  if (!db) throw new Error('Список аккаунтов доступен только с базой (DATA_BACKEND=supabase)')

  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(opts.pageSize) || DEFAULT_PAGE_SIZE)))
  const number = Math.max(1, Math.floor(Number(opts.page) || 1))
  const from = (number - 1) * size

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
      return { items: [], page: { number, size, total: 0, pages: 1 }, counts: {} }
    }
    q = q.in('id', opts.ids.map(String))
  }

  const statuses = (opts.statuses || []).map(String).filter((s) => STATUSES.has(s))
  if (statuses.length) q = q.in('status', statuses)

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

  q = q.order(колонка, { ascending: поВозрастанию, nullsFirst: false })
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
    counts: await статусныеСчётчики(db, opts.ownerId),
  }
}

/**
 * Счётчики плиток — по всему парку, а не по странице.
 *
 * Считает база (`account_status_counts`). Раньше фронт получал весь парк и мерил длины
 * массивов у себя — то есть плитки и были той причиной, по которой список грузился
 * целиком.
 */
async function статусныеСчётчики(db, ownerId) {
  const { data, error } = await db.rpc('account_status_counts', { p_owner: ownerId ? String(ownerId) : null })
  if (error) throw new Error(`[account_status_counts] счётчики не прочитаны: ${error.message}`)
  return data && typeof data === 'object' ? data : {}
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
