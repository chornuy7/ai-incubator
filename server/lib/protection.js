/** Shared account protection — used by all module workers. */
import { getAiSafetySync } from '../aiSafety.js'

const LEVEL_MUL = [1.8, 1, 0.75]
const PRESET_MUL = [0.6, 1, 1.8]
const SKIP_STATUSES = new Set(['quarantine', 'spamblock', 'invalid', 'frozen', 'reauth', 'floodwait', 'pause'])

export function delayMultiplier(level, preset) {
  const safety = getAiSafetySync()
  const global = (safety.delayMultiplier || 1) * (safety.pacingMultiplier || 1)
  return (LEVEL_MUL[level] ?? 1) * (PRESET_MUL[preset] ?? 1) * global
}

export function pickDelay(from, to, mul = 1) {
  const lo = Math.max(5, Math.round(from * mul))
  const hi = Math.max(lo, Math.round((to ?? from) * mul))
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

/**
 * Нижняя граница паузы перед ВСТУПЛЕНИЕМ в канал (секунды).
 *
 * Вступления Telegram считает отдельно и жёстче остальных действий. Множитель
 * «агрессивного» уровня и пресета «мин» перемножались и срезали заданные 90–240с
 * до 32с (лог 21.07) — после чего аккаунты уходили в FloodWait и карантин.
 * Ускорять всё остальное можно, вступления — нет.
 */
export const MIN_JOIN_DELAY_SEC = 60

/**
 * Пауза перед вступлением: тот же `pickDelay`, но не ниже безопасного порога.
 * @param {number} from @param {number} to @param {number} [mul]
 */
export function pickJoinDelay(from, to, mul = 1) {
  return Math.max(MIN_JOIN_DELAY_SEC, pickDelay(from, to, mul))
}

export function effectiveProbability(probability, aiProtection, level) {
  let p = probability ?? 30
  if (aiProtection) {
    if (level === 0) p = Math.min(p, 25)
    else if (level === 1) p = Math.min(p, 45)
  }
  return p
}

export function isAccountRunnable(status) {
  return !SKIP_STATUSES.has(status)
}

/**
 * Статусы, при которых аккаунт не может писать ПЕРВЫМ, но может ОТВЕЧАТЬ.
 *
 * Спамблок в Telegram запрещает писать тем, кто с тобой не переписывался. Ответить
 * в уже открытый диалог он не мешает — человек написал сам, ограничение снято для
 * этой пары. Выбрасывать такой аккаунт из чатинга значит бросать живых собеседников
 * на полуслове: именно это и произошло 21–22.07, когда 11 аккаунтов ушли в спамблок
 * посреди диалогов.
 */
const REPLY_ONLY_STATUSES = new Set(['spamblock'])

/**
 * Можно ли использовать аккаунт в режиме «только ответы» (нейрочатинг/диалоги).
 * @param {string} status
 */
export function isAccountReplyOnly(status) {
  return REPLY_ONLY_STATUSES.has(status)
}

/**
 * Годится ли аккаунт для модуля, который только отвечает на входящие.
 * @param {string} status
 */
export function canReplyWithStatus(status) {
  return isAccountRunnable(status) || isAccountReplyOnly(status)
}

export function postMeetsMinWords(text, minWords) {
  if (!minWords) return true
  return (text || '').trim().split(/\s+/).filter(Boolean).length >= minWords
}

export function postMatchesKeywords(text, keywords) {
  if (!keywords?.length) return true
  const lower = (text || '').toLowerCase()
  return keywords.some((k) => lower.includes(k.toLowerCase()))
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * #6 (QA): прерываемый sleep — спит кусками и проверяет shouldStop() между ними,
 * чтобы «Стоп» срабатывал за ~1с, а не после полного длинного ожидания (напр. 146с).
 * @param {number} ms общая длительность @param {() => (boolean|Promise<boolean>)} [shouldStop]
 * @returns {Promise<boolean>} true — прервано по stop/pause
 */
export async function interruptibleSleep(ms, shouldStop, chunkMs = 1000) {
  const end = Date.now() + Math.max(0, ms)
  while (Date.now() < end) {
    await sleep(Math.min(chunkMs, end - Date.now()))
    try { if (shouldStop && (await shouldStop())) return true } catch { /* ignore */ }
  }
  return false
}

export function extractFloodSeconds(err) {
  if (!err || typeof err !== 'object') return 0
  const e = /** @type {{ seconds?: number, errorMessage?: string, message?: string }} */ (err)
  if (typeof e.seconds === 'number' && e.seconds > 0) return e.seconds
  const msg = `${e.errorMessage || e.message || ''}`
  const m = msg.match(/FLOOD_WAIT_(\d+)/i) || msg.match(/wait of (\d+) seconds/i)
  return m ? Number(m[1]) : 0
}

/** @param {unknown} err */
export function mapTelegramError(err) {
  const msg = `${/** @type {{ errorMessage?: string, message?: string }} */ (err).errorMessage || /** @type {{ message?: string }} */ (err).message || ''}`
  if (msg.includes('PEER_NOT_FOUND')) return 'Контакт не найден — обновите список диалогов'
  if (msg.includes('NO_DISCUSSION') || msg.includes('MSG_ID_INVALID')) return 'Нет обсуждения у поста или комментарии недоступны'
  // Этот код НЕ значит «аккаунт забанен» — аккаунт с ним спокойно входит и читает канал
  // (проверено 18.08). Но и «запрет в этом чате» тоже не значит: 22.08 живой прогон показал
  // тот же код на открытой всем группе у аккаунта без личных ограничений — @SpamBot на нём
  // отвечал «account is limited». Причин две, и лечатся они по-разному, поэтому здесь —
  // честная развилка; кто именно виноват, выясняет `diagnoseWriteBan` правами участника.
  // Слово «сообщение» здесь было лишним: тот же код прилетает и на РЕАКЦИЮ. В логах
  // массовых реакций (прогон 26.08) строка «не пропустил сообщение» стояла там, где
  // модуль ничего не пишет — читалось как чужая ошибка из другого модуля.
  if (msg.includes('USER_BANNED_IN_CHANNEL')) return 'Telegram не пропустил действие: спамблок аккаунта либо запрет в этом чате'
  // Реакции в канале ограничены: их разрешили только админам либо выключили вовсе.
  // Сырой код в логе (прогон 26.08) не говорил ни что случилось, ни что с этим делать.
  if (msg.includes('CHAT_ADMIN_REQUIRED')) return 'Реакции в этом канале разрешены только админам (или выключены) — аккаунт тут ничего не поставит'
  if (msg.includes('REACTION_INVALID')) return 'Эта эмодзи в канале запрещена — оставьте в наборе только разрешённые'
  if (msg.includes('REACTIONS_TOO_MANY')) return 'Лимит реакций на пост исчерпан'
  if (msg.includes('USER_BANNED') || msg.includes('USER_DEACTIVATED')) return 'Аккаунт заблокирован Telegram'
  if (msg.includes('CHANNEL_PRIVATE')) return 'Приватный канал/группа'
  if (msg.includes('FLOOD')) return 'FloodWait'
  if (msg.includes('INVITE_REQUEST_SENT')) return 'Заявка на вступление отправлена — нужно одобрение админа'
  if (msg.includes('NOT_A_MEMBER')) return 'Аккаунт не в группе/канале — вступите или дождитесь одобрения'
  // Сетевые/служебные коды — человеческим языком: в логах задачи оператор видел сырой
  // «RPC_TIMEOUT (25с)» и не понимал ни причины, ни что с этим делать.
  if (msg.includes('ABORTED_BY_STOP')) return 'Действие прервано остановкой задачи'
  if (msg.includes('RPC_TIMEOUT')) return 'Telegram не ответил — прокси принимает соединение, но не пропускает трафик Telegram. Замените прокси.'
  if (msg.includes('NO_SESSION')) return 'Нет сессии — аккаунт нужно переавторизовать'
  if (msg.includes('AUTH_KEY') || msg.includes('SESSION_REVOKED')) return 'Сессия недействительна — нужна переавторизация'
  if (/Прокси не отвечает|Не удалось подключиться/i.test(msg)) return 'Прокси не отвечает — замените его на рабочий'
  if (/socks|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(msg)) return 'Сеть/прокси недоступны — проверьте прокси аккаунта'
  if (msg) return msg.slice(0, 120)
  return 'Ошибка Telegram'
}
