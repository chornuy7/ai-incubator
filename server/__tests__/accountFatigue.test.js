/**
 * D1/D3 (SPEC §4.1–§4.3): усталость и распорядок аккаунта — сквозь модули.
 * Заказчик: аккаунты должны вести себя «как живые люди», а не работать без остановки.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_FATIGUE, DEFAULT_SCHEDULE, currentFatigue, fatigueGate,
  applyAction, scheduleGate, normalizeFatigueProfile,
  normalizeSchedule, scheduleToPercent, scheduleForAccount,
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

test('§4.2: ночью 2–4 не пишем — это палит ботов', () => {
  for (const h of [2, 3, 4]) {
    const g = scheduleGate(DEFAULT_SCHEDULE, at(h), () => 0)
    assert.equal(g.ok, false, `в ${h}:00 аккаунт не должен работать даже при удачном броске`)
  }
})

test('§4.2: днём аккаунт РАБОТАЕТ, а не отсеивается броском кубика', () => {
  // Регресс живого прогона 23.07: при 2–3% днём модуль честно завершался с нулём
  // действий, и продукт выглядел сломанным. Человечность держат усталость и паузы,
  // а не редкие попадания в вероятность.
  for (const h of [9, 11, 13, 15, 17, 20]) {
    const g = scheduleGate(DEFAULT_SCHEDULE, at(h), () => 0.5)
    assert.equal(g.ok, true, `в ${h}:00 средний бросок обязан проходить, иначе модуль стоит`)
    assert.ok(g.chance >= 0.7, `${h}:00 — рабочий час, шанс ${g.chance} слишком мал`)
  }
})

test('§4.2: глубокая ночь всё же остаётся редкой', () => {
  assert.equal(scheduleGate(DEFAULT_SCHEDULE, at(1), () => 0.5).ok, false, 'в 1:00 пишут единицы')
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

test('§4.2: распорядок редактируется в ПРОЦЕНТАХ (0–100)', () => {
  // Оператор вводит «80», а не «0.8». Значение >1 однозначно читается как процент:
  // доли больше единицы не бывает, а процента меньше единицы — не бывает на практике.
  const s = normalizeSchedule({ 9: 80, 10: 100, 11: 0 })
  assert.equal(s[9], 0.8)
  assert.equal(s[10], 1)
  assert.equal(s[11], 0, 'явный ноль — это ноль, а не «не задано»')
  assert.equal(scheduleGate(s, at(10), () => 0.99).ok, true, '100% — проходит любой бросок')
})

test('§4.2: доли 0..1 тоже принимаются — старые записи не ломаются', () => {
  const s = normalizeSchedule({ 9: 0.8, 10: 0.5 })
  assert.equal(s[9], 0.8)
  assert.equal(s[10], 0.5)
})

test('§4.2: пропущенный час берётся из умолчаний, а не считается нулём', () => {
  // Частично заполненная форма иначе молча усыпила бы аккаунт на 23 часа.
  const s = normalizeSchedule({ 9: 50 })
  assert.equal(s[9], 0.5)
  assert.equal(s[13], DEFAULT_SCHEDULE[13])
  assert.equal(Object.keys(s).length, 24, 'таблица всегда полная')
})

test('§4.2: мусор и выход за 0–100 не проходят', () => {
  const s = normalizeSchedule({ 9: 900, 10: -50, 11: 'абв' })
  assert.equal(s[9], 1, 'больше 100% не бывает')
  assert.equal(s[10], 0)
  assert.equal(s[11], DEFAULT_SCHEDULE[11], 'нечисло — берём умолчание, не ноль')
})

test('§4.2: проценты возвращаются обратно без потерь', () => {
  const p = scheduleToPercent(normalizeSchedule({ 9: 85, 14: 40 }))
  assert.equal(p[9], 85)
  assert.equal(p[14], 40)
})

test('§4.4: у каждого аккаунта СВОЙ распорядок — иначе ферма видна по синхронности', () => {
  const ids = ['acc_a1', 'acc_b2', 'acc_c3', 'acc_d4', 'acc_e5', 'acc_f6']
  const shapes = new Set(ids.map((id) => JSON.stringify(scheduleForAccount(id))))
  assert.ok(shapes.size >= 3, `48 профилей с одной кривой оживают в одну минуту; разных: ${shapes.size}`)
})

test('§4.4: личный распорядок стабилен — аккаунт не меняет режим сна при рестарте', () => {
  assert.deepEqual(scheduleForAccount('acc_a1'), scheduleForAccount('acc_a1'))
})

test('§4.4: сдвиг не превращает рабочий день в мёртвый', () => {
  // Разброс — это ±2 часа и амплитуда, а не «выключить аккаунт». Днём он обязан работать.
  for (const id of ['acc_a1', 'acc_b2', 'acc_c3', 'acc_d4']) {
    const s = scheduleForAccount(id)
    const day = [10, 11, 12, 13, 14, 15, 16].map((h) => s[h])
    assert.ok(Math.max(...day) >= 0.5, `${id}: днём максимум ${Math.max(...day)} — аккаунт почти мёртв`)
  }
})

/**
 * Профиль усталости должен ДОЕЗЖАТЬ до формы (правка 18.08).
 *
 * Список активности отдавал только `threshold`, поэтому окно «Усталость и отдых»
 * рисовало умолчания 15/45/5 при каждом открытии. Пользователь читал это как «настройки
 * слетели после деплоя», а повторное «Применить» действительно затирало заданное.
 */
test('listActivity отдаёт весь профиль, а не один порог', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatigue-list-'))
  process.env.ACCOUNT_ACTIVITY_FILE = path.join(dir, 'activity.json')
  const A = await import(`../accountActivity.js?fatigue-list=${Date.now()}`)

  await A.setActivityProfile(['acc_1'], { profile: { threshold: 40, restMinutes: 120, recoveryPerHour: 9 } })
  const map = await A.listActivity()

  assert.equal(map.acc_1.threshold, 40)
  assert.equal(map.acc_1.restMinutes, 120, 'без этого поля форма покажет умолчание вместо заданного')
  assert.equal(map.acc_1.recoveryPerHour, 9)
})

test('профили аккаунтов независимы: свой порог у каждого', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatigue-each-'))
  process.env.ACCOUNT_ACTIVITY_FILE = path.join(dir, 'activity.json')
  const A = await import(`../accountActivity.js?fatigue-each=${Date.now()}`)

  await A.setActivityProfile(['acc_a'], { profile: { threshold: 5, restMinutes: 30, recoveryPerHour: 2 } })
  await A.setActivityProfile(['acc_b'], { profile: { threshold: 50, restMinutes: 300, recoveryPerHour: 20 } })
  const map = await A.listActivity()

  assert.equal(map.acc_a.threshold, 5)
  assert.equal(map.acc_b.threshold, 50, 'настройка одного аккаунта не должна перетирать соседний')
  assert.equal(map.acc_a.restMinutes, 30)
  assert.equal(map.acc_b.restMinutes, 300)
})
