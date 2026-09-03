/** Роуты «Каналы» (§3.7/§3.9): база каналов + ручное обновление статистики. Монтируется в /api/channels. */
import { Router } from 'express'
import { listChannels, getChannel, upsertChannel, updateChannel, deleteChannel } from './channels.js'
import { loadAllMeta } from './accountsMeta.js'
import { refreshOneChannel } from './channelStats.js'

export const channelsRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

// Аудит 20.08: база каналов отдавалась целиком любому — клиент видел, какие ниши парсили
// другие. База остаётся ОБЩЕЙ (дедуп, одна статистика на канал), но клиент видит только то,
// что нашли ЕГО прогоны парсинга — см. channelsForRequest.
channelsRouter.get('/', async (req, res) => {
  try {
    const { channelsForRequest } = await import('./lib/accessGuard.js')
    res.json({ ok: true, channels: await channelsForRequest(req, await listChannels()) })
  } catch (err) { fail(res, err, 500) }
})

channelsRouter.post('/', async (req, res) => {
  try {
    const { source, ...channel } = req.body ?? {}
    res.json({ ok: true, channel: await upsertChannel(channel, source) })
  } catch (err) { fail(res, err) }
})

/**
 * База каналов ОБЩАЯ по замыслу (решение заказчика 20.08: дедуп, одна статистика на
 * канал — см. `channelsForRequest`). Модель не меняем, но именно из-за общности правка
 * и удаление по id были опаснее обычной утечки: один клиент переписывал или сносил
 * запись, которой пользуются ВСЕ остальные, и восстановить её мог только повторный
 * парсинг. Поэтому редактирование общей записи — за администратором.
 */
async function denyIfNotAdmin(req, res) {
  const { isAdminRequest } = await import('./lib/accessGuard.js')
  if (await isAdminRequest(req)) return false
  res.status(403).json({ ok: false, error: 'База каналов общая — править и удалять записи может только администратор' })
  return true
}

channelsRouter.put('/:id', async (req, res) => {
  try {
    if (await denyIfNotAdmin(req, res)) return
    const channel = await updateChannel(req.params.id, req.body ?? {})
    if (!channel) return res.status(404).json({ ok: false, error: 'Канал не найден' })
    res.json({ ok: true, channel })
  } catch (err) { fail(res, err) }
})

channelsRouter.delete('/:id', async (req, res) => {
  try {
    if (await denyIfNotAdmin(req, res)) return
    const ok = await deleteChannel(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Канал не найден' })
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})

/** «Обновить сейчас» (§3.9): свободный аккаунт по lease тянет актуальную статистику. */
channelsRouter.post('/:id/refresh', async (req, res) => {
  try {
    const channel = await getChannel(req.params.id)
    if (!channel) return res.status(404).json({ ok: false, error: 'Канал не найден' })
    // Аккаунт для обновления приходит из тела запроса: без проверки статистика канала
    // собиралась бы ЧУЖИМ Telegram-аккаунтом — его руками, его лимитами и его риском
    // словить флуд-вейт за наш запрос.
    const accountId = req.body?.accountId
    if (accountId) {
      const { canSeeAccount } = await import('./lib/accessGuard.js')
      if (!(await canSeeAccount(req, String(accountId)))) {
        return res.status(403).json({ ok: false, error: 'Это не ваш аккаунт' })
      }
    }
    const meta = await loadAllMeta()
    const updated = await refreshOneChannel(channel, meta, accountId)
    res.json({ ok: true, channel: updated })
  } catch (err) { fail(res, err) }
})
