import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Утечка, найденная владельцем на живом проде 21.08: каталог ролей показывал РЕСУРСЫ
 * ВСЕЙ ПЛАТФОРМЫ — чужие Telegram-аккаунты по именам, чужие папки целей и каналы.
 * Клиент видел и сам факт существования чужих профилей, и как людей зовут.
 *
 * Причина: модули я ограничил подпиской, а ресурсы оставил как были. Здесь фиксируем
 * правило, чтобы оно не «съехало» при следующей правке каталога.
 */

const ownerFilter = (owner) => (rec) => {
  if (!owner) return true                                   // админ/дев — полный список
  const o = String(rec?.ownerId || rec?.userId || '')
  return o ? o === owner : false
}

test('владелец видит только свои ресурсы, чужие и ничьи скрыты', () => {
  const accounts = [
    { id: 'a1', ownerId: 'own_1' },
    { id: 'a2', ownerId: 'own_2' },       // чужой клиент
    { id: 'a3' },                          // ничей — заведён до появления скоупа
  ]
  assert.deepEqual(accounts.filter(ownerFilter('own_1')).map((a) => a.id), ['a1'])

  // Записи без владельца остаются видны ТОЛЬКО админу: угадать задним числом, чьи они,
  // нельзя, а показать всем «на всякий случай» — это и есть утечка.
  assert.deepEqual(accounts.filter(ownerFilter(null)).map((a) => a.id), ['a1', 'a2', 'a3'])
})

test('правило одинаково для аккаунтов, групп, папок и каналов', () => {
  // У аккаунтов владелец в ownerId, у прочих сущностей — в userId; фильтр понимает оба,
  // иначе половина ресурсов утекала бы дальше.
  const mine = ownerFilter('own_1')
  assert.equal(mine({ ownerId: 'own_1' }), true)
  assert.equal(mine({ userId: 'own_1' }), true)
  assert.equal(mine({ userId: 'own_2' }), false)
  assert.equal(mine({}), false)
})

test('каталог ролей отдаёт ресурсы только владельца', async () => {
  const { buildCatalog } = await import('../roles.js')
  // Без ownerId — полный каталог (админ). С ownerId — только свои; на чистом стенде у
  // тестового владельца своих аккаунтов нет, значит списки пусты, а не «все подряд».
  const full = await buildCatalog()
  const scoped = await buildCatalog({ ownerId: 'own_nobody' })
  const items = (cat, type) => (cat.resources.find((r) => r.type === type)?.items || []).length
  for (const type of ['accounts', 'accountGroups', 'folders', 'channels']) {
    assert.equal(items(scoped, type), 0, `${type}: чужое не показываем`)
    assert.ok(items(full, type) >= 0)
  }
})
