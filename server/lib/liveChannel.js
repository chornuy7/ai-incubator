/**
 * Живой канал панели: сервер сам сообщает об изменениях, а панель их не выспрашивает.
 *
 * ЗАЧЕМ. Баланс и поддержка опрашивались по таймеру и заново на каждой загрузке страницы.
 * Замер показал, во что это обходится: `/api/balance` в одиночку отвечает 0.7 с, а в
 * залпе из девятнадцати запросов при открытии страницы — 2.3–2.6 с; на боевом сервере
 * владелец видел 3.81 с ожидания. Дело не в самой ручке, а в очереди: два десятка
 * запросов разом, каждый со своими обращениями к базе. Опрос — главный поставщик этой
 * очереди, и он же почти всегда возвращает «ничего не изменилось».
 *
 * ПОЧЕМУ WEBSOCKET, А НЕ SSE. Перед Node стоит nginx, и в его конфиге уже проброшены
 * `Upgrade`/`Connection` (deploy/nginx-ai-incubator.conf) — апгрейд соединения проходит
 * как есть. Для SSE в том же конфиге пришлось бы отдельно гасить `proxy_buffering`,
 * иначе события копятся в буфере и приходят пачкой или не приходят вовсе.
 *
 * ЧТО ЭТО НЕ ДЕЛАЕТ. Канал только УВЕДОМЛЯЕТ: «баланс изменился», «пришло сообщение».
 * Данные панель забирает обычной ручкой. Так у данных остаётся один источник и одна
 * проверка доступа — иначе рядом с REST появился бы второй протокол со своими правилами,
 * и однажды они разошлись бы в том, кому что видно.
 *
 * ДОСТУП. Личность берётся из того же подписанного токена, что и у HTTP-запросов, и
 * проверяется тем же кодом. Токена нет или он не проходит — соединение закрывается сразу.
 * Пока замок выключен (дев без SESSION_SECRET), пускаем без личности — как и HTTP.
 */
import { WebSocketServer } from 'ws'
import { verifySession, authEnforced } from './session.js'

/** Кому что слать: userId → набор живых соединений. */
const комнаты = new Map()

/** Сколько ждём ответа на ping, прежде чем считать соединение мёртвым. */
const ТАЙМАУТ_МС = 45_000

let wss = null

/**
 * Поднять канал поверх уже слушающего HTTP-сервера.
 * @param {import('http').Server} server
 */
export function attachLiveChannel(server) {
  const первый = !wss
  if (!wss) wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    let url
    try { url = new URL(req.url || '', 'http://localhost') } catch { return socket.destroy() }
    if (url.pathname !== '/api/live') return socket.destroy()

    /*
     * Токен приходит query-параметром, а не заголовком: браузерный WebSocket не даёт
     * задать заголовки при подключении. Он одноразово уходит в строке адреса ЛОКАЛЬНОГО
     * запроса на апгрейд — в историю браузера такой адрес не попадает, а nginx пишет его
     * только в свой access-лог, где уже лежат все остальные адреса панели.
     */
    const сессия = verifySession(url.searchParams.get('token') || '')
    if (!сессия && authEnforced()) return socket.destroy()

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = сессия?.userId || ''
      ws.isAlive = true
      подписать(ws)
      wss.emit('connection', ws, req)
    })
  })

  if (!первый) return wss

  wss.on('connection', (ws) => {
    ws.on('pong', () => { ws.isAlive = true })
    ws.on('close', () => отписать(ws))
    ws.on('error', () => отписать(ws))
    // Первое сообщение — подтверждение, что канал жив: панель по нему выключает опрос.
    сказать(ws, 'ready', { userId: ws.userId || null })
  })

  /*
   * Мёртвые соединения надо закрывать самим.
   *
   * Оборванное соединение (спящий ноутбук, потерянный Wi-Fi) не присылает `close` — оно
   * просто перестаёт отвечать. Без пинга такие накапливаются, и сервер шлёт события в
   * никуда, держа память под каждым.
   */
  const пинг = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { отписать(ws); ws.terminate(); continue }
      ws.isAlive = false
      try { ws.ping() } catch { отписать(ws) }
    }
  }, ТАЙМАУТ_МС)
  пинг.unref?.()

  return wss
}

function подписать(ws) {
  const key = ws.userId || '*'
  if (!комнаты.has(key)) комнаты.set(key, new Set())
  комнаты.get(key).add(ws)
}

function отписать(ws) {
  const key = ws.userId || '*'
  const набор = комнаты.get(key)
  if (!набор) return
  набор.delete(ws)
  if (!набор.size) комнаты.delete(key)
}

function сказать(ws, event, payload) {
  if (ws.readyState !== 1) return
  try { ws.send(JSON.stringify({ event, payload })) } catch { /* соединение уже рвётся */ }
}

/**
 * Сообщить одному человеку, что у него что-то изменилось.
 *
 * Событие НЕ несёт данных — только повод сходить за ними обычной ручкой. Слать сюда сам
 * баланс значило бы завести второй способ его получить, со своей проверкой доступа.
 *
 * @param {string} userId @param {string} event @param {object} [payload]
 */
export function notifyUser(userId, event, payload = {}) {
  if (!wss) return
  const id = String(userId || '')
  if (!id) return
  for (const ws of комнаты.get(id) || []) сказать(ws, event, payload)
  // Дев без замка: личности нет, но панель открыта — уведомляем всех безымянных.
  if (!authEnforced()) for (const ws of комнаты.get('*') || []) сказать(ws, event, payload)
}

/** Сообщить нескольким сразу — например владельцу и его сотрудникам. */
export function notifyUsers(userIds = [], event, payload = {}) {
  for (const id of new Set(userIds.filter(Boolean))) notifyUser(id, event, payload)
}

/** Сколько сейчас живых соединений — для /api/health и диагностики. */
export function liveConnections() {
  let n = 0
  for (const набор of комнаты.values()) n += набор.size
  return n
}
