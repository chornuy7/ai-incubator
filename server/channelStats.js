/**
 * Авто-обновление статистики каналов (§3.9, решение 14.07):
 * раз в день; если бот в группе (channel.botInGroup) — авто ~раз в час; + ручная кнопка.
 * Один канал — один бот в моменте (lease). Рефреш и планировщик здесь; ручной вызов — из роута.
 */
import { recordChannelStats } from './channels.js'
import { acquireChannelLease, releaseChannelLease } from './lib/channelLease.js'
import { normalizeStatus } from './lib/accountStatus.js'

const HOUR = 3600_000
const DEFAULT_PERIOD_H = 24

/** Свободный рабочий аккаунт (active, не в корзине), не из exclude. Чистая. */
export function pickFreeAccountId(meta = {}, exclude = new Set()) {
  return Object.keys(meta).find((id) => {
    const m = meta[id] || {}
    return !m.inTrash && normalizeStatus(m.status) === 'active' && !exclude.has(id)
  }) || null
}

/**
 * Какие каналы пора обновить: ни разу (lastStatsAt пуст) или старше периода.
 * Период: botInGroup → 1 час, иначе DEFAULT_PERIOD_H. Чистая функция.
 * @param {object[]} channels @param {number} [now] @param {number} [defaultPeriodH]
 */
export function dueChannels(channels = [], now = Date.now(), defaultPeriodH = DEFAULT_PERIOD_H) {
  return channels.filter((c) => {
    if (!c.lastStatsAt) return true
    const periodMs = (c.botInGroup ? 1 : defaultPeriodH) * HOUR
    return now - c.lastStatsAt >= periodMs
  })
}

/**
 * Из дат постов (unix сек) → метка активности + время последнего поста. Чистая функция
 * (2-й проход статистики). @param {number[]} dates @param {number} [now]
 * @returns {{ activity: string, lastPostAt: number|null }}
 */
export function activityFromDates(dates = [], now = Date.now()) {
  const clean = (Array.isArray(dates) ? dates : []).map(Number).filter((d) => d > 0)
  if (!clean.length) return { activity: 'stale', lastPostAt: null }
  const lastPostAt = Math.max(...clean) * 1000
  const weekAgo = now - 7 * 24 * HOUR
  const recent = clean.filter((d) => d * 1000 >= weekAgo).length
  const activity = recent >= 5 ? 'high' : recent >= 1 ? 'medium' : 'low'
  return { activity, lastPostAt }
}

/**
 * Обновить статистику одного канала свободным аккаунтом по lease. Нужны сессии.
 * ДВА ПРОХОДА (§3.9): (1) база — подписчики; (2) активность — свежесть контента
 * (последний пост + частота за неделю). Второй проход не критичен: его сбой не рушит первый.
 * @param {object} channel @param {Record<string,object>} meta @param {string} [accountId]
 */
export async function refreshOneChannel(channel, meta, accountId) {
  const acc = accountId || pickFreeAccountId(meta)
  if (!acc) throw new Error('Нет свободного рабочего аккаунта')
  const leaseErr = acquireChannelLease(channel.id, acc, 'stats', 60_000)
  if (leaseErr) throw new Error(`Канал уже обновляет ${leaseErr.by}`)
  let client
  try {
    const { loadSessionString, createClient } = await import('./tgAuth.js')
    const { resolvePeer, getChannelMembersCount, fetchPosts } = await import('./lib/gramHelpers.js')
    const sessionStr = await loadSessionString(acc)
    if (!sessionStr) throw new Error('У аккаунта нет сессии')
    client = await createClient(sessionStr, meta[acc]?.proxy)
    const entity = await resolvePeer(client, channel.username || channel.link || channel.tgPeerId)

    // Проход 1 — база: подписчики.
    const subscribers = await getChannelMembersCount(client, entity)

    // Проход 2 — активность: последний пост + метка свежести (некритичен).
    let enrich = {}
    try {
      const posts = await fetchPosts(client, entity, 12)
      const a = activityFromDates(posts.map((p) => Number(p.date)))
      enrich = { activityLabel: a.activity, lastPostAt: a.lastPostAt }
    } catch { /* второй проход опционален */ }

    return await recordChannelStats(channel.id, { subscribers, ...enrich }, acc)
  } finally {
    releaseChannelLease(channel.id, 'stats')
    if (client) { try { await client.disconnect() } catch { /* ignore */ } }
  }
}

/** Один тик авто-обновления: обновляет до N просроченных каналов разными аккаунтами. */
export async function channelStatsTick(maxPerTick = 5) {
  try {
    const { listChannels } = await import('./channels.js')
    const { loadAllMeta } = await import('./accountsMeta.js')
    const due = dueChannels(await listChannels())
    if (!due.length) return 0
    const meta = await loadAllMeta()
    const used = new Set()
    let done = 0
    for (const ch of due) {
      if (done >= maxPerTick) break
      const acc = pickFreeAccountId(meta, used)
      if (!acc) break
      used.add(acc)
      try { await refreshOneChannel(ch, meta, acc); done++ } catch { /* канал пропускаем */ }
    }
    if (done) console.log(`[stats] авто-обновлено каналов: ${done}`)
    return done
  } catch {
    return 0
  }
}

let statsTimer = null
/** Запустить авто-обновление (интервал по умолчанию 15 мин; тик сам решает, что просрочено). */
export function startChannelStatsScheduler(intervalMs = 15 * 60_000) {
  if (statsTimer) clearInterval(statsTimer)
  statsTimer = setInterval(() => { void channelStatsTick() }, intervalMs)
  setTimeout(() => { void channelStatsTick() }, 30_000)
  console.log('[stats] авто-обновление статистики каналов включено')
}

export function stopChannelStatsScheduler() {
  if (statsTimer) clearInterval(statsTimer)
  statsTimer = null
}
