/** Роуты «Каналы» (§3.7/§3.9): база каналов + ручное обновление статистики. Монтируется в /api/channels. */
import { Router } from 'express'
import { listChannels, getChannel, upsertChannel, recordChannelStats, deleteChannel } from './channels.js'
import { loadAllMeta } from './accountsMeta.js'
import { acquireChannelLease, releaseChannelLease } from './lib/channelLease.js'
import { normalizeStatus } from './lib/accountStatus.js'

export const channelsRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

channelsRouter.get('/', async (_req, res) => {
  try { res.json({ ok: true, channels: await listChannels() }) } catch (err) { fail(res, err, 500) }
})

channelsRouter.post('/', async (req, res) => {
  try {
    const { source, ...channel } = req.body ?? {}
    res.json({ ok: true, channel: await upsertChannel(channel, source) })
  } catch (err) { fail(res, err) }
})

channelsRouter.delete('/:id', async (req, res) => {
  try {
    const ok = await deleteChannel(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Канал не найден' })
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})

/**
 * «Обновить сейчас» (§3.9): свободный аккаунт по lease тянет актуальную статистику канала.
 * Один канал — один бот в моменте (lease). Нужен рабочий аккаунт с сессией.
 */
channelsRouter.post('/:id/refresh', async (req, res) => {
  const channel = await getChannel(req.params.id)
  if (!channel) return res.status(404).json({ ok: false, error: 'Канал не найден' })

  // Свободный рабочий аккаунт (не в прогреве/карантине), приоритет — из тела запроса.
  const meta = await loadAllMeta()
  let accountId = req.body?.accountId
  if (!accountId) {
    accountId = Object.keys(meta).find((id) => {
      const m = meta[id] || {}
      return !m.inTrash && normalizeStatus(m.status) === 'active'
    })
  }
  if (!accountId) return res.status(400).json({ ok: false, error: 'Нет свободного рабочего аккаунта для обновления' })

  const leaseErr = acquireChannelLease(channel.id, accountId, 'stats-manual', 60_000)
  if (leaseErr) return res.status(409).json({ ok: false, error: `Канал уже обновляет ${leaseErr.by}` })

  let client
  try {
    const { loadSessionString, createClient } = await import('./tgAuth.js')
    const { resolvePeer, getChannelMembersCount } = await import('./lib/gramHelpers.js')
    const sessionStr = await loadSessionString(accountId)
    if (!sessionStr) throw new Error('У аккаунта нет сессии')
    client = await createClient(sessionStr, meta[accountId]?.proxy)
    const entity = await resolvePeer(client, channel.username || channel.link || channel.tgPeerId)
    const subscribers = await getChannelMembersCount(client, entity)
    const updated = await recordChannelStats(channel.id, { subscribers }, accountId)
    res.json({ ok: true, channel: updated })
  } catch (err) {
    fail(res, err)
  } finally {
    releaseChannelLease(channel.id, 'stats-manual')
    if (client) { try { await client.disconnect() } catch { /* ignore */ } }
  }
})
