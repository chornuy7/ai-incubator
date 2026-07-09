/** Реальная статистика аккаунта для модалки «Управление аккаунтом». */
import { getAccountMeta } from './accountsMeta.js'
import { loadSessionString, createClient } from './tgAuth.js'
import { parseProxy } from './proxy.js'
import { getAccountLock } from './lib/accountLocks.js'
import { countryFromPhone } from './accountsMeta.js'
import { Api } from 'telegram/tl/index.js'

const DAY = 24 * 60 * 60 * 1000

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Разобрать строку прокси в структурированный вид (без секретов пароля). */
function describeProxy(raw) {
  if (!raw || raw === '—') {
    return { raw: '', protocol: null, ip: null, port: null, login: null, configured: false }
  }
  const parsed = parseProxy(raw)
  let protocol = null
  try {
    protocol = new URL(raw).protocol.replace(':', '').toUpperCase()
  } catch { /* ignore */ }
  return {
    raw,
    protocol: protocol || (parsed?.socksType ? `SOCKS${parsed.socksType}` : parsed ? 'HTTP' : null),
    ip: parsed?.ip ?? null,
    port: parsed?.port ?? null,
    login: parsed?.username ?? null,
    configured: !!parsed,
  }
}

/**
 * Проверка спамблока через @SpamBot (побочный эффект: отправляет /start).
 * @param {import('telegram').TelegramClient} client
 */
export async function checkSpamblock(client) {
  try {
    const bot = await client.getEntity('SpamBot')
    await client.sendMessage(bot, { message: '/start' })
    await sleep(2500)
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
export async function buildAccountStats(accountId, opts = {}) {
  const meta = await getAccountMeta(accountId)
  const sessionStr = await loadSessionString(accountId)
  const lock = getAccountLock(accountId)
  const busyIn = lock ? { moduleKey: lock.moduleKey, taskId: lock.taskId, moduleLabel: lock.moduleLabel } : null

  const proxy = describeProxy(meta.proxy)
  const activity = await collectActivity(accountId, meta.name || '', 40)
  const actionCount = activity.filter((e) => e.type === 'action').length
  const hadFloodOrQuarantine = activity.some((e) => /flood|карантин|quarantine/i.test(e.label)) || meta.status === 'quarantine'

  let me = null
  let sessionOk = false
  let live = false

  // Не трогаем аккаунт по сети, если он занят активной задачей — отдаём кэш из meta.
  if (sessionStr && !busyIn) {
    let client
    try {
      client = await createClient(sessionStr, meta.proxy)
      me = await client.getMe()
      sessionOk = true
      live = true
      if (proxy.configured) proxy.working = true
      if (opts.spam) {
        const sb = await checkSpamblock(client)
        proxy._spamblock = sb
      }
      await client.disconnect()
    } catch {
      sessionOk = false
      live = true
      if (proxy.configured) proxy.working = false
      try { if (client) await client.disconnect() } catch { /* ignore */ }
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

  // Статус valid: если удалось живьём — по факту; если занят/нет сессии — по meta.
  const effectiveStatus = busyIn ? (meta.status || 'working') : (!sessionStr ? 'reauth' : sessionOk ? 'active' : 'reauth')
  const valid = busyIn ? meta.status !== 'reauth' && meta.status !== 'invalid' : sessionOk

  const spamblock = proxy._spamblock?.state || 'unknown'
  const warmingDays = addedAt ? Math.max(0, Math.round(ageDays)) : 0
  const warmingActive = busyIn ? true : sessionOk

  const health = computeHealth(sessionOk || (busyIn ? valid : false), proxy, effectiveStatus, activity)
  const longevity = computeLongevity({
    ageDays,
    sessionOk: sessionOk || (busyIn ? valid : false),
    profileComplete,
    actionCount,
    hadFloodOrQuarantine,
  })

  return {
    live,
    busyIn,
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
      raw: proxy.raw,
      protocol: proxy.protocol,
      ip: proxy.ip,
      port: proxy.port,
      login: proxy.login,
      configured: proxy.configured,
      working: proxy.configured ? (proxy.working ?? null) : null,
      checkedAt: proxyCheckAt,
    },
    status: {
      valid,
      sessionOk: sessionOk || (busyIn ? valid : false),
      spamblock,
      spamblockText: proxy._spamblock?.text || null,
      warmingDays,
      warmingActive,
      accountStatus: effectiveStatus,
    },
    dates: {
      addedAt,
      lastCheckAt,
      proxyCheckAt,
    },
    health,
    longevity,
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
    client = await createClient(sessionStr, meta.proxy)
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
    client = await createClient(sessionStr, meta.proxy)
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
