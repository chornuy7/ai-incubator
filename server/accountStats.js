/** Реальная статистика аккаунта для модалки «Управление аккаунтом». */
import { getAccountMeta, loadAllMeta, setAccountStatus, setAccountMeta } from './accountsMeta.js'
import { loadSessionString, createClient } from './tgAuth.js'
import { parseProxy } from './proxy.js'
import { probeProxyProtocol, markProxyStatus, findProxyByUrl } from './proxies.js'
import { getAccountLock } from './lib/accountLocks.js'
import { getSwitchPause } from './lib/accountBusy.js'
import { fmtDelay } from './lib/humanDelays.js'
import { accountTrust } from './lib/trustScore.js'
import { setTrustCache } from './lib/trustCache.js'
import { countryFromPhone } from './accountsMeta.js'
import { Api } from 'telegram/tl/index.js'
import { accountFingerprint } from './lib/deviceFingerprint.js'
import { recordAction } from './actionLog.js'
import { accountProxyUrl } from './proxies.js'

const DAY = 24 * 60 * 60 * 1000
/**
 * Человекочитаемый итог проверки спамблока — он же попадает в ленту истории аккаунта
 * (ТЗ 19.08 §5). Держим здесь, чтобы формулировка совпадала с тостом в карточке.
 */
const SPAMCHECK_TEXT = {
  clean: 'Спамблока нет — @SpamBot ограничений не показал',
  blocked: 'Спамблок есть — аккаунт ограничен @SpamBot',
  unknown: 'Результат неизвестен — @SpamBot не ответил',
}
/**
 * Сколько ждём ответ @SpamBot после `/start`. Значение боевое; переменная нужна тестам,
 * чтобы не спать по 2.5 секунды на каждый разбираемый ответ.
 */
const SPAMCHECK_WAIT_MS = Number(process.env.SPAMCHECK_WAIT_MS) || 2500
/** Сколько ждём ответ Telegram в карточке аккаунта, прежде чем признать проверку сорванной. */
const STATS_BUDGET_MS = Math.max(4000, Number(process.env.TG_STATS_TIMEOUT_MS) || 8000)
/**
 * Насколько доверяем свежему вердикту «прокси нерабочий». В это окно карточка НЕ ходит
 * в сеть повторно: смысла ждать те же 15с на каждом открытии нет, ответ известен.
 * По истечении окна проверка идёт заново — вердикт сам себя лечит, если прокси починили.
 */
const DEAD_PROXY_TRUST_MS = 10 * 60 * 1000

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Разобрать строку прокси в структурированный вид (без секретов пароля). */
/**
 * Описание прокси для карточки — ИЗ ЗАПИСИ КАТАЛОГА, а не из строки подключения.
 *
 * Раньше сюда приходил собранный URL, и поле `raw` уезжало в ответ целиком — то есть
 * вместе с логином и паролем прокси. Открыть карточку аккаунта было достаточно, чтобы
 * получить рабочие доступы к прокси; в браузере они оседали в кэше и в истории.
 *
 * Теперь наружу идёт то, что показывают: подпись, протокол, адрес, порт, логин. Пароля
 * в записи для показа нет вовсе — `getProxy` его не отдаёт.
 *
 * @param {object|null} p запись каталога без пароля
 */
function describeProxy(p) {
  if (!p) return { id: null, label: '', protocol: null, scheme: null, ip: null, port: null, login: null, configured: false }
  const scheme = p.scheme === 'http' ? 'http' : 'socks5'
  return {
    id: p.id || null,
    label: p.label || '',
    protocol: scheme === 'http' ? 'HTTP' : 'SOCKS5',
    // Схема в том виде, какой ждёт probeProxyProtocol (socks5/socks4/http).
    scheme,
    ip: p.host || null,
    port: p.port ?? null,
    login: p.username || null,
    configured: !!(p.host && p.port),
  }
}

/**
 * Признан ли прокси нерабочим совсем недавно (см. DEAD_PROXY_TRUST_MS).
 *
 * Запись каталога уже прочитана вызывающим — искать её по строке подключения не нужно и
 * нельзя: поиск по host+port был обходным путём тех времён, когда связи не было. Связь
 * есть, она называется `proxy_id`.
 *
 * @param {object|null} p запись каталога @param {object} meta
 */
function recentlyDeadProxy(p, meta = {}) {
  if (p) return p.status === 'dead' && !!p.lastCheckAt && (Date.now() - p.lastCheckAt) < DEAD_PROXY_TRUST_MS
  return meta.proxyWorking === false && !!meta.proxyCheckAt && (Date.now() - meta.proxyCheckAt) < DEAD_PROXY_TRUST_MS
}

