import { test } from 'node:test'
import assert from 'node:assert/strict'
import { insertWithOwner, updateWithOwner, ownerOf } from '../lib/ownerColumn.js'

/** Фейковый supabase-клиент: собирает попытки insert/update и отдаёт заданную ошибку. */
function fakeDb(errorFor) {
  const calls = []
  const chain = (op) => ({
    insert(row) { calls.push({ op, row }); return Promise.resolve({ error: errorFor(row) }) },
    update(row) {
      const self = { row }
      return { eq() { calls.push({ op, row: self.row }); return Promise.resolve({ error: errorFor(self.row) }) } }
    },
  })
  return { calls, from() { return { ...chain('insert'), ...chain('update') } } }
}

const FK_OWNER = { code: '23503', message: 'insert or update on table "leads" violates foreign key constraint "leads_user_profile_fkey"', details: 'Key (user_id)=(usr_x) is not present in table "profiles".' }
const FK_OTHER = { code: '23503', message: 'violates foreign key constraint "leads_campaign_id_fkey"', details: 'Key (campaign_id)=(cmp_x) is not present in table "campaigns".' }
const MISSING_COL = { message: 'Could not find the \'user_id\' column of \'leads\' in the schema cache' }

test('insertWithOwner: FK владельца → повтор без user_id, запись не роняется', async () => {
  // Ошибку отдаём только пока в строке есть user_id; на откате (без него) — успех.
  const db = fakeDb((row) => (row.user_id ? FK_OWNER : null))
  await insertWithOwner(db, 'leads', { id: 'l1', user_id: 'usr_x', peer: '@a' })
  assert.equal(db.calls.length, 2, 'первая попытка + откат')
  assert.ok(!('user_id' in db.calls[1].row), 'на откате user_id снят')
})

test('insertWithOwner: нет колонки user_id → тоже мягкий откат', async () => {
  const db = fakeDb((row) => (row.user_id ? MISSING_COL : null))
  await insertWithOwner(db, 'goals', { id: 'g1', user_id: 'usr_x' })
  assert.equal(db.calls.length, 2)
  assert.ok(!('user_id' in db.calls[1].row))
})

test('insertWithOwner: ЧУЖОЙ FK (не по владельцу) не глотается — роняем', async () => {
  const db = fakeDb(() => FK_OTHER) // ошибка всегда, даже без user_id
  await assert.rejects(
    () => insertWithOwner(db, 'leads', { id: 'l1', user_id: 'usr_x', campaign_id: 'cmp_x' }),
    /foreign key/i,
  )
  assert.equal(db.calls.length, 1, 'отката быть не должно — это не про владельца')
})

test('updateWithOwner: FK владельца → повтор без user_id', async () => {
  const db = fakeDb((row) => (row.user_id ? FK_OWNER : null))
  await updateWithOwner(db, 'leads', { status: 'warm', user_id: 'usr_x' }, 'id', 'l1')
  assert.equal(db.calls.length, 2)
  assert.ok(!('user_id' in db.calls[1].row))
})

test('ownerOf: колонка приоритетнее дубля в data', () => {
  assert.equal(ownerOf({ user_id: 'usr_1', data: { userId: 'usr_2' } }), 'usr_1')
  assert.equal(ownerOf({ data: { userId: 'usr_2' } }), 'usr_2')
  assert.equal(ownerOf({}), '')
})
