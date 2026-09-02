/**
 * MR-131 (10.08): «зона риска» аккаунта с КОНКРЕТИКОЙ — последствие (блокировка) + срок.
 *
 * Раньше аккаунт с мёртвым/отсутствующим прокси всё равно показывался «Активный», и
 * оператор узнавал о риске только после бана. Теперь риск считается заранее из двух
 * НЕЗАВИСИМЫХ осей (заказчик просил их разделить):
 *   - прокси: мёртвый / отсутствует (Telegram видит реальный IP или смену IP);
 *   - статус/здоровье: спамблок, флудвейт, карантин, reauth, низкий trust.
 *
 * MR-292 добавил третью ось — ГЕО: страна аккаунта против страны прокси. Она отдельно
 * от прокси намеренно: прокси может быть живым и быстрым, и всё равно быть не из той
 * страны, где регистрировался профиль.
 *
 * Возвращаем уровень + список факторов с человеческим текстом, чтобы UI показал
 * «высокая вероятность блокировки в течение недели», а не абстрактное «повышенный риск».
 */

const ORDER = { none: 0, low: 1, medium: 2, high: 3 }

/**
 * @param {{ status?: string, proxyOk?: boolean, noProxy?: boolean, trustBand?: string,
 *           geo?: {mismatch: boolean, text: string}|null, limit?: {label: string, what: string}|null }} a
 * @returns {{ level: 'none'|'low'|'medium'|'high', factors: {kind:'proxy'|'status'|'trust'|'geo', text:string}[], proxyIssue: boolean, statusIssue: boolean }}
 */
export function computeAccountRisk(a) {
  const factors = []
  let level = 'none'
  const bump = (l) => { if (ORDER[l] > ORDER[level]) level = l }

  // ── Ось 1: прокси (отдельно от статуса аккаунта) ──
  if (a.proxyOk === false) {
    factors.push({ kind: 'proxy', text: 'Прокси не отвечает — Telegram видит смену IP. Высокая вероятность блокировки в течение недели. Назначьте рабочий прокси.' })
    bump('high')
  } else if (a.noProxy) {
    factors.push({ kind: 'proxy', text: 'Без прокси — работа с реального IP. Повышенный риск блокировки в течение недели. Назначьте прокси.' })
    bump('high')
  }

  // ── Ось 2: статус/здоровье аккаунта (отдельно от прокси) ──
  switch (a.status) {
    case 'spamblock':
      /*
       * MR-292: вид ограничения, если он посчитан, говорит конкретнее — «временный» и
       * «без срока» это разные судьбы аккаунта и разные действия оператора. Общая фраза
       * остаётся запасной: риск считают и там, где вид ещё не известен.
       */
      factors.push({ kind: 'status', text: a.limit ? `${a.limit.label}. ${a.limit.what}` : 'Спамблок — ограничения активны сейчас. Модули пропускают аккаунт до снятия.' })
      bump('high'); break
    case 'invalid':
    case 'reauth':
      factors.push({ kind: 'status', text: 'Нужна авторизация — аккаунт сейчас не работает. Пройдите реавторизацию.' })
      bump('high'); break
    case 'floodwait':
    case 'quarantine':
      factors.push({ kind: 'status', text: 'Временное ограничение (флудвейт/карантин) — подождите снятия по сроку.' })
      bump('medium'); break
    default: break
  }

  /*
   * ── Ось 3: гео (MR-292) ──
   *
   * Профиль, зарегистрированный под одну страну и работающий через IP другой, для
   * антиспама выглядит неестественно. Это НАША оценка, а не вердикт Telegram: платформа
   * причину ограничения не называет никогда — поэтому фактор риска, а не диагноз.
   */
  if (a.geo?.mismatch) {
    factors.push({ kind: 'geo', text: a.geo.text })
    bump(level === 'high' ? 'high' : 'medium')
  }

  // ── Trust: усиливает риск, но не перекрывает более острые проблемы ──
  if (a.trustBand === 'low') {
    factors.push({ kind: 'trust', text: 'Низкий trust — модули работают в консервативном режиме, риск ограничений выше.' })
    bump(level === 'high' ? 'high' : 'medium')
  }

  return {
    level,
    factors,
    proxyIssue: factors.some((f) => f.kind === 'proxy'),
    statusIssue: factors.some((f) => f.kind === 'status'),
  }
}

/** Короткая подпись уровня риска для бейджа. */
export function riskLabel(level) {
  return level === 'high' ? 'Зона риска' : level === 'medium' ? 'Риск' : level === 'low' ? 'Внимание' : ''
}