/**
 * Сохранённый вердикт по прокси — БЕЗ похода в сеть. Источник правды: каталог прокси
 * (его обновляет фоновая проверка раз в 30 минут и кнопки «Тест»/«Проверить все»), а для
 * «ручных» прокси вне каталога — отметка в мете аккаунта.
 * @returns {Promise<'ok'|'down'|null>} null — вердикта ещё нет
 */
export function cachedProxyVerdict(p, meta = {}) {
  if (p && p.lastCheckAt) {
    if (p.status === 'ok') return 'ok'
    // dead — хост не отвечает; bad — не тот протокол или не пускает в Telegram.
    if (p.status === 'dead' || p.status === 'bad') return 'down'
    return null
  }
  // Прокси вне каталога (назначен вручную) — верим отметке в мете аккаунта.
  if (meta.proxyCheckAt && typeof meta.proxyWorking === 'boolean') return meta.proxyWorking ? 'ok' : 'down'
  return null
}

/**
 * Похожа ли ошибка подключения на проблему ПРОКСИ/сети, а не сессии.
 *
 * Без этого любая сетевая беда записывалась аккаунту в «невалиден»: сдох прокси —
 * а в интерфейсе «аккаунт умер». Ошибки авторизации Telegram (AUTH_KEY…) — это
 * действительно сессия, всё остальное сетевое — прокси.
 */
function looksLikeProxyProblem(err) {
  const msg = String(err?.message || err || '')
  if (/AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_UNREGISTERED/i.test(msg)) return false
  return /socks|proxy|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|timeout|Не удалось подключиться|connect/i.test(msg)
}

/**
 * Проверка спамблока через @SpamBot (побочный эффект: отправляет /start).
 * @param {import('telegram').TelegramClient} client
 */
export async function checkSpamblock(client) {
  try {
    const bot = await client.getEntity('SpamBot')
    await client.sendMessage(bot, { message: '/start' })
    await sleep(SPAMCHECK_WAIT_MS)
    const msgs = await client.getMessages(bot, { limit: 1 })
    const text = msgs?.[0]?.message || ''
    if (/no limits|not limited|free as a bird|good news|ограничени\w* (сняты|нет)|свобод/i.test(text)) {
      return { state: 'clean', text: text.slice(0, 300) }
    }
    if (/is limited|restricted|ограничен|заблокирован|until/i.test(text)) {
      return { state: 'blocked', text: text.slice(0, 300) }
    }
    return { state: 'unknown', text: text.slice(0, 300) }
  } catch {
    return { state: 'unknown', text: '' }
  }
}

/**
 * Запись о проверке спамблока для журнала действий (ТЗ 19.08 §5).
 *
 * Отдельной функцией, а не строкой внутри `buildAccountStats`: там она достижима только
 * живым коннектом к Telegram, а проверить надо именно её — что «молчание бота» не
 * превращается в успешную проверку, а под-тип доезжает до ленты истории.
 *
 * @param {string} accountId @param {string} accountName
 * @param {{ state: 'clean' | 'blocked' | 'unknown', text?: string }} sb
 */
export function spamcheckAction(accountId, accountName, sb) {
  return {
    type: 'action',
    // Проверка не «отправка»: определённый вердикт = sent, молчание @SpamBot = failed.
    status: sb.state === 'unknown' ? 'failed' : 'sent',
    accountId,
    accountName: accountName || '',
    target: '@SpamBot',
    targetTitle: 'SpamBot',
    // Под-тип живёт в value.kind (§3 контракта: словарь type расширяемый) — новых
    // форматов журнала не заводим, лента и фильтр читают именно его.
    value: { kind: 'spamcheck', text: SPAMCHECK_TEXT[sb.state] || SPAMCHECK_TEXT.unknown },
    // Проверку запускает человек из карточки аккаунта — задачи/модуля за ней нет.
    initiator: 'operator',
    meta: { spamblock: sb.state, spamblockText: sb.text || '' },
  }
}

/**
 * Собрать журнал активности аккаунта из реальных логов/истории всех модулей.
 * @param {string} accountId @param {string} accountName @param {number} [limit]
 */
