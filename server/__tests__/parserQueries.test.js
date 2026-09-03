/**
 * «Последние запросы» парсера (просьба владельца 26.08): список того, что уже искали,
 * с переименованием и удалением.
 *
 * Главное, что здесь закрывается: список берётся из ТОГО ЖЕ кэша результатов, поэтому
 * он обязан фильтроваться по владельцу (кэш общий на платформу — без фильтра клиент
 * увидел бы чужие запросы) и переживать переименование, не теряя связь с содержимым.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'parser-queries-'))
const { saveParserResults, listQueries, queryResults, renameQuery, deleteQuery } = await import('../parserCache.js')

const chan = (u) => ({ username: u, title: u, members: 100 })

/*
 * Кэш — одна таблица на весь прогон, и сброса данных между тестами нет. Поэтому у
 * каждого теста свой владелец и свои слова: тесты не видят чужих строк и не зависят
 * от порядка выполнения.
 */
const one = async (kind, ownerId, sig) => (await listQueries({ kind, ownerId })).find((q) => q.sig === sig)

test('запрос попадает в список сразу после сохранения результата', async () => {
  const sig = await saveParserResults('parsing', { keywords: ['t1-крипта', 't1-трейдинг'] }, [chan('a'), chan('b')], 'usr-1')
  assert.ok(sig)
  const [q] = await listQueries({ kind: 'parsing', ownerId: 'usr-1' })
  assert.equal(q.count, 2)
  assert.equal(q.name, 't1-крипта, t1-трейдинг') // имени не давали — подпись из слов запроса
  assert.equal(q.renamed, false)
})

test('длинный список слов сворачивается в хвост «+N», а не режется посередине слова', async () => {
  await saveParserResults('parsing', { keywords: ['aa', 'bb', 'cc', 'dd', 'ee'] }, [chan('x')], 'usr-2')
  const [q] = await listQueries({ kind: 'parsing', ownerId: 'usr-2' })
  assert.equal(q.name, 'aa, bb, cc +2')
})

test('чужие запросы в список не попадают', async () => {
  await saveParserResults('parsing', { keywords: ['t3-моё'] }, [chan('a')], 'usr-3')
  await saveParserResults('parsing', { keywords: ['t3-чужое'] }, [chan('b')], 'usr-4')
  assert.deepEqual((await listQueries({ kind: 'parsing', ownerId: 'usr-3' })).map((q) => q.name), ['t3-моё'])
  assert.deepEqual((await listQueries({ kind: 'parsing', ownerId: 'usr-4' })).map((q) => q.name), ['t3-чужое'])
})

test('список разделён по модулям: парсер групп не показывает запросы парсера каналов', async () => {
  await saveParserResults('parsing', { keywords: ['t4-каналы'] }, [chan('a')], 'usr-5')
  await saveParserResults('parsing-groups', { keywords: ['t4-группы'] }, [chan('b')], 'usr-5')
  assert.deepEqual((await listQueries({ kind: 'parsing-groups', ownerId: 'usr-5' })).map((q) => q.name), ['t4-группы'])
})

test('переименование не трогает содержимое, автоподпись остаётся рядом', async () => {
  await saveParserResults('parsing', { keywords: ['t5-крипта'] }, [chan('a'), chan('b')], 'usr-6')
  const [q] = await listQueries({ kind: 'parsing', ownerId: 'usr-6' })
  assert.equal(await renameQuery(q.sig, 'Осенний сбор'), true)

  const renamed = await one('parsing', 'usr-6', q.sig)
  assert.equal(renamed.name, 'Осенний сбор')
  assert.equal(renamed.renamed, true)
  assert.equal(renamed.query, 't5-крипта') // видно, что внутри
  assert.equal(renamed.count, 2)

  const full = await queryResults(q.sig)
  assert.equal(full.results.length, 2)
})

test('пустое имя возвращает автоподпись — отдельной кнопки сброса не нужно', async () => {
  await saveParserResults('parsing', { keywords: ['t6-крипта'] }, [chan('a')], 'usr-7')
  const [q] = await listQueries({ kind: 'parsing', ownerId: 'usr-7' })
  await renameQuery(q.sig, 'Своё имя')
  await renameQuery(q.sig, '   ')
  const back = await one('parsing', 'usr-7', q.sig)
  assert.equal(back.name, 't6-крипта')
  assert.equal(back.renamed, false)
})

test('повторный прогон того же запроса обновляет строку, а не плодит вторую', async () => {
  await saveParserResults('parsing', { keywords: ['t7-крипта'] }, [chan('a')], 'usr-8')
  const [first] = await listQueries({ kind: 'parsing', ownerId: 'usr-8' })
  await renameQuery(first.sig, 'Моё имя')
  await saveParserResults('parsing', { keywords: ['t7-крипта'] }, [chan('a'), chan('b'), chan('c')], 'usr-8')

  const list = await listQueries({ kind: 'parsing', ownerId: 'usr-8' })
  assert.equal(list.length, 1)
  assert.equal(list[0].count, 3)
  assert.equal(list[0].name, 'Моё имя') // данное человеком имя переживает пересбор
})

test('удаление убирает и запрос, и результаты', async () => {
  await saveParserResults('parsing', { keywords: ['t8-крипта'] }, [chan('a')], 'usr-9')
  const [q] = await listQueries({ kind: 'parsing', ownerId: 'usr-9' })
  assert.equal(await deleteQuery(q.sig), true)
  assert.deepEqual(await listQueries({ kind: 'parsing', ownerId: 'usr-9' }), [])
  assert.equal(await queryResults(q.sig), null)
  assert.equal(await deleteQuery(q.sig), false) // повторное удаление — не ошибка, просто нечего
})

test('пустой сбор не попадает в кэш и не забивает список запросов (26.08)', async () => {
  // Прогон владельца: пересечение по 51 ключу обнулило выдачу, ноль лёг в кэш — и витрина
  // стала предлагать «в базе есть сохранённый результат: 0 каналов» вместо нового прохода.
  await saveParserResults('parsing', { keywords: ['t9-пусто'] }, [], 'usr-10')
  assert.deepEqual(await listQueries({ kind: 'parsing', ownerId: 'usr-10' }), [])

  // А уже сохранённый непустой результат пустой проход не затирает: устаревшие данные
  // полезнее пустых.
  await saveParserResults('parsing', { keywords: ['t9-было'] }, [chan('a'), chan('b')], 'usr-11')
  await saveParserResults('parsing', { keywords: ['t9-было'] }, [], 'usr-11')
  const [q] = await listQueries({ kind: 'parsing', ownerId: 'usr-11' })
  assert.equal(q.count, 2)
})
