/**
 * MR-185: глобальный системный промпт — свой у каждого человека.
 *
 * Было: один текст на всю платформу. Админ дописал себе строку — она уехала ВСЕМ:
 * субам, другим владельцам, во все их запуски. Владелец 27.08: правка под администратором
 * остаётся у администратора, под тестовым модератором — у него.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiset-'))
  process.env.USER_AI_SETTINGS_FILE = path.join(dir, 'user-ai-settings.json')
  return import(`../userAiSettings.js?t=${Date.now()}${Math.round(performance.now())}`)
}

test('правка одного человека не достаётся другому', async () => {
  const m = await freshStore()
  await m.setUserGlobalPrompt('usr_admin', 'Пиши как администратор')
  assert.equal(await m.getOwnGlobalPrompt('usr_admin'), 'Пиши как администратор')
  assert.equal(await m.getOwnGlobalPrompt('usr_test'), '', 'у второго своего промпта нет')
})

test('у каждого свой текст, и они не смешиваются', async () => {
  const m = await freshStore()
  await m.setUserGlobalPrompt('usr_1', 'первый')
  await m.setUserGlobalPrompt('usr_2', 'второй')
  assert.equal(await m.getOwnGlobalPrompt('usr_1'), 'первый')
  assert.equal(await m.getOwnGlobalPrompt('usr_2'), 'второй')
})

test('повторное сохранение переписывает свой текст, а не плодит записи', async () => {
  const m = await freshStore()
  await m.setUserGlobalPrompt('usr_1', 'было')
  await m.setUserGlobalPrompt('usr_1', 'стало')
  assert.equal(await m.getOwnGlobalPrompt('usr_1'), 'стало')
})

test('пустой текст убирает личную настройку, а не хранит пустоту', async () => {
  const m = await freshStore()
  await m.setUserGlobalPrompt('usr_1', 'мой текст')
  await m.setUserGlobalPrompt('usr_1', '')
  assert.equal(await m.getOwnGlobalPrompt('usr_1'), '', 'личной строки не осталось')
})

test('без владельца не пишем — записать было бы некуда', async () => {
  const m = await freshStore()
  await assert.rejects(() => m.setUserGlobalPrompt('', 'текст'))
  assert.equal(await m.getOwnGlobalPrompt(''), '')
})

test('пока своего нет — подставляется прежний общий текст, а не пустота', async () => {
  const m = await freshStore()
  const { setAiSettings } = await import('../aiSettings.js')
  await setAiSettings({ globalSystemPrompt: 'общий текст платформы' })
  assert.equal(await m.getUserGlobalPrompt('usr_new'), 'общий текст платформы')
})

test('свой текст перебивает общий', async () => {
  const m = await freshStore()
  const { setAiSettings } = await import('../aiSettings.js')
  await setAiSettings({ globalSystemPrompt: 'общий' })
  await m.setUserGlobalPrompt('usr_1', 'личный')
  assert.equal(await m.getUserGlobalPrompt('usr_1'), 'личный')
  assert.equal(await m.getUserGlobalPrompt('usr_2'), 'общий', 'у другого остаётся общий')
})
