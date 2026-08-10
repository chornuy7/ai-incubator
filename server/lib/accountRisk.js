/**
 * MR-131 (10.08): «зона риска» аккаунта с КОНКРЕТИКОЙ — последствие (блокировка) + срок.
 *
 * Раньше аккаунт с мёртвым/отсутствующим прокси всё равно показывался «Активный», и
 * оператор узнавал о риске только после бана. Теперь риск считается заранее из двух
 * НЕЗАВИСИМЫХ осей (заказчик просил их разделить):
 *   - прокси: мёртвый / отсутствует (Telegram видит реальный IP или смену IP);
 *   - статус/здоровье: спамблок, флудвейт, карантин, reauth, низкий trust.
 *
 * Возвращаем уровень + список факторов с человеческим текстом, чтобы UI показал
 * «высокая вероятность блокировки в течение недели», а не абстрактное «повышенный риск».
 */

const ORDER = { none: 0, low: 1, medium: 2, high: 3 }

/**
 * @param {{ status?: string, proxyOk?: boolean, noProxy?: boolean, trustBand?: string }} a
 * @returns {{ level: 'none'|'low'|'medium'|'high', factors: {kind:'proxy'|'status'|'trust', text:string}[], proxyIssue: boolean, statusIssue: boolean }}
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
    factors.push({ kind: 'proxy', text: 'Без прокси — работа с реального IP. Повышенный риск блокировки в течение ~2 недель. Назначьте прокси.' })
    bump('high')
  }

  // ── Ось 2: статус/здоровье аккаунта (отдельно от прокси) ──
  switch (a.status) {
    case 'spamblock':
      factors.push({ kind: 'status', text: 'Спамблок — ограничения активны сейчас. Модули пропускают аккаунт до снятия.' })
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
