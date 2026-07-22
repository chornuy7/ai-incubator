/**
 * §3.9: найти ЧАТ канала — место, где сидят живые люди.
 *
 * У канала подписчиков не видно: список участников закрыт, а «писавшие» — это сам
 * канал (один автор). Поэтому парсить надо не канал, а привязанный к нему чат.
 * Прогон 21.07 показал цену ошибки: 132 цели из 148 дали ровно `+1` — сам канал,
 * то есть мусор вместо людей.
 *
 * Чат бывает спрятан в трёх местах, проверяем по возрастанию цены запроса:
 *   1) привязанная дискуссия (`linkedChatId`) — бесплатно, приходит с `getFullChannel`;
 *   2) ссылка в описании канала (About) — тот же ответ, парсим текст;
 *   3) ссылка в последних постах — «Channel | Chat» в подписи. Дороже всего:
 *      это ещё один `getMessages`, а лишние запросы — прямой путь к FloodWait.
 *      Поэтому смотрим только 2–3 последних поста (решение владельца).
 */

/** Ссылки на t.me из текста: и явные, и вида «@name». */
export function telegramLinks(text) {
  const s = String(text || '')
  const out = []
  const seen = new Set()
  const push = (name) => {
    const n = String(name || '').replace(/^@/, '').replace(/\/+$/, '').trim()
    // `+`/`joinchat` — приглашения в закрытые чаты, их резолвить нечем без вступления.
    if (!n || n.startsWith('+') || /^joinchat/i.test(n) || n.length < 4) return
    const key = n.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(n)
  }
  for (const m of s.matchAll(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{4,})/gi)) push(m[1])
  for (const m of s.matchAll(/(?<![\w/])@([A-Za-z][A-Za-z0-9_]{3,})/g)) push(m[1])
  return out
}

/**
 * Похоже ли слово на ссылку именно на ЧАТ (а не на второй канал/бота).
 * Подпись «Crypto Navigator | Channel | Chat» — самый частый вид футера.
 */
export function looksLikeChatLink(name, context = '') {
  const n = String(name || '').toLowerCase()
  // Латиницей, кириллицей и транслитом — в русскоязычном Telegram встречается всё трое.
  if (/chat|чат|discus|обсужд|obsuzh|talk|community|комьюнити|flud|флуд/.test(n)) return true
  // Слово «чат» рядом со ссылкой в тексте — тоже сигнал.
  const ctx = String(context || '').toLowerCase()
  const at = ctx.indexOf(n)
  if (at === -1) return false
  const around = ctx.slice(Math.max(0, at - 40), at + n.length + 40)
  return /chat|чат|обсужд|discussion/.test(around)
}

/** Мегагруппа = чат. Канал — нет: в нём пишет только администрация. */
export function isMegagroup(entity) {
  return !!entity && (entity.megagroup === true || entity.className === 'Chat')
}

/**
 * Это канал (вещание), а не чат? Только у таких имеет смысл искать привязанный чат:
 * если цель сама по себе группа, парсить надо её же.
 */
export function isChannelPeer(entity) {
  return !!entity && entity.className === 'Channel' && entity.megagroup !== true
}

/**
 * Найти чат канала. Возвращает `{ peer, via }` либо null, если чата нет.
 *
 * @param {object} client GramJS-клиент
 * @param {object} peer канал
 * @param {{
 *   getFull: (peer:any) => Promise<any>,
 *   resolve: (name:string) => Promise<any>,
 *   getMessages: (peer:any, opts:object) => Promise<any[]>,
 *   postsToScan?: number,
 * }} io доступ к Telegram вынесен наружу — так это тестируется без сети
 * @returns {Promise<{ peer:any, via:'discussion'|'about'|'posts' }|null>}
 */
export async function findChannelChat(client, peer, io) {
  const postsToScan = io.postsToScan ?? 3

  // 1) Привязанная дискуссия — самый надёжный и уже оплаченный вариант.
  let full = null
  try { full = await io.getFull(peer) } catch { /* нет доступа — идём дальше */ }
  const linked = full?.fullChat?.linkedChatId ?? full?.linkedChatId
  if (linked) {
    try {
      const ent = await io.resolve(String(linked))
      if (ent) return { peer: ent, via: 'discussion' }
    } catch { /* привязка есть, а достать не смогли */ }
  }

  // 2) Ссылка в описании канала.
  const about = full?.fullChat?.about ?? full?.about ?? ''
  const fromAbout = telegramLinks(about).filter((n) => looksLikeChatLink(n, about))
  for (const name of fromAbout) {
    try {
      const ent = await io.resolve(name)
      if (isMegagroup(ent)) return { peer: ent, via: 'about' }
    } catch { /* не резолвится — следующая */ }
  }

  // 3) Подписи последних постов. Самый дорогой шаг — держим его коротким.
  try {
    const posts = await io.getMessages(peer, { limit: postsToScan })
    for (const post of posts || []) {
      const text = post?.message || ''
      for (const name of telegramLinks(text).filter((n) => looksLikeChatLink(n, text))) {
        try {
          const ent = await io.resolve(name)
          if (isMegagroup(ent)) return { peer: ent, via: 'posts' }
        } catch { /* следующая ссылка */ }
      }
    }
  } catch { /* посты недоступны */ }

  return null
}
