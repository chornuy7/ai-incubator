import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-'))
process.env.SETTINGS_FILE = path.join(tmp, 'settings.json')
const { getSettings, getSetting, updateSettings, DEFAULT_SETTINGS } = await import('../settings.js')

test('без файла отдаются значения по умолчанию', async () => {
  const s = await getSettings()
  assert.equal(s.mailingMinTrust, DEFAULT_SETTINGS.mailingMinTrust)
  assert.equal(s.mailingMinTrust, 65, 'порог по умолчанию — 65')
})

test('порог сохраняется и читается обратно', async () => {
  const s = await updateSettings({ mailingMinTrust: 50 })
  assert.equal(s.mailingMinTrust, 50)
  assert.equal(await getSetting('mailingMinTrust'), 50)
})

test('значения зажимаются в границы — настройкой нельзя молча снять защиту', async () => {
  assert.equal((await updateSettings({ mailingMinTrust: -10 })).mailingMinTrust, 0)
  assert.equal((await updateSettings({ mailingMinTrust: 999 })).mailingMinTrust, 100)
  assert.equal((await updateSettings({ mailingMinTrust: 64.6 })).mailingMinTrust, 65, 'дробное округляется')
})

test('мусор и неизвестные ключи игнорируются, а не затирают настройки', async () => {
  await updateSettings({ mailingMinTrust: 65 })
  const s = await updateSettings({ mailingMinTrust: 'абв', чтоТоЛевое: 1 })
  assert.equal(s.mailingMinTrust, 65, 'нечисловое значение не применяется')
  assert.equal(s.чтоТоЛевое, undefined, 'неизвестный ключ не сохраняется')
})

test.after(async () => { await fs.rm(tmp, { recursive: true, force: true }) })
