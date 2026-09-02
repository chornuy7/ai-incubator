/**
 * Живой канал: кому доходит событие и кого не пускают.
 *
 * Канал заменил опрос баланса и поддержки. Опрос был медленным, но безопасным: каждый
 * запрос проходил обычную проверку доступа. У постоянного соединения проверка одна — при
 * подключении, и ошибиться в ней значит открыть чужие уведомления навсегда, а не на один
 * запрос. Поэтому проверяется именно это: замок и адресность.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocket } from 'ws'

const СЕКРЕТ = 'тест-секрет-живого-канала'

/** Поднять сервер с каналом на свободном порту. */
async function поднять({ замок }) {
  if (замок) process.env.SESSION_SECRET = СЕКРЕТ
  else delete process.env.SESSION_SECRET
  // Модуль читает секрет при каждом вызове, но кэшируется как ESM — грузим один раз.
  const { attachLiveChannel, notifyUser, liveConnections } = await import('../lib/liveChannel.js')
  const { signSession } = await import('../lib/session.js')
  const server = http.createServer((_, res) => res.end('ok'))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  attachLiveChannel(server)
  const port = server.address().port
  return { server, port, notifyUser, liveConnections, signSession }
}

/** Подключиться и дождаться первого сообщения (или отказа). */
function соединиться(port, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live${token ? `?token=${encodeURIComponent(token)}` : ''}`)
    const итог = { ws, сообщения: [] }
    const готово = setTimeout(() => resolve({ ...итог, статус: 'молчит' }), 1500)
    ws.on('message', (raw) => {
      итог.сообщения.push(JSON.parse(String(raw)))
      if (итог.сообщения.length === 1) { clearTimeout(готово); resolve({ ...итог, статус: 'подключён' }) }
    })
    ws.on('error', () => { clearTimeout(готово); resolve({ ...итог, статус: 'отказ' }) })
    ws.on('unexpected-response', () => { clearTimeout(готово); resolve({ ...итог, статус: 'отказ' }) })
  })
}

const ждать = (мс) => new Promise((r) => setTimeout(r, мс))

test('без токена при включённом замке не пускают', async () => {
  /*
   * Главная проверка. Соединение живёт часами: пустить безымянного один раз — значит
   * оставить ему поток чужих уведомлений до перезапуска сервера.
   */
  const { server, port } = await поднять({ замок: true })
  try {
    const { статус } = await соединиться(port, '')
    assert.equal(статус, 'отказ', 'соединение без подписанного токена обязано закрываться сразу')
  } finally { server.close() }
})

test('чужой токен не проходит — подпись проверяется', async () => {
  const { server, port } = await поднять({ замок: true })
  try {
    // Форма правильная, подпись — нет. Ровно то, что подделает злоумышленник.
    const { статус } = await соединиться(port, 'dXNyX2FkbWlu.9999999999999.поддельная')
    assert.equal(статус, 'отказ')
  } finally { server.close() }
})

test('событие уходит ТОЛЬКО адресату', async () => {
  /*
   * Уведомление о балансе и поддержке — личное. Разослать его всем подключённым значило
   * бы сказать каждому, что у соседа списались деньги и пришло обращение.
   */
  const { server, port, notifyUser, signSession } = await поднять({ замок: true })
  try {
    const свой = await соединиться(port, signSession('usr_свой'))
    const чужой = await соединиться(port, signSession('usr_чужой'))
    assert.equal(свой.статус, 'подключён')
    assert.equal(чужой.статус, 'подключён')

    notifyUser('usr_свой', 'balance')
    await ждать(300)

    const событияСвоего = свой.сообщения.filter((m) => m.event === 'balance')
    const событияЧужого = чужой.сообщения.filter((m) => m.event === 'balance')
    assert.equal(событияСвоего.length, 1, 'адресат события не получил')
    assert.equal(событияЧужого.length, 0, 'событие ушло постороннему')

    свой.ws.close(); чужой.ws.close()
  } finally { server.close() }
})

test('в событии нет самих данных — только повод перечитать', async () => {
  /*
   * Слать каналом баланс или текст обращения значило бы завести им второй путь к данным
   * со своей проверкой доступа. Пути два — разойдутся однажды именно в том, кому что
   * видно. Канал говорит «изменилось», данные панель берёт обычной ручкой.
   */
  const { server, port, notifyUser, signSession } = await поднять({ замок: true })
  try {
    const кл = await соединиться(port, signSession('usr_1'))
    notifyUser('usr_1', 'support', { ticketId: 'TK-1' })
    await ждать(300)
    const событие = кл.сообщения.find((m) => m.event === 'support')
    assert.ok(событие, 'событие не пришло')
    assert.deepEqual(Object.keys(событие.payload), ['ticketId'], 'в событии не должно быть ничего, кроме ссылки на объект')
    кл.ws.close()
  } finally { server.close() }
})

test('чужой путь не поднимает соединение', async () => {
  // Канал висит на одном адресе. Апгрейд на любом другом — это либо ошибка, либо
  // разведка; и в том и в другом случае соединение открывать нечего.
  const { server, port } = await поднять({ замок: true })
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/что-нибудь`)
    const статус = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('молчит'), 1200)
      ws.on('open', () => { clearTimeout(t); resolve('открылось') })
      ws.on('error', () => { clearTimeout(t); resolve('отказ') })
    })
    assert.equal(статус, 'отказ')
  } finally { server.close() }
})
