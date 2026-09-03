/**
 * MR-185: промпт принадлежит человеку, а не браузеру.
 *
 * Созвон 24.08: «при редактировании промтов применяется на всех пользователей свои
 * промты, а должно применяться только на 1 аккаунт». Проверяем ровно тот сценарий,
 * который заказчик просил гонять руками: один изменил — у другого заводской.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DEFAULTS = ['дефолт-0', 'дефолт-1', 'дефолт-2']

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompts-'))
  process.env.USER_PROMPTS_FILE = path.join(dir, 'user-prompts.json')
  return import(`../userPrompts.js?t=${Date.now()}${Math.round(performance.now())}`)
}

test('промпт одного пользователя не достаётся другому', async () => {
  const s = await freshStore()
  await s.saveUserPrompts('usr_1', 'neuro-commenting', ['мой текст', 'дефолт-1', 'дефолт-2'], DEFAULTS)

  assert.deepEqual(await s.getUserPrompts('usr_1', 'neuro-commenting'), { 0: 'мой текст' })
  assert.deepEqual(await s.getUserPrompts('usr_2', 'neuro-commenting'), {}, 'у второго — ничего своего, значит увидит заводской')
})

test('промпты разных модулей не смешиваются', async () => {
  const s = await freshStore()
  await s.saveUserPrompts('usr_1', 'neuro-commenting', ['комменты', 'дефолт-1', 'дефолт-2'], DEFAULTS)
  await s.saveUserPrompts('usr_1', 'neuro-chatting', ['чаты', 'дефолт-1', 'дефолт-2'], DEFAULTS)

  assert.deepEqual(await s.getUserPrompts('usr_1', 'neuro-commenting'), { 0: 'комменты' })
  assert.deepEqual(await s.getUserPrompts('usr_1', 'neuro-chatting'), { 0: 'чаты' })
})

test('заводские тексты в базе не хранятся — только изменённые', async () => {
  const s = await freshStore()
  const saved = await s.saveUserPrompts('usr_1', 'neuro-commenting', DEFAULTS, DEFAULTS)
  assert.deepEqual(saved, {}, 'ничего не меняли — хранить нечего')
  assert.deepEqual(await s.getUserPrompts('usr_1', 'neuro-commenting'), {})
})

test('возврат карточки к заводскому убирает строку, а не хранит копию дефолта', async () => {
  const s = await freshStore()
  await s.saveUserPrompts('usr_1', 'neuro-commenting', ['свой', 'тоже свой', 'дефолт-2'], DEFAULTS)
  assert.deepEqual(await s.getUserPrompts('usr_1', 'neuro-commenting'), { 0: 'свой', 1: 'тоже свой' })

  await s.saveUserPrompts('usr_1', 'neuro-commenting', ['свой', 'дефолт-1', 'дефолт-2'], DEFAULTS)
  assert.deepEqual(await s.getUserPrompts('usr_1', 'neuro-commenting'), { 0: 'свой' }, 'вторая карточка вернулась к заводской — строки быть не должно')
})

test('пустой текст — это возврат к заводскому, а не промпт из пустоты', async () => {
  const s = await freshStore()
  await s.saveUserPrompts('usr_1', 'neuro-commenting', ['   ', 'дефолт-1', 'дефолт-2'], DEFAULTS)
  assert.deepEqual(await s.getUserPrompts('usr_1', 'neuro-commenting'), {})
})

test('повторное сохранение переписывает строку, а не плодит копии', async () => {
  const s = await freshStore()
  await s.saveUserPrompts('usr_1', 'neuro-commenting', ['первый', 'дефолт-1', 'дефолт-2'], DEFAULTS)
  await s.saveUserPrompts('usr_1', 'neuro-commenting', ['второй', 'дефолт-1', 'дефолт-2'], DEFAULTS)
  assert.deepEqual(await s.getUserPrompts('usr_1', 'neuro-commenting'), { 0: 'второй' })
})

test('без владельца или модуля не читаем и не пишем', async () => {
  const s = await freshStore()
  assert.deepEqual(await s.getUserPrompts('', 'neuro-commenting'), {})
  assert.deepEqual(await s.getUserPrompts('usr_1', ''), {})
  assert.deepEqual(await s.saveUserPrompts('', 'neuro-commenting', ['текст'], DEFAULTS), {})
})
