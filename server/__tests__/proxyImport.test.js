import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProxyLine, parseProxyList, countryLabel, buildLabel, nextIndexFor, assignLabels } from '../lib/proxyImport.js'

test('parseProxyLine: host:port', () => {
  assert.deepEqual(parseProxyLine('1.2.3.4:1080'), { scheme: 'socks5', host: '1.2.3.4', port: 1080, username: '', password: '' })
})

test('parseProxyLine: host:port:user:pass — самый частый формат у продавцов', () => {
  assert.deepEqual(parseProxyLine('1.2.3.4:1080:vasya:secret'),
    { scheme: 'socks5', host: '1.2.3.4', port: 1080, username: 'vasya', password: 'secret' })
})

test('parseProxyLine: user:pass:host:port — обратный порядок распознаётся по виду полей', () => {
  assert.deepEqual(parseProxyLine('vasya:secret:1.2.3.4:1080'),
    { scheme: 'socks5', host: '1.2.3.4', port: 1080, username: 'vasya', password: 'secret' })
})

test('parseProxyLine: user:pass@host:port и host:port@user:pass', () => {
  const expected = { scheme: 'socks5', host: '1.2.3.4', port: 1080, username: 'vasya', password: 'secret' }
  assert.deepEqual(parseProxyLine('vasya:secret@1.2.3.4:1080'), expected)
  assert.deepEqual(parseProxyLine('1.2.3.4:1080@vasya:secret'), expected)
})

test('parseProxyLine: схема из строки, https сводится к http', () => {
  assert.equal(parseProxyLine('http://1.2.3.4:8080').scheme, 'http')
  assert.equal(parseProxyLine('socks4://1.2.3.4:1080').scheme, 'socks4')
  assert.equal(parseProxyLine('https://1.2.3.4:8080').scheme, 'http')
  assert.equal(parseProxyLine('ftp://1.2.3.4:21'), null) // не прокси-схема
})

test('parseProxyLine: домен вместо IP, пароль с двоеточием', () => {
  assert.deepEqual(parseProxyLine('proxy.example.com:1080:user:pa:ss'),
    { scheme: 'socks5', host: 'proxy.example.com', port: 1080, username: 'user', password: 'pa:ss' })
})

test('parseProxyLine: пробелы и табы как разделители', () => {
  assert.deepEqual(parseProxyLine('1.2.3.4  1080\tvasya secret'),
    { scheme: 'socks5', host: '1.2.3.4', port: 1080, username: 'vasya', password: 'secret' })
})

test('parseProxyLine: мусор и комментарии → null', () => {
  for (const bad of ['', '   ', '# комментарий', '// тоже', 'просто текст', '1.2.3.4', '1.2.3.4:99999']) {
    assert.equal(parseProxyLine(bad), null, bad)
  }
})

test('parseProxyList: разбирает пачку, копит ошибки и режет дубли', () => {
  const { items, errors } = parseProxyList([
    '# мои прокси',
    '1.2.3.4:1080:u:p',
    '',
    '1.2.3.4:1080:u:p',      // дубль
    'кривая строка',
    'socks5://5.6.7.8:1080',
  ].join('\n'))

  assert.equal(items.length, 2)
  assert.equal(items[0].host, '1.2.3.4')
  assert.equal(items[1].host, '5.6.7.8')
  assert.equal(errors.length, 2)
  assert.match(errors[0].reason, /дубль/)
  assert.equal(errors[0].line, 4)      // номер строки настоящий — человеку надо найти её в файле
  assert.match(errors[1].reason, /разобрать/)
})

test('countryLabel: US → USA, GB → UK, остальное — код в верхнем регистре', () => {
  assert.equal(countryLabel('us'), 'USA')
  assert.equal(countryLabel('gb'), 'UK')
  assert.equal(countryLabel('de'), 'DE')
  assert.equal(countryLabel(''), 'XX')       // страна не определилась
  assert.equal(countryLabel('', 'pl'), 'PL')
})

test('buildLabel: шаблон без лишних пробелов при пустом теге', () => {
  assert.equal(buildLabel('{country} {tag} {n}', { country: 'USA', tag: 'SPAM', n: 1 }), 'USA SPAM 1')
  assert.equal(buildLabel('{country} {tag} {n}', { country: 'USA', tag: '', n: 3 }), 'USA 3')
  assert.equal(buildLabel('{tag}-{country}-{n}', { country: 'DE', tag: 'mob', n: 7 }), 'mob-DE-7')
})

test('nextIndexFor: продолжает нумерацию, а не затирает существующие', () => {
  assert.equal(nextIndexFor(['USA SPAM 1', 'USA SPAM 2', 'DE SPAM 1'], 'USA SPAM'), 3)
  assert.equal(nextIndexFor(['USA SPAM 1', 'USA SPAM 10'], 'USA SPAM'), 11)
  assert.equal(nextIndexFor([], 'USA SPAM'), 1)
  assert.equal(nextIndexFor(['USA SPAM резерв'], 'USA SPAM'), 1) // нечисловой хвост не мешает
})

test('assignLabels: нумерация отдельная по каждой стране', () => {
  const items = [
    { country: 'us', host: '1.1.1.1', port: 1080 },
    { country: 'de', host: '2.2.2.2', port: 1080 },
    { country: 'us', host: '3.3.3.3', port: 1080 },
  ]
  assert.deepEqual(assignLabels(items, { tag: 'SPAM' }), ['USA SPAM 1', 'DE SPAM 1', 'USA SPAM 2'])
})

test('assignLabels: дозагрузка продолжает нумерацию уже существующих', () => {
  const items = [{ country: 'us', host: '1.1.1.1', port: 1080 }, { country: 'us', host: '2.2.2.2', port: 1080 }]
  const labels = assignLabels(items, { tag: 'SPAM', existingLabels: ['USA SPAM 1', 'USA SPAM 2', 'USA SPAM 3'] })
  assert.deepEqual(labels, ['USA SPAM 4', 'USA SPAM 5'])
})

test('assignLabels: без страны — XX, импорт не ломается', () => {
  assert.deepEqual(assignLabels([{ host: '1.1.1.1', port: 1080 }], { tag: 'SPAM' }), ['XX SPAM 1'])
})
