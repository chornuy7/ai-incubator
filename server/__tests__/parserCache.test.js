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

test('сигнатура: порядок и регистр ключей/окончаний не влияют', () => {
  const a = parserSignature('parsing', { keywords: ['Крипто', 'IT'], endings: ['Chat', 'news'] })
  const b = parserSignature('parsing', { keywords: ['it', 'крипто'], endings: ['news', 'chat'] })
  assert.equal(a, b)
})

test('сигнатура: тип модуля и фильтры меняют ключ', () => {
  const base = { keywords: ['крипто'] }
  assert.notEqual(parserSignature('parsing', base), parserSignature('parsing-groups', base))
  assert.notEqual(parserSignature('parsing', base), parserSignature('parsing', { ...base, minMembers: 1000 }))
  assert.notEqual(parserSignature('parsing', base), parserSignature('parsing', { ...base, intersect: true }))
})

test('save + lookup: совпадающий запрос отдаётся из базы с датой и количеством', () => {
  const settings = { keywords: ['крипто', 'IT'], endings: ['chat'], minMembers: 100 }
  const results = [{ username: 'a', members: 5000 }, { username: 'b', members: 100 }]
  const sig = saveParserResults('parsing', settings, results)
  assert.ok(sig)

  // тот же запрос в другом порядке/регистре — попадает в тот же кэш
  const hit = lookupParserResults('parsing', { keywords: ['it', 'крипто'], endings: ['chat'], minMembers: 100 })
  assert.ok(hit)
  assert.equal(hit.count, 2)
  assert.equal(hit.results.length, 2)
  assert.equal(hit.results[0].username, 'a')
  assert.ok(hit.updatedAt > 0)
})

test('lookup: другой запрос — промаха нет ложного', () => {
  saveParserResults('parsing', { keywords: ['крипто'] }, [{ username: 'x' }])
  assert.equal(lookupParserResults('parsing', { keywords: ['спорт'] }), null)
})

test('без ключевых слов не кэшируем', () => {
  assert.equal(saveParserResults('parsing', { keywords: [] }, [{ username: 'z' }]), undefined)
  assert.equal(lookupParserResults('parsing', { keywords: [] }), null)
})

test('повторный save перезаписывает состав и дату для той же сигнатуры', () => {
  const s = { keywords: ['news'] }
  saveParserResults('parsing', s, [{ username: 'one' }])
  saveParserResults('parsing', s, [{ username: 'one' }, { username: 'two' }, { username: 'three' }])
  const hit = lookupParserResults('parsing', s)
  assert.equal(hit.count, 3)
})
