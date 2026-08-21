import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  beginAccountWork, endAccountWork, waitAccountWork, releaseTaskBusy, getAccountBusy,
} from '../lib/accountBusy.js'

/**
 * Многомодульность (решение владельца 20.08): аккаунт работает в нескольких модулях,
 * но два действия в одну секунду физически невозможны + пауза при переключении модулей.
 */

test('занятый действием аккаунт не берётся другой задачей, своей — берётся', () => {
  const now = 1_000_000
  assert.equal(beginAccountWork('bz_a', 'mailing', 't1', now).ok, true)
  assert.equal(getAccountBusy('bz_a').moduleKey, 'mailing')

  const denied = beginAccountWork('bz_a', 'neuro-commenting', 't2', now + 1000)
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /занят действием.*Мейлинг/)
  assert.ok(denied.until > now, 'должен сказать, когда пробовать снова')

  // Повторный вход той же задачи — мгновенный (переподключение внутри одного действия).
  assert.equal(beginAccountWork('bz_a', 'mailing', 't1', now + 1000).ok, true)
  endAccountWork('bz_a', 't1', now + 2000)
  assert.equal(getAccountBusy('bz_a'), null)
})

test('пауза при переключении модулей: тот же модуль сразу, другой — ждёт', () => {
  const now = 2_000_000
  beginAccountWork('bz_b', 'neuro-commenting', 't1', now)
  endAccountWork('bz_b', 't1', now)

  // Тот же модуль — без паузы переключения (темп держат задержки самой задачи).
  assert.equal(beginAccountWork('bz_b', 'neuro-commenting', 't1', now + 100).ok, true)
  endAccountWork('bz_b', 't1', now + 200)

  // Другой модуль сразу после — пауза (человек не переключается мгновенно).
  const denied = beginAccountWork('bz_b', 'mass-react', 't2', now + 300)
  assert.equal(denied.ok, false)
  assert.match(denied.reason, /переключени/)
  // Пауза случайная 1–5 с — но через 6 с точно открыто.
  assert.equal(beginAccountWork('bz_b', 'mass-react', 't2', now + 6300).ok, true)
  endAccountWork('bz_b', 't2', now + 7000)
})

test('чужой endAccountWork слот не снимает, releaseTaskBusy подчищает задачу', () => {
  const now = 3_000_000
  beginAccountWork('bz_c', 'warming', 't1', now)
  endAccountWork('bz_c', 't_other', now + 10) // чужая задача — no-op
  assert.equal(getAccountBusy('bz_c').taskId, 't1')

  beginAccountWork('bz_d', 'warming', 't1', now)
  releaseTaskBusy('t1', now + 20)
  assert.equal(getAccountBusy('bz_c'), null)
  assert.equal(getAccountBusy('bz_d'), null)
})

test('waitAccountWork: ждёт освобождения, по таймауту — отказ, а не отъём слота', async () => {
  beginAccountWork('bz_e', 'mailing', 't1')
  let released = false
  // Освобождаем слот через ~30 мс параллельно с ожиданием.
  setTimeout(() => { endAccountWork('bz_e', 't1'); released = true }, 30)
  const waited = await waitAccountWork('bz_e', 'mailing', 't2', { timeoutMs: 5000 })
  assert.equal(released, true)
  assert.ok(waited >= 0)
  assert.equal(getAccountBusy('bz_e').taskId, 't2')
  endAccountWork('bz_e', 't2')

  // Таймаут: слот занят и не освобождается. Раньше он отбирался силой — прежний владелец
  // при этом продолжал работать своим живым клиентом, и оба модуля действовали одним
  // аккаунтом одновременно. Теперь — отказ: вызывающий берёт следующую цель/аккаунт.
  beginAccountWork('bz_f', 'mailing', 't1')
  await assert.rejects(
    () => waitAccountWork('bz_f', 'neuro-dialogs', 't3', { timeoutMs: 60 }),
    (err) => err.code === 'ACCOUNT_BUSY',
  )
  assert.equal(getAccountBusy('bz_f').taskId, 't1', 'слот остался у прежнего владельца')
  releaseTaskBusy('t1')
})

test('waitAccountWork: «Стоп» прерывает ожидание сразу, а не через таймаут', async () => {
  beginAccountWork('bz_g', 'mailing', 't1')
  let stop = false
  setTimeout(() => { stop = true }, 30)
  const started = Date.now()
  await assert.rejects(
    () => waitAccountWork('bz_g', 'neuro-dialogs', 't2', { timeoutMs: 60_000, shouldStop: () => stop }),
    (err) => err.code === 'ABORTED_BY_STOP',
  )
  assert.ok(Date.now() - started < 5000, 'стоп не должен ждать конца таймаута')
  releaseTaskBusy('t1')
})
