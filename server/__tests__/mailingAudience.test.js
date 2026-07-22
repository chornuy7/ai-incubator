/**
 * Разбор аудитории рассылки (§9.11): после прогона нужно понять, кому написали,
 * а кого брать в следующий заход. Прогон 21–22.07: 35 из 1000 — и никакого способа
 * узнать, какие именно 35, кроме ручной сверки логов.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitAudience, normalizeTarget, targetKey } from '../lib/mailingAudience.js'

test('normalizeTarget: юзернеймы и номера приводятся к одному виду', () => {
  assert.equal(normalizeTarget('mojtabairani1'), '@mojtabairani1')
  assert.equal(normalizeTarget('@mojtabairani1'), '@mojtabairani1')
  assert.equal(normalizeTarget('https://t.me/mojtabairani1'), '@mojtabairani1')
  assert.equal(normalizeTarget('+380 (97) 270-24-24'), '+380972702424')
  assert.equal(normalizeTarget('  '), '')
})

test('targetKey: одна и та же цель в разных записях — один ключ', () => {
  assert.equal(targetKey('user1'), targetKey('@User1'))
  assert.equal(targetKey('+380972702424'), targetKey('380972702424'))
  assert.notEqual(targetKey('user1'), targetKey('user2'))
})

test('раскладывает цели по исходам, остальные — в «остались»', () => {
  const targets = ['user1', 'user2', 'user3', 'user4', 'user5']
  const history = [
    { target: '@user3', status: 'failed', reason: 'PRIVACY_PREMIUM_REQUIRED', ts: '3' },
    { target: '@user2', status: 'skipped', reason: 'нет в Telegram', ts: '2' },
    { target: '@user1', status: 'sent', peer: '@user1', accountName: 'Акк 1', ts: '1' },
  ]
  const a = splitAudience(targets, history)
  assert.deepEqual(a.sent.map((r) => r.target), ['@user1'])
  assert.deepEqual(a.skipped.map((r) => r.target), ['@user2'])
  assert.deepEqual(a.failed.map((r) => r.target), ['@user3'])
  assert.deepEqual(a.remaining.map((r) => r.target), ['@user4', '@user5'])
})

test('цель без «собаки» в настройках и с «собакой» в истории — не двоится', () => {
  const a = splitAudience(['mojtabairani1'], [{ target: '@mojtabairani1', status: 'sent' }])
  assert.equal(a.sent.length, 1)
  assert.equal(a.remaining.length, 0, 'иначе человеку напишут второй раз')
})

test('повторная удачная отправка перекрывает раннюю ошибку', () => {
  // История хранится от новых к старым: сначала сорвалось, потом получилось.
  const history = [
    { target: '@user1', status: 'sent', ts: '2' },
    { target: '@user1', status: 'failed', reason: 'FLOOD_WAIT', ts: '1' },
  ]
  const a = splitAudience(['user1'], history)
  assert.deepEqual(a.sent.map((r) => r.target), ['@user1'])
  assert.equal(a.failed.length, 0, 'человек написан — в ошибках ему не место')
  assert.equal(a.remaining.length, 0)
})

test('номер телефона сопоставляется с историей, где он с плюсом', () => {
  const a = splitAudience(['380972702424'], [{ target: '+380972702424', status: 'sent' }])
  assert.equal(a.sent.length, 1)
  assert.equal(a.remaining.length, 0)
})

test('дубли в исходном списке не раздувают «осталось»', () => {
  const a = splitAudience(['user1', '@user1', 't.me/user1'], [])
  assert.equal(a.remaining.length, 1)
})

test('пустая история — все в «осталось», ничего не потеряно', () => {
  const a = splitAudience(['a_user', 'b_user'], [])
  assert.equal(a.remaining.length, 2)
  assert.equal(a.sent.length + a.skipped.length + a.failed.length, 0)
})

test('на реальной форме записи мейлинга (боевой прогон)', () => {
  const history = [{
    id: 'mail_f22f69a4_1784665770593',
    ts: '2026-07-21T20:29:30.593Z',
    target: '@spx690ether',
    text: 'Привет! Вижу, ты интересуешься трейдингом…',
    status: 'sent',
  }]
  const a = splitAudience(['spx690ether', 'venem2'], history)
  assert.deepEqual(a.sent.map((r) => r.target), ['@spx690ether'])
  assert.deepEqual(a.remaining.map((r) => r.target), ['@venem2'])
  assert.equal(a.sent[0].peer, '@spx690ether', 'без peer не открыть переписку')
})
