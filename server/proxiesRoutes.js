/** CRUD-роуты сущности «Прокси» (§3.2/3.4). Монтируется в /api/proxies. */
import { Router } from 'express'
import { listProxies, getProxy, createProxy, updateProxy, deleteProxy, deleteProxies, checkAllProxies, sharedProxies, probeProxy, geoNote, tcpPing, toProxyUrl } from './proxies.js'
import { loadAllMeta } from './accountsMeta.js'
import { parseProxyList, proxyKey, assignLabels } from './lib/proxyImport.js'
import { appendAudit } from './lib/auditLog.js'

export const proxiesRouter = Router()

function fail(res, err, code = 400) {
  res.status(code).json({ ok: false, error: err instanceof Error ? err.message : 'Ошибка' })
}

// Аудит 20.08 (инспектор): каталог отдавался ЛЮБОМУ залогиненному вместе с логинами и
// паролями прокси («password»:«…»). Теперь — только свои (админ видит все); записи без
// владельца — легаси, их видит только админ.
proxiesRouter.get('/', async (req, res) => {
  try {
    // Дубли разрешены: к каждому прокси добавляем счётчик `usedBy` — на скольких
    // аккаунтах он висит (раньше это считалось нарушением, теперь — норма §6-обновл.).
    /*
     * «Занят N аккаунтами» считает база — по тому же представлению, что и менеджер.
     *
     * Здесь читалась строка сессии ПО КАЖДОМУ аккаунту: шестьдесят три обращения к базе
     * ради одного бита («есть ли сессия»), из-за чего страница открывалась две с
     * половиной секунды. Само условие вдобавок было неверным — аккаунт без живой сессии
     * никуда не делся, прокси у него занят, и в менеджере он теперь виден.
     */
    const { ownedForRequest } = await import('./lib/accessGuard.js')
    const { proxyUsage } = await import('./accountsList.js')
    const { accountScope } = await import('./lib/accountAccess.js')
    const scope = await accountScope(req)
    const [allProxies, usage] = await Promise.all([
      listProxies(),
      proxyUsage(scope.kind === 'all' ? null : scope.ownerId).catch(() => ({})),
    ])
    const proxies = await ownedForRequest(req, allProxies, (p) => p?.ownerId)
    res.json({ ok: true, proxies: proxies.map((p) => ({ ...p, usedBy: usage[p.id] || 0 })) })
  } catch (err) { fail(res, err, 500) }
})

/**
 * Каталог прокси СТРАНИЦАМИ.
 *
 * POST, а не GET: у запроса фильтр, поиск и постраничность — это тело, а не строка
 * адреса. Тот же контракт, что у списка аккаунтов, чтобы страницы вели себя одинаково.
 *
 * Отбор по владельцу уезжает В запрос: фильтровать после выборки страницы значит показать
 * страницу, где половина строк вычеркнута, и счётчик «всего» по чужому каталогу.
 */
proxiesRouter.post('/list', async (req, res) => {
  try {
    const { ownerScopeForRequest } = await import('./lib/accessGuard.js')
    const scope = await ownerScopeForRequest(req)
    if (scope.blocked) {
      return res.json({ ok: true, items: [], page: { number: 1, size: 25, total: 0, pages: 1 }, counts: { all: 0, ok: 0, broken: 0, unknown: 0 } })
    }
    const b = req.body ?? {}
    const { listProxiesPage } = await import('./proxies.js')
    const { proxyUsage } = await import('./accountsList.js')
    const ownerId = scope.all ? null : scope.ownerId
    const [страница, usage] = await Promise.all([
      listProxiesPage({ page: b.page, pageSize: b.pageSize, search: b.search, status: b.status, ownerId }),
      proxyUsage(ownerId).catch(() => ({})),
    ])
    res.json({
      ok: true,
      ...страница,
      items: страница.items.map((p) => ({ ...p, usedBy: usage[p.id] || 0 })),
    })
  } catch (err) { fail(res, err, 500) }
})

// §6: прокси, назначенные >1 аккаунту. До GET /:id.
proxiesRouter.get('/shared', async (req, res) => {
  try {
    /*
     * Считаем только по своим аккаунтам: сводка строится из метаданных всех аккаунтов
     * платформы и показывала, какие прокси и к скольким чужим профилям привязаны.
     *
     * Область видимости считается ОДИН раз. Здесь стоял `canSeeAccount` в цикле, а внутри
     * неё — чтение пользователя, владельца подписки, всей таблицы меты, ролей и групп.
     */
    const { accountScope, filterAccountMap } = await import('./lib/accountAccess.js')
    const all = await loadAllMeta()
    const mine = await filterAccountMap(await accountScope(req), all)
    res.json({ ok: true, shared: sharedProxies(mine) })
  } catch (err) { fail(res, err, 500) }
})