async function collectActivity(accountId, accountName, limit = 40) {
  /** @type {{ ts: string, type: string, label: string, target?: string, level: string, module: string }[]} */
  const entries = []
  const nameMatch = (v) => v && accountName && String(v).toLowerCase() === String(accountName).toLowerCase()

  const pushFromTask = (task, moduleLabel) => {
    if (!task) return
    const ids = task.settings?.accountIds || []
    const involvesById = ids.includes(accountId)
    for (const log of task.logs || []) {
      if (log.account) {
        if (!nameMatch(log.account)) continue
      } else if (!involvesById) {
        continue
      }
      entries.push({
        ts: log.ts,
        type: log.level === 'success' ? 'action' : log.level,
        label: log.message,
        level: log.level,
        module: moduleLabel,
      })
    }
    const histories = [task.commentHistory, task.history].filter(Array.isArray)
    for (const hist of histories) {
      for (const h of hist) {
        if (h.accountId && h.accountId !== accountId && !nameMatch(h.accountName)) continue
        if (!h.accountId && !nameMatch(h.accountName)) continue
        entries.push({
          ts: h.ts,
          type: 'action',
          label: h.comment ? `Комментарий: ${String(h.comment).slice(0, 60)}` : h.text ? `Сообщение: ${String(h.text).slice(0, 60)}` : h.emoji ? `Реакция ${h.emoji}` : 'Действие',
          target: h.channel || h.target,
          level: 'success',
          module: moduleLabel,
        })
      }
    }
  }

  try {
    const { listModuleKeys, getModuleStore } = await import('./modules/registry.js')
    const { moduleLabel } = await import('./lib/accountLocks.js')
    for (const key of listModuleKeys()) {
      const store = getModuleStore(key)
      if (!store) continue
      const tasks = await store.listTasks()
      const relevant = tasks.filter((t) => (t.settings?.accountIds || []).includes(accountId)).slice(0, 8)
      for (const t of relevant) {
        const full = await store.loadTask(t.id)
        pushFromTask(full, moduleLabel(key))
      }
    }
  } catch { /* ignore */ }

  try {
    const { listTasks, loadTask } = await import('./neuroCommenting/taskStore.js')
    const tasks = await listTasks()
    const relevant = tasks.filter((t) => (t.settings?.accountIds || []).includes(accountId)).slice(0, 8)
    for (const t of relevant) {
      const full = await loadTask(t.id)
      pushFromTask(full, 'Нейрокомментинг')
    }
  } catch { /* ignore */ }

  entries.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
  return entries.slice(0, limit)
}

/** Здоровье аккаунта из реальных сигналов. */
function computeHealth(sessionOk, proxy, status, activity) {
  const events = activity
    .filter((e) => e.level === 'error' || e.level === 'warning')
    .slice(0, 8)
    .map((e) => ({ ts: e.ts, level: e.level, label: e.label, module: e.module }))

  let score = 100
  if (!sessionOk) score -= 60
  if (proxy.configured && proxy.working === false) score -= 15
  if (status === 'quarantine') score -= 25
  if (status === 'spamblock') score -= 40
  if (status === 'reauth' || status === 'invalid') score -= 50
  const recentErrors = events.filter((e) => e.level === 'error').length
  score -= Math.min(20, recentErrors * 5)
  score = Math.max(0, Math.min(100, score))

  const label = score >= 80 ? 'Отличное' : score >= 55 ? 'Хорошее' : score >= 30 ? 'Среднее' : 'Плохое'
  return { score, label, events }
}

/** Оценка «долголетия» аккаунта из реальных признаков. */
function computeLongevity({ ageDays, sessionOk, profileComplete, actionCount, hadFloodOrQuarantine }) {
  const factors = []
  let score = 0

  if (ageDays >= 30) { score += 30; factors.push({ key: 'aged', label: 'Отлежавшийся аккаунт', positive: true }) }
  else if (ageDays >= 7) { score += 15; factors.push({ key: 'aged', label: `Возраст ${Math.round(ageDays)} дн.`, positive: true }) }
  else { score += 5; factors.push({ key: 'young', label: 'Молодой аккаунт', positive: false }) }

  if (sessionOk) { score += 25; factors.push({ key: 'session', label: 'Стабильная сессия', positive: true }) }
  else { factors.push({ key: 'session', label: 'Сессия невалидна', positive: false }) }

  if (profileComplete) { score += 20; factors.push({ key: 'profile', label: 'Профиль заполнен', positive: true }) }
  else { score += 5; factors.push({ key: 'profile', label: 'Неполный профиль', positive: false }) }

  if (actionCount >= 20) { score += 20; factors.push({ key: 'activity', label: 'Активность в норме', positive: true }) }
  else if (actionCount > 0) { score += 10; factors.push({ key: 'activity', label: 'Низкая активность', positive: false }) }
  else { factors.push({ key: 'activity', label: 'Нет активности', positive: false }) }

  if (hadFloodOrQuarantine) { score -= 15; factors.push({ key: 'bans', label: 'Были флуд-ограничения', positive: false }) }
  else { score += 5 }

  score = Math.max(0, Math.min(100, score))
  const risk = score >= 70 ? 'low' : score >= 45 ? 'medium' : 'high'
  return { score, risk, factors }
}

