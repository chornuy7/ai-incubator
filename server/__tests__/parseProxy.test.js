import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProxy } from '../proxy.js'

// MR-129: parseProxy раньше понимал ТОЛЬКО URL (scheme://host:port). Прокси в формате
// host:port:user:pass (как у продавцов и как хранит часть аккаунтов) давал null → раздел
// «Прокси» показывался пустым, а GramJS молча шёл напрямую (аккаунт без прокси, риск бана).

test('MR-129: URL-формат прокси парсится как раньше', () => {
  assert.deepEqual(parseProxy('socks5://1.2.3.4:1080'), { ip: '1.2.3.4', port: 1080, username: undefined, password: undefined, socksType: 5 })
  assert.deepEqual(parseProxy('http://1.1.1.1:3128'), { ip: '1.1.1.1', port: 3128, username: undefined, password: undefined })
})

test('MR-129: host:port:user:pass теперь парсится (socks5 по умолчанию), а не «не настроен»', () => {
  const p = parseProxy('10.20.30.40:1080:log:pwd')
  assert.equal(p?.ip, '10.20.30.40')
  assert.equal(p?.port, 1080)
  assert.equal(p?.username, 'log')
  assert.equal(p?.password, 'pwd')
  assert.equal(p?.socksType, 5, 'у продавцов по умолчанию socks5')
})

test('MR-129: host:port без учётки — тоже валидный прокси', () => {
  const p = parseProxy('5.6.7.8:8080')
  assert.equal(p?.ip, '5.6.7.8')
  assert.equal(p?.port, 8080)
})

test('MR-129: пусто / прочерк / мусор → null (прямое подключение)', () => {
  assert.equal(parseProxy(''), null)
  assert.equal(parseProxy('—'), null)
  assert.equal(parseProxy('не-прокси'), null)
  assert.equal(parseProxy(undefined), null)
})