// §6: авто-проверка живости — все / один.
proxiesRouter.post('/check-all', async (req, res) => {
  try {
    // Проверка гоняет КАЖДЫЙ прокси и возвращает вердикт: без фильтра это была разведка
    // по чужой инфраструктуре (сколько прокси у соседа и какие из них живые).
    const { ownedForRequest } = await import('./lib/accessGuard.js')
    const mine = await ownedForRequest(req, await listProxies(), (x) => x?.ownerId)
    const results = await checkAllProxies(mine.map((x) => x.id))
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
    // «Живость» = выход наружу через прокси, а не открытый порт: порт отвечает и на
    // чужом протоколе, из-за чего нерабочий прокси показывался зелёным (баг 2, 21.07).
    const { status, geo, geoSource } = await probeProxy({ host, port, scheme, username, password })
    const ms = Date.now() - started
    res.json({ ok: true, alive: status === 'ok', status, ms, geo, geoSource })
  } catch (err) { fail(res, err, 500) }
})

proxiesRouter.post('/:id/check', async (req, res) => {
  try {
    const existing = await getProxy(req.params.id)
    if (!existing) return res.status(404).json({ ok: false, error: 'Прокси не найден' })
    const t0 = Date.now()
    const { status, geo, geoSource } = await probeProxy(existing)
    const ms = Date.now() - t0
    // Страна, её источник и подпись пишутся одной транзакцией — иначе `note` остаётся
    // от прошлой пробы и противоречит `country`. geoSource пишем в базу (тест 9.4).
    const proxy = (await updateProxy(existing.id, {
      status,
      lastCheckAt: Date.now(),
      ...(geo ? { country: geo.country || existing.country, geoSource, note: geoNote(geo) } : {}),
    })) || existing
    res.json({ ok: true, proxy, geo, geoSource, ms: status === 'dead' ? null : ms })
  } catch (err) { fail(res, err, 500) }
})

// ── §3.2: массовый импорт. Объявлено ДО '/:id', иначе путь затенится. ──────────

