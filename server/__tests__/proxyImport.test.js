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

// ── Баги массового импорта, найдено 21.07 (docs/BUGS-2026-07-21-proxy-import.md) ──

test('баг 1: строка-заголовок «http:» задаёт схему для следующих строк', () => {
  // Ровно тот список, что прислал продавец: пары портов, один HTTP, второй SOCKS5.
  const text = [
    'http:',
    '138.201.202.99:7063:avjycaue:qsjsiodh',
    '',
    'socks5:',
    '138.201.202.99:7163:avjycaue:qsjsiodh',
  ].join('\n')

  const { items, errors } = parseProxyList(text)
  assert.equal(items.length, 2)
  assert.equal(items[0].scheme, 'http', 'порт 7063 работает только по HTTP')
  assert.equal(items[0].port, 7063)
  assert.equal(items[1].scheme, 'socks5', 'порт 7163 работает только по SOCKS5')
  assert.equal(items[1].port, 7163)
  assert.equal(errors.length, 0, 'заголовки схем — не ошибки разбора')
})

test('баг 1: заголовки в разных начертаниях', () => {
  for (const header of ['HTTP:', 'socks5', '[SOCKS5]', 'https:', ' http : ']) {
    const { items } = parseProxyList(`${header}\n1.2.3.4:1080`)
    assert.equal(items.length, 1, `«${header}» должен пониматься как заголовок`)
    assert.ok(['http', 'socks5'].includes(items[0].scheme), `«${header}» → ${items[0].scheme}`)
  }
})

test('баг 5: ссылка смены IP не считается ошибкой разбора', () => {
  const { items, errors, rotationLinks } = parseProxyList(
    'http:\n1.2.3.4:7063:u:p\nhttp://138.201.202.99:8881/changeip/abc123',
  )
  assert.equal(items.length, 1)
  assert.equal(errors.length, 0, 'сервисная ссылка — не сломанная строка')
  assert.deepEqual(rotationLinks, ['http://138.201.202.99:8881/changeip/abc123'])
})

test('схема из заголовка важнее выбранной в форме, но только ниже заголовка', () => {
  const { items } = parseProxyList('1.1.1.1:1080\nhttp:\n2.2.2.2:8080', { scheme: 'socks5' })
  assert.equal(items[0].scheme, 'socks5', 'до заголовка — схема из формы')
  assert.equal(items[1].scheme, 'http', 'после заголовка — из заголовка')
})