/**
 * Основная сборка статистики аккаунта.
 * @param {string} accountId
 * @param {{ spam?: boolean }} [opts]
 */
/** Готов ли аккаунт вернуться из прогрева в пул (§3.3, §6: trust>70). Чистая. */
export function readyToReturnFromWarming(status, trustScore) {
  return status === 'warming' && Number(trustScore) > 70
}

/**
 * Периодический пересчёт trust для ВСЕХ аккаунтов без сети (по мете + активности из логов).
 * Держит кэш trust свежим (assignment-gate + список) И выполняет §6-**авто-возврат**:
 * аккаунт в прогреве с trust>70, не занятый задачей → возвращается в active.
 * @returns {Promise<{updated:number, returned:number}>}
 */
export async function refreshAllTrustCache() {
  const all = await loadAllMeta()
  let updated = 0
  let returned = 0
  for (const [accountId, meta] of Object.entries(all)) {
    if (!meta || meta.inTrash) continue
    try {
      const activity = await collectActivity(accountId, meta.name || '', 40)
      const ageDays = meta.createdAt ? (Date.now() - meta.createdAt) / DAY : 0
      const t = accountTrust({ activity, status: meta.status || 'active', ageDays, ggr: meta.ggr ?? null })
      await setTrustCache(accountId, { score: t.score, band: t.band })
      updated += 1
      // §6 авто-возврат: прогрев поднял здоровье (trust>70) → назад в пул. Не трогаем занятых.
      if (readyToReturnFromWarming(meta.status, t.score) && !getAccountLock(accountId)) {
        await setAccountStatus(accountId, 'active', { initiator: 'system', module: 'trust', reason: `trust ${t.score} > 70 — авто-возврат из прогрева` })
        returned += 1
      }
    } catch { /* пропускаем проблемный аккаунт */ }
  }
  return { updated, returned }
}

