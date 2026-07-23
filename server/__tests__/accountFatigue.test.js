/**
 * D1/D3 (SPEC §4.1–§4.3): усталость и распорядок аккаунта — сквозь модули.
 * Заказчик: аккаунты должны вести себя «как живые люди», а не работать без остановки.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_FATIGUE, DEFAULT_SCHEDULE, currentFatigue, fatigueGate,
  applyAction, scheduleGate, normalizeFatigueProfile,
} from '../lib/accountFatigue.js'

const HOUR = 60 * 60 * 1000
const at = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime() }

test('§4.1: после порога действий аккаунт уходит на отдых', () => {
  const now = Date.now()
  let st = {}
  for (let i = 0; i < DEFAULT_FATIGUE.threshold; i++) st = { ...st, ...applyAction(st, DEFAULT_FATIGUE, now) }
  assert.equal(st.fatigue, DEFAULT_FATIGUE.threshold)
  assert.ok(st.restUntil > now, 'достиг порога — назначен обязательный отдых')
  assert.equal(fatigueGate(st, DEFAULT_FATIGUE, now).ok, false)
})

test('§4.1: отдых СКВОЗНОЙ — обязательная пауза не обходится восстановлением', () => {
  const now = Date.now()
  // Усталость уже сгорела по времени, но принудительный отдых ещё идёт: именно это
  // не даёт освободившемуся аккаунту тут же уйти лить реакции в другом модуле.
  const st = { fatigue: 0, lastActionAt: now - 10 * HOUR, restUntil: now + 10 * 60000 }
  const g = fatigueGate(st, DEFAULT_FATIGUE, now)
  assert.equal(g.ok, false)
  assert.match(g.reason, /отдыхает/)
})

test('§4.1: усталость восстанавливается со временем', () => {
  const now = Date.now()
  const st = { fatigue: 10, lastActionAt: now - 2 * HOUR }
  assert.equal(currentFatigue(st, DEFAULT_FATIGUE, now), 0, '2 часа × 5 ед./час = 10')
  assert.equal(currentFatigue({ fatigue: 10, lastActionAt: now - HOUR }, DEFAULT_FATIGUE, now), 5)
})

test('§4.2: ночью 2–5 не пишем — это палит ботов', () => {
  for (const h of [2, 3, 4, 5]) {
    const g = scheduleGate(DEFAULT_SCHEDULE, at(h), () => 0)
    assert.equal(g.ok, false, `в ${h}:00 аккаунт не должен работать даже при удачном броске`)
  }
})

test('§4.2: днём на работе вероятность низкая, в обед — высокая', () => {
  assert.equal(scheduleGate(DEFAULT_SCHEDULE, at(11), () => 0.5).ok, false, '3% — обычно мимо')
  assert.equal(scheduleGate(DEFAULT_SCHEDULE, at(15), () => 0.2).ok, true, 'обед 30% — попали')
  assert.equal(scheduleGate(DEFAULT_SCHEDULE, at(7), () => 0.2).ok, true, 'едет на работу — пишет')
})

test('§4.5: профиль нормализуется — мусор и крайности не проходят', () => {
  const p = normalizeFatigueProfile({ threshold: 0, recoveryPerHour: 'абв', restMinutes: 99999 })
  assert.equal(p.threshold, 1, 'ноль действий сделал бы аккаунт вечно уставшим')
  assert.equal(p.recoveryPerHour, DEFAULT_FATIGUE.recoveryPerHour)
  assert.equal(p.restMinutes, 24 * 60, 'отдых дольше суток — почти наверняка опечатка')
})

test('applyAction не мутирует исходное состояние', () => {
  const st = { fatigue: 1, actionsTotal: 1 }
  const copy = { ...st }
  applyAction(st, DEFAULT_FATIGUE, Date.now())
  assert.deepEqual(st, copy)
})

// ── D4 (§4.4): анти-кластер — Telegram банит волнами по паттерну ──
test('§4.4: человеческий темп — мгновенный ответ невозможен', async () => {
  const { humanPace } = await import('../lib/antiCluster.js')
  const p = humanPace('Короткий ответ', 200)
  assert.ok(p.readMs >= 3000, 'меньше трёх секунд на чтение — сигнатура бота')
  const long = humanPace(Array(100).fill('слово').join(' '), 0)
  assert.ok(long.typeMs > 100000, '100 слов нельзя напечатать за секунду')
})

test('§4.4: один аккаунт не работает в пяти чатах параллельно', async () => {
  const { parallelChatsGate } = await import('../lib/antiCluster.js')
  assert.equal(parallelChatsGate(1).ok, true)
  assert.equal(parallelChatsGate(2).ok, false, 'у человека не десять рук')
})

test('§4.4: пачка с одного прокси — предупреждение о кластере', async () => {
  const { proxySpreadGate } = await import('../lib/antiCluster.js')
  const one = { a1: 'socks5://1.1.1.1:1080', a2: 'socks5://1.1.1.1:1080', a3: 'socks5://1.1.1.1:1080' }
  assert.equal(proxySpreadGate(one, ['a1', 'a2', 'a3']).ok, false)
  const spread = { a1: 'socks5://1.1.1.1:1080', a2: 'socks5://2.2.2.2:1080' }
  assert.equal(proxySpreadGate(spread, ['a1', 'a2']).ok, true)
})

test('§4.4: прямое подключение кластером не считается', async () => {
  const { proxySpreadGate } = await import('../lib/antiCluster.js')
  const direct = { a1: '—', a2: '—', a3: '—', a4: '—' }
  assert.equal(proxySpreadGate(direct, ['a1', 'a2', 'a3', 'a4']).ok, true,
    'это разные домашние IP, а не один шлюз')
})
