/** CRUD-роуты сущности «Прокси» (§3.2/3.4). Монтируется в /api/proxies. */
import { Router } from 'express'
import { listProxies, getProxy, createProxy, updateProxy, deleteProxy } from './proxies.js'
import { appendAudit } from './lib/auditLog.js'

export const proxiesRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

proxiesRouter.get('/', async (_req, res) => {
  try {
    res.json({ ok: true, proxies: await listProxies() })
  } catch (err) { fail(res, err, 500) }
})

proxiesRouter.get('/:id', async (req, res) => {
  try {
    const proxy = await getProxy(req.params.id)
    if (!proxy) return res.status(404).json({ ok: false, error: 'Прокси не найден' })
    res.json({ ok: true, proxy })
  } catch (err) { fail(res, err, 500) }
})

proxiesRouter.post('/', async (req, res) => {
  try {
    const proxy = await createProxy(req.body ?? {})
    await appendAudit({ action: 'proxy.create', module: 'proxy', initiator: 'operator', reason: `Добавлен прокси ${proxy.host}:${proxy.port}`, meta: { proxyId: proxy.id, kind: proxy.kind } })
    res.json({ ok: true, proxy })
  } catch (err) { fail(res, err) }
})

proxiesRouter.put('/:id', async (req, res) => {
  try {
    const proxy = await updateProxy(req.params.id, req.body ?? {})
    if (!proxy) return res.status(404).json({ ok: false, error: 'Прокси не найден' })
    res.json({ ok: true, proxy })
  } catch (err) { fail(res, err) }
})

proxiesRouter.delete('/:id', async (req, res) => {
  try {
    const ok = await deleteProxy(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Прокси не найден' })
    await appendAudit({ action: 'proxy.delete', module: 'proxy', initiator: 'operator', reason: 'Удалён прокси', meta: { proxyId: req.params.id } })
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})