export async function buildAccountStats(accountId, opts = {}) {
  const meta = await getAccountMeta(accountId)
  const sessionStr = await loadSessionString(accountId)
  const lock = getAccountLock(accountId)
  const busyIn = lock ? { moduleKey: lock.moduleKey, taskId: lock.taskId, moduleLabel: lock.moduleLabel } : null
  /*
   * Пауза при переключении между модулями — в карточку аккаунта (владелец 21.08:
   * «я должен видеть у аккаунта в информации, какая задержка между модулями применена»).
   * Она случайная у каждого перехода, и без этой строки «почему профиль стоит» можно
   * было понять только по логу задачи — если знать, в какой именно задаче искать.
   */
  const sw = getSwitchPause(accountId)
  const switchPause = sw ? { ...sw, text: `Перерыв после «${sw.fromLabel}»: ${fmtDelay(sw.coolMs)}, осталось ${fmtDelay(sw.leftMs)}` } : null

  // Одна строка каталога по ссылке из меты. Без пароля: карточке он не нужен.
  const записьПрокси = meta.proxyId ? await getProxy(meta.proxyId).catch(() => null) : null
  const proxy = describeProxy(записьПрокси)
  const activity = await collectActivity(accountId, meta.name || '', 40)
  const actionCount = activity.filter((e) => e.type === 'action').length
  const hadFloodOrQuarantine = activity.some((e) => /flood|карантин|quarantine/i.test(e.label)) || meta.status === 'quarantine'

  let me = null
  let sessionOk = false
  let live = false
  /**
   * Почему проверку НЕ довели до конца: 'no_proxy' (прокси не назначен) или
   * 'proxy_down' (назначен, но не отвечает). В обоих случаях про сессию ничего не
   * известно — и метить аккаунт «невалидным» нельзя: причина другая.
   * @type {null | 'no_proxy' | 'proxy_down'}
   */
  let blocked = null

  /**
   * Живую проверку делаем ТОЛЬКО по явной просьбе (кнопка «Проверить» / проверка
   * спамблока). По умолчанию отдаём СОХРАНЁННЫЙ вердикт: статус прокси лежит в каталоге,
   * результат последней проверки аккаунта — в его мете. Раньше карточка лезла в сеть на
   * каждом открытии и ждала до 15с, хотя ответ уже был известен. Фон обновляет каталог
   * сам (проверка всех прокси раз в 30 минут).
   */
  const wantLive = !!opts.force || !!opts.spam

  if (sessionStr && !busyIn && !proxy.configured) {
    // Прокси не назначен — по сети не ходим вообще. Раньше шли напрямую с сервера,
    // ловили произвольную ошибку и писали «невалиден»: подменяли причину.
    blocked = 'no_proxy'
  } else if (sessionStr && !busyIn && !wantLive) {
    // Быстрый путь: берём вердикт из базы. Прокси нерабочий — так и говорим, сеть не трогаем.
    const cached = await cachedProxyVerdict(записьПрокси, meta)
    if (cached === 'down') { blocked = 'proxy_down'; proxy.working = false }
    else if (cached === 'ok') proxy.working = true
  } else if (sessionStr && !busyIn && recentlyDeadProxy(записьПрокси, meta)) {
    // Прокси уже признан нерабочим только что — не ждём сеть ещё раз (карточка
    // открывалась по 15с на каждом заходе). Через DEAD_PROXY_TRUST_MS проверим снова.
    blocked = 'proxy_down'
    proxy.working = false
  } else if (sessionStr && !busyIn) {
    // Сначала дёшево проверяем САМ прокси (рукопожатие по протоколу). Если он мёртв,
    // Telegram-проверка всё равно упадёт — но выглядело бы это как смерть аккаунта.
    const alive = await probeProxyProtocol({ scheme: proxy.scheme, host: proxy.ip, port: proxy.port }, 6000)
      .catch(() => false)
    if (!alive) {
      blocked = 'proxy_down'
      live = true
      proxy.working = false
      // Сдох — сразу в «нерабочие» в каталоге, не дожидаясь получасовой авто-проверки.
      try { await markProxyStatus(meta.proxyId, 'dead') } catch { /* non-fatal */ }
    }
  }

  if (sessionStr && !busyIn && !blocked && wantLive) {
    let client
    try {
      // createClient сам делает быстрый TCP-пинг прокси и падает за ~2.5с на мёртвом прокси
      // (MR-129) — карточка/каналы/группы больше не ждут таймаут подключения 12с.
      client = await createClient(sessionStr, await accountProxyUrl(meta), accountFingerprint(accountId, meta))
      // Общий бюджет живой проверки. Даже с лимитом на каждый RPC карточка не должна
      // ждать десятки секунд: прокси, который принял соединение, но наружу не пускает,
      // держал «Загрузку данных из Telegram…» минутами (замер 12.08: >45с).
      me = await Promise.race([
        client.getMe(),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`STATS_TIMEOUT: Telegram не ответил за ${Math.round(STATS_BUDGET_MS / 1000)}с`)), STATS_BUDGET_MS)),
      ])
      sessionOk = true
      live = true
      if (proxy.configured) proxy.working = true
      // Ожил — снимаем клеймо «нерабочий», если оно было.
      try { await markProxyStatus(meta.proxyId, 'ok') } catch { /* non-fatal */ }
      if (opts.spam) {
        const sb = await checkSpamblock(client)
        proxy._spamblock = sb
        // MR-63: персистим ОПРЕДЕЛЁННЫЙ результат (clean/blocked) + дату проверки. Иначе на
        // следующей загрузке (без opts.spam) спамблок снова «Неизвестно» — результат «пропадал».
        if (sb.state === 'clean' || sb.state === 'blocked') {
          try { await setAccountMeta(accountId, { spamblock: sb.state, spamblockAt: Date.now(), spamblockText: sb.text || '' }) } catch { /* non-fatal */ }
        }
        // ТЗ 19.08 §5: до сих пор от проверки оставалась только дата в карточке
        // («Проверено: …»), а в ЛЕНТЕ истории события не было — оператор не видел, когда
        // и с каким результатом аккаунт проверяли. Пишем в тот же журнал действий, что и
        // воркеры (recordAction), под-тип — через value.kind (§3 контракта: словарь type
        // расширяемый, а под-тип живёт в value.kind), новых форматов не заводим.
        void recordAction(spamcheckAction(accountId, meta.name, sb))
      }
      await client.disconnect()
    } catch (err) {
      live = true
      // Сетевая ошибка через прокси — вина ПРОКСИ, а не сессии. Иначе сдохший прокси
      // «убивал» аккаунт: в списке он становился невалидным без всякой причины.
      if (proxy.configured && looksLikeProxyProblem(err)) {
        blocked = 'proxy_down'
        proxy.working = false
        try { await markProxyStatus(meta.proxyId, 'dead') } catch { /* non-fatal */ }
      } else {
        sessionOk = false
        if (proxy.configured) proxy.working = false
      }
      try { if (client) await client.disconnect() } catch { /* ignore */ }
    }
    // MR-129: персистим результат живой проверки прокси — чтобы СПИСОК менеджера тоже знал,
    // что прокси не отвечает (иначе ручной прокси вне каталога считался «ок» и статус зря
    // показывался «Активные», хотя карточка уже показывает «Не отвечает» / «Невалидный»).
    if (live && proxy.configured) {
      try { await setAccountMeta(accountId, { proxyWorking: proxy.working, proxyCheckAt: Date.now() }) } catch { /* non-fatal */ }
    }
    // Запоминаем ВЕРДИКТ по сессии: следующее открытие карточки покажет его мгновенно,
    // без похода в сеть. Пишем только когда реально проверяли и не упёрлись в прокси.
    if (live && !blocked) {
      try { await setAccountMeta(accountId, { lastValid: sessionOk, lastValidAt: Date.now() }) } catch { /* non-fatal */ }
    }
  }

  const phone = me?.phone || meta.phone || ''
  const firstName = me?.firstName ?? (meta.name || '').split(' ')[0] ?? ''
  const lastName = me?.lastName ?? (meta.name || '').split(' ').slice(1).join(' ') ?? ''
  const username = me?.username || meta.username || ''
  const premium = me?.premium ?? null
  const geo = (meta.country || countryFromPhone(phone) || '').toUpperCase()

  const addedAt = meta.createdAt || null
  const lastCheckAt = live ? Date.now() : (meta.updatedAt || null)
  const proxyCheckAt = proxy.working != null ? (live ? Date.now() : meta.proxyCheckAt || null) : (meta.proxyCheckAt || null)
  const ageDays = addedAt ? (Date.now() - addedAt) / DAY : 0
  const profileComplete = !!(username && firstName)

  // Статус valid: если удалось живьём — по факту; если занят/нет прокси/прокси мёртв —
  // по meta (последнее известное). Про сессию в этих случаях НИЧЕГО не известно, и
  // объявлять аккаунт невалидным нельзя: причина не в нём.
  // Последнее ИЗВЕСТНОЕ: сначала сохранённый вердикт живой проверки, иначе — по статусу.
  const lastKnownValid = typeof meta.lastValid === 'boolean'
    ? meta.lastValid
    : (meta.status !== 'reauth' && meta.status !== 'invalid')
  // Живой проверки в этом вызове не было (кэш-режим) — не выдумываем вердикт, берём
  // сохранённый. Иначе карточка, открытая без «Проверить», клеймила бы аккаунт невалидным.
  const cachedView = !live && !!sessionStr && !busyIn
  const effectiveStatus = busyIn
    ? (meta.status || 'working')
    : (blocked || cachedView)
      ? (meta.status || 'active')
      : (!sessionStr ? 'reauth' : sessionOk ? 'active' : 'reauth')
  const valid = (busyIn || blocked || cachedView) ? lastKnownValid : sessionOk
  const sessionKnownOk = sessionOk || ((busyIn || blocked || cachedView) ? valid : false)

  // MR-63: свежая проверка (opts.spam) приоритетнее, но только если дала определённый ответ;
  // иначе показываем ПОСЛЕДНИЙ сохранённый результат из meta (а не сбрасываем в «Неизвестно»).
  const freshSpam = proxy._spamblock?.state
  const spamblock = (freshSpam === 'clean' || freshSpam === 'blocked') ? freshSpam : (meta.spamblock || 'unknown')
  const spamblockAt = (freshSpam === 'clean' || freshSpam === 'blocked') ? Date.now() : (meta.spamblockAt || null)
  const warmingDays = addedAt ? Math.max(0, Math.round(ageDays)) : 0
  const warmingActive = busyIn ? true : sessionOk

  const trustResult = accountTrust({ activity, status: effectiveStatus, ageDays, ggr: meta.ggr ?? null })
  // Кэшируем trust для дешёвых проверок (assignment-gate, список) — вне сети.
  try { await setTrustCache(accountId, { score: trustResult.score, band: trustResult.band }) } catch { /* non-fatal */ }

  const health = computeHealth(sessionKnownOk, proxy, effectiveStatus, activity)
  const longevity = computeLongevity({
    ageDays,
    sessionOk: sessionKnownOk,
    profileComplete,
    actionCount,
    hadFloodOrQuarantine,
  })

  return {
    live,
    busyIn,
    switchPause,
    profile: {
      id: me?.id?.toString?.() ?? meta.userId ?? null,
      firstName: firstName || null,
      lastName: lastName || null,
      username: username || null,
      phone: phone ? (phone.startsWith('+') ? phone : `+${phone}`) : null,
      premium,
      geo: geo || null,
      saved: !!sessionStr,
    },
    proxy: {
      id: proxy.id,
      label: proxy.label,
      protocol: proxy.protocol,
      ip: proxy.ip,
      port: proxy.port,
      login: proxy.login,
      configured: proxy.configured,
      working: proxy.configured ? (proxy.working ?? null) : null,
      checkedAt: proxyCheckAt,
      /** Явное состояние для интерфейса: нет прокси / не отвечает / рабочий / не проверялся. */
      state: !proxy.configured ? 'none' : proxy.working === false ? 'down' : proxy.working === true ? 'ok' : 'unknown',
      /** Человеческая причина — вместо «неизвестной ошибки». */
      problem: blocked === 'no_proxy' ? 'Прокси не назначен' : blocked === 'proxy_down' ? 'Прокси не отвечает' : null,
    },
    status: {
      valid,
      /** Данные из базы (живой проверки сейчас не было) — интерфейс предлагает «Проверить». */
      fromCache: cachedView,
      /** Когда проверяли по-настоящему в последний раз. */
      lastValidAt: meta.lastValidAt || null,
      // Почему проверка не доведена до конца (null — доведена).
      checkBlocked: blocked,
      checkNote: blocked === 'no_proxy'
        ? 'Прокси не назначен — аккаунт не проверяли. Назначьте прокси.'
        : blocked === 'proxy_down'
          ? 'Прокси не отвечает — аккаунт не проверяли. Замените прокси.'
          : null,
      sessionOk: sessionKnownOk,
      spamblock,
      spamblockText: proxy._spamblock?.text || meta.spamblockText || null,
      spamblockAt, // MR-63: когда спамблок проверяли в последний раз (для «Проверено: дата»)
      warmingDays,
      warmingActive,
      accountStatus: effectiveStatus,
    },
    dates: {
      addedAt,
      lastCheckAt,
      proxyCheckAt,
      spamblockAt, // MR-63
    },
    health,
    longevity,
    trust: trustResult,
    activity,
    role: meta.role || null,
    note: meta.note || '',
  }
}

