/**
 * Живой канал панели: сервер сам говорит, что изменилось.
 *
 * ЗАЧЕМ. Баланс и поддержка опрашивались по таймеру и заново при каждой загрузке
 * страницы. Замер на боевом сервере: `/api/balance` в одиночку отвечает 0.7 с, а в залпе
 * при открытии страницы — 2.3–2.6 с (владелец видел 3.81 с). Дело не в самой ручке, а в
 * очереди из двух десятков запросов, и опрос — её главный поставщик: он почти всегда
 * возвращает «ничего не изменилось».
 *
 * ЧТО ПРИХОДИТ. Только повод: `balance` — кошелёк изменился, `support` — в обращении
 * что-то произошло. Сами данные панель забирает обычной ручкой, с той же проверкой
 * доступа. Присылать данные каналом значило бы завести им второй путь со своими
 * правилами, и однажды эти правила разошлись бы.
 *
 * ОДНО СОЕДИНЕНИЕ НА ВКЛАДКУ. Модуль держит его сам и раздаёт подписки: иначе каждый
 * компонент открывал бы своё, и на странице их стало бы пять.
 */

type Handler = (payload: Record<string, unknown>) => void

const подписчики = new Map<string, Set<Handler>>()

let сокет: WebSocket | null = null
let попытка = 0
let таймерПереподключения: ReturnType<typeof setTimeout> | null = null
let закрыт = false

/** Живо ли соединение прямо сейчас — по этому признаку решают, нужен ли запасной опрос. */
export function liveConnected(): boolean {
  return !!сокет && сокет.readyState === WebSocket.OPEN
}

function адрес(): string | null {
  if (typeof window === 'undefined') return null
  const token = localStorage.getItem('ai-incubator:token') || ''
  const схема = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  /*
   * Адрес относительный: панель в разработке ходит через прокси vite, на проде — через
   * nginx на том же домене. Абсолютный адрес пришлось бы задавать настройкой и
   * рассинхронизировать с `/api`.
   */
  return `${схема}//${window.location.host}/api/live${token ? `?token=${encodeURIComponent(token)}` : ''}`
}

function запланироватьПереподключение() {
  if (закрыт || таймерПереподключения) return
  /*
   * Растущая пауза с потолком в полминуты. Без неё упавший сервер получает шквал
   * переподключений от каждой открытой вкладки ровно в тот момент, когда ему тяжелее
   * всего.
   */
  const пауза = Math.min(30_000, 500 * 2 ** Math.min(попытка, 6))
  попытка += 1
  таймерПереподключения = setTimeout(() => { таймерПереподключения = null; connectLive() }, пауза)
}

/** Открыть канал. Повторный вызов при живом соединении ничего не делает. */
export function connectLive(): void {
  if (typeof window === 'undefined') return
  закрыт = false
  if (сокет && (сокет.readyState === WebSocket.OPEN || сокет.readyState === WebSocket.CONNECTING)) return
  const url = адрес()
  if (!url) return

  try {
    сокет = new WebSocket(url)
  } catch {
    запланироватьПереподключение()
    return
  }

  сокет.onopen = () => { попытка = 0 }
  сокет.onmessage = (e) => {
    let событие = ''
    let payload: Record<string, unknown> = {}
    try {
      const данные = JSON.parse(String(e.data))
      событие = String(данные?.event || '')
      payload = данные?.payload && typeof данные.payload === 'object' ? данные.payload : {}
    } catch { return } // мусор в канале не должен ронять панель
    for (const h of подписчики.get(событие) || []) {
      try { h(payload) } catch { /* обработчик сам себе виноват — канал живёт дальше */ }
    }
  }
  сокет.onclose = () => { сокет = null; запланироватьПереподключение() }
  сокет.onerror = () => { try { сокет?.close() } catch { /* уже закрыт */ } }
}

/** Закрыть канал и больше не переподключаться — при выходе из панели. */
export function disconnectLive(): void {
  закрыт = true
  if (таймерПереподключения) { clearTimeout(таймерПереподключения); таймерПереподключения = null }
  try { сокет?.close() } catch { /* уже закрыт */ }
  сокет = null
}

/**
 * Подписаться на событие. Возвращает отписку — её обязательно звать при размонтировании,
 * иначе обработчик переживёт компонент и будет дёргать мёртвое состояние.
 */
export function onLive(event: string, handler: Handler): () => void {
  if (!подписчики.has(event)) подписчики.set(event, new Set())
  подписчики.get(event)!.add(handler)
  connectLive()
  return () => {
    подписчики.get(event)?.delete(handler)
    if (!подписчики.get(event)?.size) подписчики.delete(event)
  }
}
