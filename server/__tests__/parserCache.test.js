/**
 * §6 (MR-38): кэш результатов парсинга. Проверяем, что сигнатура запроса
 * детерминирована (порядок/регистр ключей не важен, состав фильтров — важен), а
 * сохранение/чтение по совпадающему запросу отдаёт тот же результат с датой.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import path from 'path'

process.env.PARSER_CACHE_DB = path.join(os.tmpdir(), `pcache-${process.pid}-${Math.random().toString(36).slice(2)}.db`)

const { parserSignature, saveParserResults, lookupParserResults, setWatch, dueWatches, markWatchRun, listWatches, diffResults, WATCH_MAX_FAILS } = await import('../parserCache.js')

test('сигнатура: порядок и регистр ключей/окончаний не влияют', async () => {
  const a = parserSignature('parsing', { keywords: ['Крипто', 'IT'], endings: ['Chat', 'news'] })
  const b = parserSignature('parsing', { keywords: ['it', 'крипто'], endings: ['news', 'chat'] })
  assert.equal(a, b)
})

test('сигнатура: тип модуля и фильтры меняют ключ', async () => {
  const base = { keywords: ['крипто'] }
  assert.notEqual(parserSignature('parsing', base), parserSignature('parsing-groups', base))
  assert.notEqual(parserSignature('parsing', base), parserSignature('parsing', { ...base, minMembers: 1000 }))
  assert.notEqual(parserSignature('parsing', base), parserSignature('parsing', { ...base, intersect: true }))
})

test('save + lookup: совпадающий запрос отдаётся из базы с датой и количеством', async () => {
  const settings = { keywords: ['крипто', 'IT'], endings: ['chat'], minMembers: 100 }
  const results = [{ username: 'a', members: 5000 }, { username: 'b', members: 100 }]
  const sig = await saveParserResults('parsing', settings, results)
  assert.ok(sig)

  // тот же запрос в другом порядке/регистре — попадает в тот же кэш
  const hit = await lookupParserResults('parsing', { keywords: ['it', 'крипто'], endings: ['chat'], minMembers: 100 })
  assert.ok(hit)
  assert.equal(hit.count, 2)
  assert.equal(hit.results.length, 2)
  assert.equal(hit.results[0].username, 'a')
  assert.ok(hit.updatedAt > 0)
})

test('lookup: другой запрос — промаха нет ложного', async () => {
  await saveParserResults('parsing', { keywords: ['крипто'] }, [{ username: 'x' }])
  assert.equal(await lookupParserResults('parsing', { keywords: ['спорт'] }), null)
})

test('без ключевых слов и без источников не кэшируем', async () => {
  assert.equal(await saveParserResults('parsing', { keywords: [] }, [{ username: 'z' }]), undefined)
  assert.equal(await lookupParserResults('parsing', { keywords: [] }), null)
})

test('повторный save перезаписывает состав и дату для той же сигнатуры', async () => {
  const s = { keywords: ['news'] }
  await saveParserResults('parsing', s, [{ username: 'one' }])
  await saveParserResults('parsing', s, [{ username: 'one' }, { username: 'two' }, { username: 'three' }])
  const hit = await lookupParserResults('parsing', s)
  assert.equal(hit.count, 3)
})

/**
 * Парсеры аудитории (участники/сообщения/комментарии) описываются не словами, а списком
 * источников. До 24.08 кэш к ним не был подключён вовсе: повторный парс той же группы
 * каждый раз заново гонял аккаунты.
 */
test('парсер аудитории: источники — тоже запрос, и порядок с собачкой не важен', async () => {
  const s = { targets: ['@Cryptan300Chat', 'devchat'], filters: { skipBots: true }, limits: { participants: 500 } }
  await saveParserResults('parsing-users', s, [{ id: '1' }, { id: '2' }])
  const hit = await lookupParserResults('parsing-users', { targets: ['DevChat', 'cryptan300chat'], filters: { skipBots: true }, limits: { participants: 500 } })
  assert.ok(hit, 'тот же набор источников должен попасть в кэш')
  assert.equal(hit.count, 2)
})