/** Разобрать список без сети — показать человеку, что понято, до записи в базу. */
proxiesRouter.post('/import/preview', async (req, res) => {
  try {
    const { text, scheme } = req.body ?? {}
    const { items, errors, rotationLinks } = parseProxyList(text, { scheme })
    const existing = await listProxies()
    const known = new Set(existing.map(proxyKey))
    const fresh = items.filter((i) => !known.has(proxyKey(i)))
    const dupes = items.length - fresh.length
    res.json({ ok: true, items: fresh, errors, rotationLinks, total: items.length, duplicates: dupes })
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
    const { items, errors, rotationLinks } = parseProxyList(text, { scheme })
    if (!items.length) return res.status(400).json({ ok: false, error: 'Не разобрано ни одной строки', errors })

    const existing = await listProxies()
    const known = new Set(existing.map(proxyKey))
    const skipped = items.filter((i) => known.has(proxyKey(i))).map((i) => ({ raw: i.raw, reason: 'уже есть в базе' }))
    const fresh = items.filter((i) => !known.has(proxyKey(i)))

    // Живость + страна выхода. Без probe импорт мгновенный, но страна остаётся неизвестной.
    const probed = probe
      ? await inBatches(fresh, 8, async (p) => {
        const { status, geo, geoSource } = await probeProxy(p)
        return { ...p, status, country: geo?.country || '', geo, geoSource }
      })
      : fresh.map((p) => ({ ...p, status: 'unknown', country: '', geo: null, geoSource: null }))

    const labels = assignLabels(probed, { template, tag, existingLabels: existing.map((p) => p.label) })
    // Импортированные прокси тоже принадлежат тому, кто их залил (иначе после импорта
    // клиент не увидел бы собственный список — владельца проставляем как при создании).
    const { ownerScopeForRequest } = await import('./lib/accessGuard.js')
    const importScope = await ownerScopeForRequest(req)
    const created = []
    for (let i = 0; i < probed.length; i++) {
      const p = probed[i]
      try {
        created.push(await createProxy({
          ownerId: importScope.ownerId || undefined,
          label: labels[i], kind, scheme: p.scheme, host: p.host, port: p.port,
          username: p.username, password: p.password, country: p.country, status: p.status,
          geoSource: p.geoSource || null, // §9.10: гео реального IP vs шлюза (тест 9.4)
          rotateUrl: p.rotateUrl || '',    // ссылка смены IP из того же списка (тест 9.11)
          note: [note, geoNote(p.geo)].filter(Boolean).join(' · '),
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
      ok: true, created, skipped, errors, rotationLinks,
      alive: created.filter((p) => p.status === 'ok').length,
      // «Порт открыт, но наружу не пускает» — почти всегда неверная схема. Это отдельный
      // счётчик, а не «мёртвый»: такие лечатся сменой http↔socks5, а не выбрасыванием.
      bad: created.filter((p) => p.status === 'bad').length,
      dead: created.filter((p) => p.status === 'dead').length,
    })
  } catch (err) { fail(res, err, 500) }
})

proxiesRouter.get('/:id', async (req, res) => {
  try {
    // Единственный роут прокси, оставшийся без проверки после аудита 20.08 — а отдаёт он
    // ЛОГИН И ПАРОЛЬ: чужой прокси можно было прочитать по id и пользоваться им дальше
    // уже мимо платформы (за счёт владельца).
    if (!(await canTouchProxy(req, req.params.id))) return res.status(403).json({ ok: false, error: 'Это не ваш прокси' })
    const proxy = await getProxy(req.params.id)
    if (!proxy) return res.status(404).json({ ok: false, error: 'Прокси не найден' })
    res.json({ ok: true, proxy })
  } catch (err) { fail(res, err, 500) }
})

/**
 * Аудит 20.08: править/удалять можно ТОЛЬКО свой прокси (иначе чужие креды менялись бы
 * прямым запросом по id). Админ — может всё; легаси-записи без владельца — только админ.
 * @returns {Promise<boolean>} true = можно трогать
 */
async function canTouchProxy(req, id) {
  const { ownerScopeForRequest } = await import('./lib/accessGuard.js')
  const scope = await ownerScopeForRequest(req)
  if (scope.blocked) return false
  if (scope.all) return true
  const p = await getProxy(id)
  return !!p && String(p.ownerId || '') === String(scope.ownerId)
}

proxiesRouter.post('/', async (req, res) => {
  try {
    const { ownerScopeForRequest } = await import('./lib/accessGuard.js')
    const scope = await ownerScopeForRequest(req)
    if (scope.blocked) return res.status(403).json({ ok: false, error: 'Нет доступа' })
    // Владелец пространства — хозяин записи: свои прокси клиент видит и правит, чужие нет.
    const proxy = await createProxy({ ...(req.body ?? {}), ownerId: scope.ownerId || undefined })
    await appendAudit({ action: 'proxy.create', module: 'proxy', initiator: 'operator', reason: `Добавлен прокси ${proxy.host}:${proxy.port}`, meta: { proxyId: proxy.id, kind: proxy.kind } })
    res.json({ ok: true, proxy })
  } catch (err) { fail(res, err) }
})

proxiesRouter.put('/:id', async (req, res) => {
  try {
    if (!(await canTouchProxy(req, req.params.id))) return res.status(403).json({ ok: false, error: 'Это не ваш прокси' })
    const proxy = await updateProxy(req.params.id, req.body ?? {})
    if (!proxy) return res.status(404).json({ ok: false, error: 'Прокси не найден' })
    res.json({ ok: true, proxy })
  } catch (err) { fail(res, err) }
})

// MR-170 (14.08): пакетное удаление за один проход (POST — тело DELETE местами режется прокси).
proxiesRouter.post('/delete-batch', async (req, res) => {
  try {
    const wanted = Array.isArray(req.body?.ids) ? req.body.ids : []
    // Удаляем только те, что реально свои — чужие id в списке молча игнорируем.
    const allowed = []
    for (const id of wanted) if (await canTouchProxy(req, id)) allowed.push(id)
    const ids = allowed
    const removed = await deleteProxies(ids)
    await appendAudit({ action: 'proxy.delete', module: 'proxy', initiator: 'operator', reason: `Удалено прокси: ${removed}`, meta: { ids, removed } })
    res.json({ ok: true, removed })
  } catch (err) { fail(res, err) }
})

proxiesRouter.delete('/:id', async (req, res) => {
  try {
    if (!(await canTouchProxy(req, req.params.id))) return res.status(403).json({ ok: false, error: 'Это не ваш прокси' })
    const ok = await deleteProxy(req.params.id)
    if (!ok) return res.status(404).json({ ok: false, error: 'Прокси не найден' })
    await appendAudit({ action: 'proxy.delete', module: 'proxy', initiator: 'operator', reason: 'Удалён прокси', meta: { proxyId: req.params.id } })
    res.json({ ok: true })
  } catch (err) { fail(res, err) }
})
