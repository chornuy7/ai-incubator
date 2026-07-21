/** CRUD-роуты сущности «Прокси» (§3.2/3.4). Монтируется в /api/proxies. */
import { Router } from 'express'
import { listProxies, getProxy, createProxy, updateProxy, deleteProxy, checkAllProxies, sharedProxies, probeProxyGeo, probeProxyExitGeo, tcpPing } from './proxies.js'
import { loadAllMeta } from './accountsMeta.js'
import { parseProxyList, proxyKey, assignLabels } from './lib/proxyImport.js'
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

// Реальная проверка прокси по host:port ДО сохранения (TCP-пинг + гео выхода). До /:id.
proxiesRouter.post('/probe', async (req, res) => {
  try {
    const { host, port, scheme, username, password } = req.body ?? {}
    if (!host || !port) return res.status(400).json({ ok: false, error: 'Укажите host и port' })
    const started = Date.now()
    const alive = await tcpPing(String(host), Number(port))
    const ms = Date.now() - started
    // Гео ВЫХОДНОГО IP (через прокси); если не удалось — гео адреса шлюза как запасной вариант.
    let geo = null, geoSource = null
    if (alive) {
      geo = await probeProxyExitGeo({ host, port, scheme, username, password })
      if (geo) geoSource = 'exit'
      else { geo = await probeProxyGeo(String(host)); if (geo) geoSource = 'gateway' }
    }
    res.json({ ok: true, alive, ms, geo, geoSource })
  } catch (err) { fail(res, err, 500) }
})

proxiesRouter.post('/:id/check', async (req, res) => {
  try {
    const existing = await getProxy(req.params.id)
    if (!existing) return res.status(404).json({ ok: false, error: 'Прокси не найден' })
    // Пинг с замером времени + статус.
    const t0 = Date.now()
    const alive = await tcpPing(existing.host, existing.port)
    const ms = Date.now() - t0
    let proxy = (await updateProxy(existing.id, { status: alive ? 'ok' : 'dead', lastCheckAt: Date.now() })) || existing
    // Гео ВЫХОДНОГО IP (через прокси) — для мобильных/резидентных это страна выхода, а не шлюза.
    // Если через прокси не удалось — гео адреса шлюза как запасной вариант (§3.4).
    let geo = null, geoSource = null
    if (proxy.status === 'ok') {
      geo = await probeProxyExitGeo(proxy)
      if (geo) geoSource = 'exit'
      else { geo = await probeProxyGeo(proxy.host); if (geo) geoSource = 'gateway' }
    }
    // Страна выставляется автоматически из гео (руками выбирать не нужно).
    if (geo?.country && geo.country !== proxy.country) {
      proxy = (await updateProxy(proxy.id, { country: geo.country })) || proxy
    }
    res.json({ ok: true, proxy, geo, geoSource, ms: alive ? ms : null })
  } catch (err) { fail(res, err, 500) }
})

// ── §3.2: массовый импорт. Объявлено ДО '/:id', иначе путь затенится. ──────────

/** Разобрать список без сети — показать человеку, что понято, до записи в базу. */
proxiesRouter.post('/import/preview', async (req, res) => {
  try {
    const { text, scheme } = req.body ?? {}
    const { items, errors } = parseProxyList(text, { scheme })
    const existing = await listProxies()
    const known = new Set(existing.map(proxyKey))
    const fresh = items.filter((i) => !known.has(proxyKey(i)))
    const dupes = items.length - fresh.length
    res.json({ ok: true, items: fresh, errors, total: items.length, duplicates: dupes })
  } catch (err) { fail(res, err) }
})

/** Выполнить N задач пачками по `size` — чтобы не открыть сотню сокетов разом. */
async function inBatches(list, size, fn) {
  const out = []
  for (let i = 0; i < list.length; i += size) {
    out.push(...await Promise.all(list.slice(i, i + size).map(fn)))
  }
  return out
}

/**
 * §3.2: массовый импорт прокси. Страна определяется САМА — по реальному выходному IP
 * (для мобильных/резидентных шлюз врёт), имя собирается по шаблону «USA SPAM 1»
 * с продолжением нумерации от уже существующих.
 */
proxiesRouter.post('/import', async (req, res) => {
  try {
    const { text, scheme, kind, tag = '', template = '{country} {tag} {n}', probe = true, note = '' } = req.body ?? {}
    const { items, errors } = parseProxyList(text, { scheme })
    if (!items.length) return res.status(400).json({ ok: false, error: 'Не разобрано ни одной строки', errors })

    const existing = await listProxies()
    const known = new Set(existing.map(proxyKey))
    const skipped = items.filter((i) => known.has(proxyKey(i))).map((i) => ({ raw: i.raw, reason: 'уже есть в базе' }))
    const fresh = items.filter((i) => !known.has(proxyKey(i)))

    // Живость + страна выхода. Без probe импорт мгновенный, но страна остаётся неизвестной.
    const probed = probe
      ? await inBatches(fresh, 8, async (p) => {
        const alive = await tcpPing(p.host, p.port)
        let geo = null, geoSource = null
        if (alive) {
          geo = await probeProxyExitGeo(p)
          if (geo) geoSource = 'exit'
          else { geo = await probeProxyGeo(p.host); if (geo) geoSource = 'gateway' }
        }
        return { ...p, status: alive ? 'ok' : 'dead', country: geo?.country || '', geo, geoSource }
      })
      : fresh.map((p) => ({ ...p, status: 'unknown', country: '', geo: null, geoSource: null }))

    const labels = assignLabels(probed, { template, tag, existingLabels: existing.map((p) => p.label) })
    const created = []
    for (let i = 0; i < probed.length; i++) {
      const p = probed[i]
      try {
        created.push(await createProxy({
          label: labels[i], kind, scheme: p.scheme, host: p.host, port: p.port,
          username: p.username, password: p.password, country: p.country, status: p.status,
          note: [note, p.geo?.isp ? `${p.geo.countryName || ''} ${p.geo.city || ''} · ${p.geo.isp}`.trim() : ''].filter(Boolean).join(' · '),
        }))
      } catch (e) {
        errors.push({ raw: p.raw, reason: e instanceof Error ? e.message : 'не сохранён' })
      }
    }

    await appendAudit({
      action: 'proxy.import', module: 'proxy', initiator: 'operator',
      reason: `Импорт прокси: добавлено ${created.length}, пропущено ${skipped.length}, ошибок ${errors.length}`,
      meta: { created: created.length, skipped: skipped.length, errors: errors.length, tag },
    }).catch(() => {})

    res.json({
      ok: true, created, skipped, errors,
      alive: created.filter((p) => p.status === 'ok').length,
      dead: created.filter((p) => p.status === 'dead').length,
    })
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