/**
 * Список каналов/групп аккаунта (по диалогам). Уважает блокировку.
 * @param {string} accountId
 */
export async function listAccountChannels(accountId) {
  const lock = getAccountLock(accountId)
  if (lock) return { busy: true, busyIn: { moduleLabel: lock.moduleLabel }, channels: [] }
  const sessionStr = await loadSessionString(accountId)
  if (!sessionStr) return { busy: false, channels: [], error: 'no_session' }
  const meta = await getAccountMeta(accountId)
  let client
  try {
    client = await createClient(sessionStr, await accountProxyUrl(meta), accountFingerprint(accountId, meta))
    const dialogs = await client.getDialogs({ limit: 200 })
    const channels = []
    for (const d of dialogs) {
      const e = d.entity
      if (!e) continue
      const isBroadcast = !!e.broadcast
      const isMegagroup = !!e.megagroup
      const isChannelLike = e.className === 'Channel' || isBroadcast || isMegagroup
      if (!isChannelLike) continue
      channels.push({
        id: e.id?.toString?.() ?? '',
        title: e.title || d.title || d.name || '—',
        username: e.username || e.usernames?.[0]?.username || '',
        members: Number(e.participantsCount ?? 0) || null,
        kind: isBroadcast && !isMegagroup ? 'channel' : 'group',
        unread: d.unreadCount || 0,
      })
    }
    await client.disconnect()
    channels.sort((a, b) => (b.members || 0) - (a.members || 0))
    return { busy: false, channels }
  } catch (err) {
    try { if (client) await client.disconnect() } catch { /* ignore */ }
    return { busy: false, channels: [], error: err instanceof Error ? err.message : 'error' }
  }
}

