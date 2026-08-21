import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCatalog } from '../roles.js'

/**
 * Решение владельца 21.08: владелец пространства сам раздаёт субам доступ к модулям —
 * «если у овнера 5 купленных модулей, он может скрыть видимость у суба». Каталог ролей
 * обязан совпадать с его подпиской: показать больше — предложить выдать доступ, который
 * всё равно не заработает (accessGuard упрётся в подписку), и объяснять это придётся нам.
 */

test('каталог ролей ограничивается набором модулей владельца', async () => {
  const full = await buildCatalog()
  assert.ok(full.modules.length > 2, 'без ограничения — весь список платформы')

  const limited = await buildCatalog({ modules: ['neuro-chatting', 'mass-react'] })
  assert.deepEqual(limited.modules.map((m) => m.key), ['neuro-chatting', 'mass-react'])
  // Остальные разделы каталога не режем: блоки, разделы и ресурсы к подписке отношения
  // не имеют — это про то, что человек видит внутри модуля, а не про оплату.
  assert.equal(limited.blocks.length, full.blocks.length)
  assert.equal(limited.resources.length, full.resources.length)
})

test('«all» и отсутствие ограничения дают полный каталог, пустой список — ничего', async () => {
  const full = await buildCatalog()
  assert.equal((await buildCatalog({ modules: 'all' })).modules.length, full.modules.length)
  assert.equal((await buildCatalog(null)).modules.length, full.modules.length)
  // Пустой набор — это «подписки нет» либо «истекла»: раздавать нечего, и показывать
  // модули как доступные было бы обманом.
  assert.deepEqual((await buildCatalog({ modules: [] })).modules, [])
})

/**
 * Баг 21.08: `normalizeRole` не переносила `userId`, и роль сохранялась «ничьей».
 * Владелец мог её создать, но не отредактировать (PUT требует свою роль), а сама роль
 * показывалась ВСЕМ владельцам как системный шаблон — отсюда общий список из десятков
 * чужих «Новая роль 5/6» на экране у каждого.
 */
test('роль запоминает владельца и не теряет его при правке', async () => {
  const { normalizeRole } = await import('../roles.js')
  assert.equal(normalizeRole({ name: 'Моя', userId: 'usr_1' }).userId, 'usr_1')
  // Пустой/отсутствующий владелец — системный шаблон, так и остаётся.
  assert.equal(normalizeRole({ name: 'Шаблон' }).userId, '')
  // Правка без userId в теле запроса не должна обнулять владельца: updateRole сливает
  // patch поверх существующей роли, поэтому владелец доезжает из неё.
  assert.equal(normalizeRole({ ...{ name: 'Моя', userId: 'usr_1' }, ...{ name: 'Моя 2' } }).userId, 'usr_1')
})

/**
 * Мусор в списке ролей (21.08): у владельца накопились 44 роли, среди них по три
 * «Тимлид» и «Уволенный» — отличить их друг от друга невозможно. Клиентский запрет
 * дублей обходится прямым запросом, поэтому правило живёт и на сервере.
 */
test('роль с занятым именем не создаётся, чужие имена не мешают', async () => {
  const os = await import('node:os')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-'))
  process.env.ROLES_FILE = path.join(dir, 'roles.json')
  const { createRole, updateRole } = await import('../roles.js')

  const first = await createRole({ name: 'Тимлид', userId: 'own_1' })
  // Регистр и пробелы не спасают: «  тимлид » — та же роль для человека.
  await assert.rejects(() => createRole({ name: '  тимлид ', userId: 'own_1' }), /уже есть/)
  // У другого владельца свой список — совпадение имени ему не мешает.
  const other = await createRole({ name: 'Тимлид', userId: 'own_2' })
  assert.ok(other.id !== first.id)

  // Переименование в занятое имя — тоже отказ, а своё имя за собой оставить можно.
  const second = await createRole({ name: 'Оператор', userId: 'own_1' })
  await assert.rejects(() => updateRole(second.id, { name: 'Тимлид' }), /уже есть/)
  const same = await updateRole(second.id, { name: 'Оператор' })
  assert.equal(same.name, 'Оператор')
})
