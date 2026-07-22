/**
 * Регресс-тесты на правки по итогам ручного прогона 21–22.07.
 * Каждый тест назван номером теста из чек-листа, чтобы связь с находкой не терялась.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeTargets } from '../targetFolders.js'
import { postErrorHint } from '../modules/workers.js'
import { foldersForRequest } from '../lib/accessGuard.js'

const mockReq = (headers = {}) => ({ header: (h) => headers[h.toLowerCase()] })
const FOLDERS = [
  { id: 'fld_a', name: 'Крипто', targets: ['c1', 'c2'] },
  { id: 'fld_b', name: 'IT', targets: ['c3'] },
]

// ── 11.7-d: дедуп целей папки регистронезависим ──────────────────────────
test('11.7-d: @NuancesProg и nuancesprog — одна цель, а не две', () => {
  const t = normalizeTargets(['@NuancesProg', 'nuancesprog', 'NUANCESPROG'])
  assert.deepEqual(t, ['nuancesprog'], 'юзернеймы Telegram регистронезависимы')
})

test('11.7-d: @, пробелы и регистр схлопываются вместе', () => {
  const t = normalizeTargets(['  @IT_Boooks ', 'it_boooks', '@dadaqqqeqw', ''])
  assert.deepEqual(t, ['it_boooks', 'dadaqqqeqw'])
})

test('11.7-d: порядок первого вхождения сохраняется', () => {
  assert.deepEqual(normalizeTargets(['b', 'a', 'B', 'A']), ['b', 'a'])
})

// ── 10.1: подсказка про права админа — только для ошибок доступа ─────────
test('10.1: CHAT_ADMIN_REQUIRED получает подсказку про права', () => {
  const s = postErrorHint(new Error('CHAT_ADMIN_REQUIRED'))
  assert.match(s, /админом канала/, 'здесь подсказка уместна')
})

test('10.1: ошибка прокси НЕ получает подсказку про права админа', () => {
  const s = postErrorHint(new Error('Invalid sockets params: ip=1.2.3.4, port=7063, socksType=undefined'))
  assert.doesNotMatch(s, /админ/i, 'иначе оператор идёт проверять права, а дело в прокси')
})

test('10.1: сетевая ошибка НЕ получает подсказку про права админа', () => {
  assert.doesNotMatch(postErrorHint(new Error('TIMEOUT')), /админ/i)
})

test('10.1: CHAT_WRITE_FORBIDDEN — тоже про доступ, подсказка нужна', () => {
  assert.match(postErrorHint(new Error('CHAT_WRITE_FORBIDDEN')), /админом канала/)
})

// ── 11.7: права на папки применяются НА СЕРВЕРЕ, а не только во фронте ───
test('11.7: без сессии отдаём все папки (дев/демо, как moduleAccessGuard)', async () => {
  assert.deepEqual(await foldersForRequest(mockReq(), FOLDERS), FOLDERS)
})

test('11.7: неизвестный пользователь не получает НИ ОДНОЙ папки (fail-closed)', async () => {
  const out = await foldersForRequest(mockReq({ 'x-user-id': 'нет-такого-юзера' }), FOLDERS)
  assert.deepEqual(out, [], 'иначе прямой запрос отдаёт базы каналов всех ролей')
})

test('11.7: исходный массив не мутируется', async () => {
  const copy = JSON.parse(JSON.stringify(FOLDERS))
  await foldersForRequest(mockReq({ 'x-user-id': 'нет-такого-юзера' }), FOLDERS)
  assert.deepEqual(FOLDERS, copy)
})