test('парсер аудитории: другой лимит сбора — другой запрос', async () => {
  const base = { targets: ['somechat'], limits: { participants: 20 } }
  await saveParserResults('parsing-users', base, [{ id: '1' }])
  // с лимитом 1000 состав другой — отдавать сбор на 20 нельзя
  assert.equal(await lookupParserResults('parsing-users', { targets: ['somechat'], limits: { participants: 1000 } }), null)
  // и фильтры тоже меняют состав
  assert.equal(await lookupParserResults('parsing-users', { targets: ['somechat'], limits: { participants: 20 }, filters: { onlyPremium: true } }), null)
})

test('источники не ломают сигнатуру парсера каналов', async () => {
  // Поля источников добавляются в ключ, только если источники заданы, — иначе кэш
  // парсера каналов обнулился бы на ровном месте при выкате правки.
  const a = parserSignature('parsing', { keywords: ['крипто'] })
  const b = parserSignature('parsing', { keywords: ['крипто'], targets: [] })
  assert.equal(a, b)
  assert.match(a, /^\{"kind":"parsing","keywords":\["крипто"\]/)
})

/**
 * Порядок выката: код уезжает пушем, миграции накатываются руками через SQL Editor.
 * В окне между этим витрины должны отработать на файлах, а не уронить страницу — но
 * ТОЛЬКО на «нет таблицы». Настоящую ошибку тихо глотать нельзя, иначе фолбэк спрячет беду.
 */
test('«таблицы нет» отличается от настоящей ошибки', async () => {
  const { isMissingTable } = await import('../lib/supabase.js')
  assert.equal(isMissingTable({ code: '42P01', message: 'relation "parser_cache" does not exist' }), true)
  assert.equal(isMissingTable({ message: "Could not find the table 'public.payments' in the schema cache" }), true)
  // а это уже настоящие беды — их надо поднимать наверх
  assert.equal(isMissingTable({ code: '23505', message: 'duplicate key value violates unique constraint' }), false)
  assert.equal(isMissingTable({ code: '42501', message: 'permission denied for table payments' }), false)
  assert.equal(isMissingTable({ message: 'fetch failed' }), false)
  assert.equal(isMissingTable(null), false)
})

/*
 * ── Слежение за запросом (просьба владельца 24.08) ───────────────────────────
 * «Проходиться по сохранённым и перепроверять актуальность и новые каналы; ошибки
 * видно в админке». Проверяем: что считается новым и пропавшим, что слежение не
 * включается само, что созревшие выбираются по сроку и что сломанное само отваливается.
 */

test('что появилось и что пропало — считаем по устойчивой личности записи', () => {
  const было = [{ username: 'AlphaChat' }, { username: 'beta' }, { id: '777' }]
  const стало = [{ username: '@alphachat' }, { id: '777' }, { username: 'gamma' }]
  const d = diffResults(было, стало)
  assert.deepEqual(d.added, ['gamma'], 'регистр и собачка не делают канал новым')
  assert.deepEqual(d.gone, ['beta'])
})

/**
 * Решение владельца 26.08 ОТМЕНИЛО прежнее «слежение только по галочке»: обновлять надо
 * все сохранённые запросы раз в 12 часов, иначе база стареет — обновляется лишь то, о чём
 * вспомнили. Ревизию ведёт наш сервисный пул и за наш счёт, поэтому включать её за
 * клиента теперь можно: его аккаунты и деньги она не трогает.
 */
test('каждый сохранённый запрос сам встаёт в очередь на ревизию', async () => {
  const s = { keywords: ['watch-auto'] }
  await saveParserResults('parsing', s, [{ username: 'a' }], 'u1')
  // Сразу после сбора обновлять нечего…
  assert.equal((await dueWatches(Date.now(), 50)).filter((w) => w.label === 'watch-auto').length, 0)
  // …а через 12 часов запрос созревает сам, без единой галочки.
  const due = await dueWatches(Date.now() + 13 * 3600_000, 50)
  assert.equal(due.filter((w) => w.label === 'watch-auto').length, 1)
})

test('повторный сбор НЕ отодвигает назначенную ревизию', async () => {
  const s = { keywords: ['watch-plan'] }
  await saveParserResults('parsing', s, [{ username: 'a' }], 'u1')
  const first = (await dueWatches(Date.now() + 13 * 3600_000, 50)).find((w) => w.label === 'watch-plan')
  // Тот же запрос прогнали руками через час — срок ревизии должен остаться прежним,
  // иначе часто запрашиваемый поиск не обновится никогда.
  await saveParserResults('parsing', s, [{ username: 'a' }, { username: 'b' }], 'u1')
  const again = (await dueWatches(Date.now() + 13 * 3600_000, 50)).find((w) => w.label === 'watch-plan')
  assert.equal(again.nextRunAt, first.nextRunAt)
})

test('включённое слежение созревает к сроку, а не сразу', async () => {
  const s = { keywords: ['watch-on'] }
  await saveParserResults('parsing', s, [{ username: 'a' }, { username: 'b' }], 'u1')
  assert.equal(await setWatch('parsing', s, { watch: true, periodH: 12, ownerId: 'u1' }), true)
  // Только что собрали — сейчас проверять нечего.
  assert.equal((await dueWatches(Date.now(), 50)).filter((w) => w.label === 'watch-on').length, 0)
  // А через срок — пора, и запрос приходит вместе с настройками и прошлым результатом.
  const due = (await dueWatches(Date.now() + 13 * 3600_000, 50)).filter((w) => w.label === 'watch-on')
  assert.equal(due.length, 1)
  assert.deepEqual(due[0].settings.keywords, ['watch-on'], 'без настроек запрос нечем перезапустить')
  assert.equal(due[0].results.length, 2, 'нужен снимок ДО прохода, иначе не с чем сравнивать')
  assert.equal(due[0].ownerId, 'u1', 'перепроверка идёт под владельцем запроса')
})

test('слежение выключается по просьбе', async () => {
  const s = { keywords: ['watch-stop'] }
  await saveParserResults('parsing', s, [{ username: 'a' }], 'u1')
  await setWatch('parsing', s, { watch: true, periodH: 1, ownerId: 'u1' })
  await setWatch('parsing', s, { watch: false })
  assert.equal((await dueWatches(Date.now() + 999 * 3600_000, 50)).filter((w) => w.label === 'watch-stop').length, 0)
})

test('ошибка не снимает слежение сразу, но сломанное само отваливается', async () => {
  const s = { keywords: ['watch-fail'] }
  await saveParserResults('parsing', s, [{ username: 'a' }], 'u1')
  await setWatch('parsing', s, { watch: true, periodH: 1, ownerId: 'u1' })
  const sig = (await dueWatches(Date.now() + 2 * 3600_000, 50)).find((w) => w.label === 'watch-fail').sig

  let fails = 0
  for (let i = 1; i < WATCH_MAX_FAILS; i += 1) {
    const stopped = await markWatchRun(sig, { error: 'Прокси не отвечает', failCount: fails, periodH: 1 })
    fails += 1
    assert.equal(stopped, false, `на ${i}-й неудаче слежение снимать рано — сеть моргает`)
  }
  assert.equal(await markWatchRun(sig, { error: 'Прокси не отвечает', failCount: fails, periodH: 1 }), true, 'после порога слежение должно сняться')

  // Причина остаётся на виду — её и показывает админка.
  const broken = await listWatches({ onlyErrors: true })
  const row = broken.find((w) => w.sig === sig)
  assert.ok(row, 'сломанный запрос пропал из списка ошибок')
  assert.match(row.lastError, /Прокси/)
  assert.equal(row.watch, false)
})

test('удачный проход записывает, сколько нашлось нового, и сбрасывает счётчик неудач', async () => {
  const s = { keywords: ['watch-ok'] }
  await saveParserResults('parsing', s, [{ username: 'a' }], 'u1')
  await setWatch('parsing', s, { watch: true, periodH: 1, ownerId: 'u1' })
  const w = (await dueWatches(Date.now() + 2 * 3600_000, 50)).find((x) => x.label === 'watch-ok')
  assert.equal(await markWatchRun(w.sig, { added: 3, gone: 1, failCount: 0, periodH: 1 }), false)
  const mine = await listWatches({ ownerId: 'u1' })
  const row = mine.find((x) => x.sig === w.sig)
  assert.equal(row.lastNew, 3)
  assert.equal(row.lastGone, 1)
  assert.equal(row.lastError, null)
  assert.ok(row.nextRunAt > Date.now(), 'следующий заход должен быть назначен')
})

test('повторный парс не сбрасывает слежение', async () => {
  const s = { keywords: ['watch-keep'] }
  await saveParserResults('parsing', s, [{ username: 'a' }], 'u1')
  await setWatch('parsing', s, { watch: true, periodH: 1, ownerId: 'u1' })
  // Тот же запрос прогнали руками — настройки слежения обязаны пережить перезапись.
  await saveParserResults('parsing', s, [{ username: 'a' }, { username: 'b' }], 'u1')
  const still = (await listWatches({ ownerId: 'u1' })).find((x) => x.label === 'watch-keep')
  assert.ok(still, 'слежение слетело при обычном сохранении результата')
  assert.equal(still.count, 2)
})

/**
 * TGStat — отдельный вид запроса: ходит куками каталога, а не аккаунтами, и описывается
 * фильтрами (категория, регион, порог подписчиков), а не словами. В кэш он попадать
 * должен наравне с остальными, а за таким запросом ещё и следить дёшево: перепроверка
 * не занимает профили и не списывает монеты.
 */
test('TGStat: запрос описывается фильтрами и кэшируется', async () => {
  const s = { filters: { category: 'crypto', region: 'russia', minSubscribers: 1000 }, maxPages: 3 }
  await saveParserResults('tgstat', s, [{ username: 'a' }, { username: 'b' }], 'u1')
  const hit = await lookupParserResults('tgstat', { filters: { minSubscribers: 1000, region: 'russia', category: 'crypto' }, maxPages: 3 })
  assert.ok(hit, 'порядок ключей фильтра не должен менять ключ')
  assert.equal(hit.count, 2)
})

test('TGStat: другая категория или другая глубина — другой запрос', async () => {
  const base = { filters: { category: 'crypto' }, maxPages: 3 }
  await saveParserResults('tgstat', base, [{ username: 'a' }], 'u1')
  assert.equal(await lookupParserResults('tgstat', { filters: { category: 'news' }, maxPages: 3 }), null)
  assert.equal(await lookupParserResults('tgstat', { filters: { category: 'crypto' }, maxPages: 10 }), null, 'глубина меняет состав')
})

test('TGStat без фильтров не кэшируем — описывать нечего', async () => {
  assert.equal(await saveParserResults('tgstat', { filters: {} }, [{ username: 'z' }]), undefined)
})

test('kind tgstat не ломает сигнатуры остальных парсеров', () => {
  const a = parserSignature('parsing', { keywords: ['крипто'] })
  const b = parserSignature('parsing', { keywords: ['крипто'], filters: { category: 'crypto' } })
  assert.equal(a, b, 'фильтры TGStat не должны влезать в ключ обычного парсера')
})

/**
 * Деньги (решения владельца 26.08):
 *   • фоновая ревизия — за наш счёт, с клиента не списывается ничего;
 *   • выдача готового из базы — КАК ОБЫЧНЫЙ СБОР, по той же цене за строку.
 * Оба правила про чужие деньги, поэтому проверяем их отдельно от механики кэша.
 */
test('фоновое обновление не списывает с клиента ничего', async () => {
  const { chargeActions } = await import('../lib/actionBilling.js')
  let списаний = 0
  const deps = {
    actionMap: { parsing: 0.005 },
    changeCoins: async () => { списаний += 1; return { applied: -0.005 } },
    getBalance: async () => ({ coins: 100 }),
  }
  const фон = { moduleKey: 'parsing', initiator: 'auto-refresh' }
  assert.equal(await chargeActions(фон, null, 10, deps), null, 'ревизия не должна списывать')
  assert.equal(списаний, 0)

  // А запуск клиентом — списывает, как и раньше.
  const руками = { moduleKey: 'parsing' }
  assert.ok(await chargeActions(руками, null, 10, deps))
  assert.equal(списаний, 1)
})

test('выдача из базы стоит столько же, сколько сбор тех же строк', async () => {
  const { priceOfRows } = await import('../lib/actionBilling.js')
  const deps = { actionMap: { parsing: 0.005 } }
  assert.equal(await priceOfRows('parsing', 100, deps), 0.5)
  assert.equal(await priceOfRows('parsing', 0, deps), 0, 'пустой результат бесплатен')
  assert.equal(await priceOfRows('неизвестный-модуль', 100, deps), 0)
})
