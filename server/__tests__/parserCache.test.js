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

const { parserSignature, saveParserResults, lookupParserResults } = await import('../parserCache.js')

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
