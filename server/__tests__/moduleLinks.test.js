/**
 * MR-290: модули связями вместо массива text[].
 *
 * Проверяется то, на чём такой переезд обычно и ломается: порядок (первый модуль
 * значащий), различие «связей нет» и «прочитать не удалось», и запись, которая обязана
 * сначала снять лишнее и только потом положить нужное.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readModuleLinks, writeModuleLinks, invalidateModuleIds } from '../lib/moduleIds.js'

const СПРАВОЧНИК = [
  { id: 1, key: 'warming' }, { id: 2, key: 'parsing' }, { id: 3, key: 'neuro-chatting' },
]

/**
 * Фейковый клиент: отдаёт заданные строки и записывает всё, что с ним делали.
 * @param {{modules?: any[], links?: any[], errors?: Record<string, any>}} opts
 */
function fakeDb(opts = {}) {
  const calls = []
  const errors = opts.errors || {}
  return {
    calls,
    from(table) {
      const q = {
        select() { return q },
        in(_col, ids) { q._ids = ids; return q },
        order() {
          calls.push({ op: 'select', table })
          if (errors[table]) return Promise.resolve({ data: null, error: errors[table] })
          return Promise.resolve({ data: opts.links || [], error: null })
        },
        delete() {
          return { eq(col, id) { calls.push({ op: 'delete', table, col, id }); return Promise.resolve({ error: errors['delete:' + table] || null }) } }
        },
        upsert(rows) { calls.push({ op: 'upsert', table, rows }); return Promise.resolve({ error: errors['upsert:' + table] || null }) },
        // Справочник читается без .order() — значит запрос завершается прямо на select.
        then(res) {
          calls.push({ op: 'select', table })
          if (errors[table]) return res({ data: null, error: errors[table] })
          return res({ data: table === 'modules' ? (opts.modules ?? СПРАВОЧНИК) : (opts.links || []), error: null })
        },
      }
      return q
    },
  }
}

test('порядок модулей задаёт position, и запрос обязан его заказывать', async () => {
  const db = fakeDb({ links: [
    { campaign_id: 'cmp_1', module_id: 1, position: 0 },
    { campaign_id: 'cmp_1', module_id: 2, position: 1 },
  ] })
  const map = await readModuleLinks(db, 'campaign_modules', 'campaign_id', ['cmp_1'])
  assert.deepEqual(map.get('cmp_1'), ['warming', 'parsing'])
})

test('идентификатор модуля числом и строкой — один и тот же модуль', async () => {
  // bigint через PostgREST приезжает то числом, то строкой, а Map различает 7 и '7'.
  const db = fakeDb({ links: [{ campaign_id: 'cmp_1', module_id: '3', position: 0 }] })
  const map = await readModuleLinks(db, 'campaign_modules', 'campaign_id', ['cmp_1'])
  assert.deepEqual(map.get('cmp_1'), ['neuro-chatting'])
})

test('«связей нет» и «прочитать не удалось» — разные ответы', async () => {
  // Спутать их значит показать кампанию без модулей там, где просто не доехала миграция.
  const пусто = await readModuleLinks(fakeDb({ links: [] }), 'campaign_modules', 'campaign_id', ['cmp_1'])
  assert.equal(пусто.size, 0, 'связей нет — пустая карта')

  const сломано = await readModuleLinks(
    fakeDb({ errors: { campaign_modules: { message: 'relation does not exist' } } }),
    'campaign_modules', 'campaign_id', ['cmp_1'])
  assert.equal(сломано, null, 'прочитать не удалось — null, читайте колонку')
})

test('пустой список владельцев в базу не ходит', async () => {
  const db = fakeDb()
  const map = await readModuleLinks(db, 'campaign_modules', 'campaign_id', [])
  assert.equal(map.size, 0)
  assert.equal(db.calls.length, 0, 'запросов быть не должно')
})

test('запись: сначала снять старое, потом положить новое', async () => {
  // Обратный порядок на миг оставил бы владельца с обоими наборами сразу.
  const db = fakeDb()
  await writeModuleLinks(db, 'campaign_modules', 'campaign_id', 'cmp_1', ['warming', 'parsing'])
  const порядок = db.calls.filter((c) => c.op !== 'select').map((c) => c.op)
  assert.deepEqual(порядок, ['delete', 'upsert'])
})

test('запись расставляет position по порядку ключей', async () => {
  const db = fakeDb()
  await writeModuleLinks(db, 'campaign_modules', 'campaign_id', 'cmp_1', ['parsing', 'warming'])
  const { rows } = db.calls.find((c) => c.op === 'upsert')
  assert.deepEqual(rows, [
    { campaign_id: 'cmp_1', module_id: 2, position: 0 },
    { campaign_id: 'cmp_1', module_id: 1, position: 1 },
  ])
})

test('неизвестный ключ отбрасывается, а не роняет всю запись', async () => {
  // Иначе опечатка в наборе модулей стоила бы кампании целиком.
  const db = fakeDb()
  await writeModuleLinks(db, 'campaign_modules', 'campaign_id', 'cmp_1', ['warming', 'такого-нет'])
  const { rows } = db.calls.find((c) => c.op === 'upsert')
  assert.deepEqual(rows.map((r) => r.module_id), [1])
})

test('повтор ключа не даёт двух строк на один модуль', async () => {
  const db = fakeDb()
  await writeModuleLinks(db, 'campaign_modules', 'campaign_id', 'cmp_1', ['warming', 'warming'])
  const { rows } = db.calls.find((c) => c.op === 'upsert')
  assert.equal(rows.length, 1)
})

test('пустой набор снимает все связи и ничего не пишет', async () => {
  const db = fakeDb()
  await writeModuleLinks(db, 'campaign_modules', 'campaign_id', 'cmp_1', [])
  assert.ok(db.calls.some((c) => c.op === 'delete'), 'снятие обязательно')
  assert.ok(!db.calls.some((c) => c.op === 'upsert'), 'вставлять нечего')
})

test('нет справочника — запись отказывает, а не пишет пустоту', async () => {
  // Тихо записанный пустой набор выглядел бы как «у кампании отобрали модули».
  const db = fakeDb({ errors: { modules: { message: 'нет доступа' } } })
  await assert.rejects(
    () => writeModuleLinks(db, 'campaign_modules', 'campaign_id', 'cmp_1', ['warming']),
    /справочник/i)
})

test('журнал кошелька использует ту же механику, отличается только таблица', async () => {
  const db = fakeDb({ links: [{ log_id: 42, module_id: 1, position: 0 }] })
  const map = await readModuleLinks(db, 'wallet_log_modules', 'log_id', [42])
  assert.deepEqual(map.get('42'), ['warming'], 'ключ карты — строка, id записи числовой')
})

test('подставленный клиент не оставляет свой справочник в общем кэше', async () => {
  // Иначе один тест подсунул бы свой набор модулей всем остальным.
  invalidateModuleIds()
  await readModuleLinks(fakeDb({ modules: [{ id: 9, key: 'выдуманный' }], links: [] }), 'campaign_modules', 'campaign_id', ['c'])
  const db = fakeDb({ links: [{ campaign_id: 'c', module_id: 1, position: 0 }] })
  const map = await readModuleLinks(db, 'campaign_modules', 'campaign_id', ['c'])
  assert.deepEqual(map.get('c'), ['warming'], 'справочник взят у своего клиента')
})
