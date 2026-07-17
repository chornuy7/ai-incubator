/** CRUD-роуты сущности «Прокси» (§3.2/3.4). Монтируется в /api/proxies. */
import { Router } from 'express'
import { listProxies, getProxy, createProxy, updateProxy, deleteProxy, checkProxyLiveness, checkAllProxies, sharedProxies, probeProxyGeo, tcpPing } from './proxies.js'
import { loadAllMeta } from './accountsMeta.js'
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

// §6: прокси, назначенные >1 аккаунту (нарушение «1 прокси = 1 аккаунт»). До GET /:id.
proxiesRouter.get('/shared', async (_req, res) => {
  try {
    res.json({ ok: true, shared: sharedProxies(await loadAllMeta()) })
  } catch (err) { fail(res, err, 500) }
})

// §6: авто-проверка живости — все / один.
proxiesRouter.post('/check-all', async (_req, res) => {
  try {
    const results = await checkAllProxies()
    await appendAudit({ action: 'proxy.check', module: 'proxy', initiator: 'operator', reason: `Проверка живости: ${results.length} прокси`, meta: { alive: results.filter((r) => r.status === 'ok').length } })
    res.json({ ok: true, results })
  } catch (err) { fail(res, err, 500) }
})

// Реальная проверка прокси по host:port ДО сохранения (TCP-пинг + гео). До /:id.
proxiesRouter.post('/probe', async (req, res) => {
  try {
    const { host, port } = req.body ?? {}
    if (!host || !port) return res.status(400).json({ ok: false, error: 'Укажите host и port' })
    const started = Date.now()
    const alive = await tcpPing(String(host), Number(port))
    const ms = Date.now() - started
    const geo = alive ? await probeProxyGeo(String(host)) : null
    res.json({ ok: true, alive, ms, geo })
  } catch (err) { fail(res, err, 500) }
})

proxiesRouter.post('/:id/check', async (req, res) => {
  try {
    const proxy = await checkProxyLiveness(req.params.id)
    if (!proxy) return res.status(404).json({ ok: false, error: 'Прокси не найден' })
    // Живой прокси — дополнительно определяем страну/город по IP (§3.4).
    const geo = proxy.status === 'ok' ? await probeProxyGeo(proxy.host) : null
    res.json({ ok: true, proxy, geo })
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