/**
 * MR-129: аккаунт выходит из канала/группы прямо из карточки («Каналы»).
 * accessHash у нас нет — резолвим сущность через getDialogs (как в списке) и выходим.
 * @param {string} accountId @param {string} channelId
 */
export async function leaveAccountChannel(accountId, channelId) {
  if (getAccountLock(accountId)) return { ok: false, error: 'busy' }
  const sessionStr = await loadSessionString(accountId)
  if (!sessionStr) return { ok: false, error: 'no_session' }
  const meta = await getAccountMeta(accountId)
  let client
  try {
    client = await createClient(sessionStr, await accountProxyUrl(meta), accountFingerprint(accountId, meta))
    const dialogs = await client.getDialogs({ limit: 300 })
    const d = dialogs.find((x) => x.entity && x.entity.id?.toString?.() === String(channelId))
    if (!d || !d.entity) { await client.disconnect(); return { ok: false, error: 'not_found' } }
    const e = d.entity
    if (e.className === 'Chat') {
      const me = await client.getMe()
      await client.invoke(new Api.messages.DeleteChatUser({ chatId: e.id, userId: me.id }))
    } else {
      await client.invoke(new Api.channels.LeaveChannel({ channel: e }))
    }
    await client.disconnect()
    return { ok: true }
  } catch (err) {
    try { if (client) await client.disconnect() } catch { /* ignore */ }
    return { ok: false, error: err instanceof Error ? err.message : 'error' }
  }
}

/**
 * MR-164: последние сообщения канала/группы аккаунта — для просмотра переписки прямо из
 * карточки (клик по каналу во вкладке «Каналы»). accessHash у нас нет, поэтому резолвим
 * сущность через getDialogs (как в leave/list). Это ЖИВАЯ Telegram-операция: подключение
 * сессией через прокси аккаунта, поэтому уважаем блокировку и мёртвый прокси падает ошибкой.
 * @param {string} accountId @param {string} peer id или @username канала/группы @param {number} limit
 */
export async function listAccountChannelMessages(accountId, peer, limit = 30) {
  const lock = getAccountLock(accountId)
  if (lock) return { busy: true, busyIn: { moduleLabel: lock.moduleLabel }, messages: [] }
  const sessionStr = await loadSessionString(accountId)
  if (!sessionStr) return { busy: false, messages: [], error: 'no_session' }
  const meta = await getAccountMeta(accountId)
  let client
  try {
    client = await createClient(sessionStr, await accountProxyUrl(meta), accountFingerprint(accountId, meta))
    const dialogs = await client.getDialogs({ limit: 300 })
    const uname = String(peer || '').replace(/^@/, '')
    const d = dialogs.find((x) => x.entity && (x.entity.id?.toString?.() === String(peer) || x.entity.username === uname || x.entity.usernames?.some?.((u) => u.username === uname)))
    if (!d || !d.entity) { await client.disconnect(); return { busy: false, messages: [], error: 'not_found' } }
    const title = d.entity.title || d.title || d.name || ''
    const msgs = await client.getMessages(d.entity, { limit: Math.min(50, Math.max(1, Number(limit) || 30)) })
    const messages = []
    for (const m of msgs || []) {
      const text = m.message || m.text || ''
      if (!text && !m.media) continue
      messages.push({
        id: m.id,
        text: String(text).slice(0, 2000),
        date: m.date ? Number(m.date) * 1000 : Date.now(),
        out: !!m.out,
        hasMedia: !!m.media,
        sender: m.postAuthor || (m.sender ? (m.sender.firstName || m.sender.title || '') : ''),
      })
    }
    await client.disconnect()
    messages.reverse() // старые сверху, свежие снизу — как в обычной переписке
    return { busy: false, title, messages }
  } catch (err) {
    try { if (client) await client.disconnect() } catch { /* ignore */ }
    return { busy: false, messages: [], error: err instanceof Error ? err.message : 'error' }
  }
}

/**
 * Список папок (dialog filters) аккаунта. Уважает блокировку.
 * @param {string} accountId
 */
export async function listAccountFolders(accountId) {
  const lock = getAccountLock(accountId)
  if (lock) return { busy: true, busyIn: { moduleLabel: lock.moduleLabel }, folders: [] }
  const sessionStr = await loadSessionString(accountId)
  if (!sessionStr) return { busy: false, folders: [], error: 'no_session' }
  const meta = await getAccountMeta(accountId)
  let client
  try {
    client = await createClient(sessionStr, await accountProxyUrl(meta), accountFingerprint(accountId, meta))
    const res = await client.invoke(new Api.messages.GetDialogFilters())
    const filters = res?.filters || res || []
    const folders = []
    for (const f of filters) {
      if (f.className === 'DialogFilterDefault') continue
      const title = typeof f.title === 'string' ? f.title : (f.title?.text ?? '')
      folders.push({
        id: f.id ?? null,
        title: title || 'Без названия',
        included: Array.isArray(f.includePeers) ? f.includePeers.length : 0,
        pinned: Array.isArray(f.pinnedPeers) ? f.pinnedPeers.length : 0,
      })
    }
    await client.disconnect()
    return { busy: false, folders }
  } catch (err) {
    try { if (client) await client.disconnect() } catch { /* ignore */ }
    return { busy: false, folders: [], error: err instanceof Error ? err.message : 'error' }
  }
}
