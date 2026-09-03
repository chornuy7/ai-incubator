/**
 * §9.11: разложить аудиторию рассылки — кому написали, кого пропустили, до кого не дошли.
 *
 * Главный вопрос после прогона: «кого брать в следующий заход». Счётчики отвечают
 * «35 из 1000», но не говорят КТО эти 35, — а без этого повторная рассылка либо
 * пишет людям второй раз, либо человек вручную сверяет тысячу строк.
 *
 * Считаем по истории задачи: в ней записана каждая попытка со своим исходом.
 */

/** Единый вид цели: «@name» для юзернеймов, «+7999…» для номеров. */
export function normalizeTarget(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  if (/^\+?\d[\d\s()-]{6,}$/.test(s)) return `+${s.replace(/\D/g, '')}`
  // Протокол необязателен: люди вставляют и «t.me/user», и полную ссылку.
  return `@${s.replace(/^(https?:\/\/)?(www\.)?t\.me\//i, '').replace(/^@/, '').replace(/\/+$/, '')}`
}

/** Ключ сравнения: «user1», «@user1» и «t.me/user1» — один человек. */
export function targetKey(raw) {
  const t = normalizeTarget(raw)
  return t.startsWith('+') ? t.replace(/\D/g, '') : t.slice(1).toLowerCase()
}

/**
 * Восстановить, каким аккаунтом писали, если в записи истории этого нет.
 *
 * Записи старых прогонов сохраняли только имя аккаунта — а чтобы открыть переписку,
 * нужен его id: история диалога своя у каждого аккаунта. Достаём id по имени, а если
 * в задаче участвовал ровно один аккаунт, вариантов и вовсе нет.
 * @param {{id:string, name?:string}[]} accounts аккаунты задачи
 * @param {string} [name] имя из записи истории
 */
export function resolveAccountId(accounts, name) {
  const list = accounts || []
  if (name) {
    const hit = list.find((a) => a.name && a.name === name)
    if (hit) return hit.id
    // Имя могло записаться как сам id — так бывает у аккаунтов без имени.
    const byId = list.find((a) => a.id === name)
    if (byId) return byId.id
  }
  return list.length === 1 ? list[0].id : undefined
}

/**
 * @param {string[]} targets исходные цели задачи (`settings.targets`)
 * @param {object[]} history история задачи
 * @param {{ accounts?: {id:string, name?:string}[] }} [opts] аккаунты задачи —
 *   ими дозаполняем `accountId` в записях, где его не сохранили
 * @returns {{ sent:object[], skipped:object[], failed:object[], remaining:object[] }}
 *   `sent` — написали · `skipped` — таких нет в Telegram (в следующий заход брать
 *   бессмысленно) · `failed` — сорвалось из-за аккаунта (брать СТОИТ) ·
 *   `remaining` — до них просто не дошли (стоп, лимиты, спамблоки).
 */
export function splitAudience(targets = [], history = [], opts = {}) {
  const sent = []
  const skipped = []
  const failed = []
  /** @type {Map<string,string>} ключ цели → итоговый статус */
  const outcome = new Map()

  // История хранится от новых к старым — идём по времени, чтобы поздняя удачная
  // отправка перекрывала раннюю ошибку, а не наоборот.
  for (const h of [...(history || [])].reverse()) {
    const target = normalizeTarget(h?.target || h?.peer || '')
    if (!target) continue
    const key = targetKey(target)
    const row = {
      target,
      peer: h.peer || (target.startsWith('@') ? target : undefined),
      // Без accountId переписку не открыть — для старых записей восстанавливаем.
      accountId: h.accountId || resolveAccountId(opts.accounts, h.accountName),
      accountName: h.accountName,
      reason: h.reason,
      ts: h.ts,
    }
    if (h.status === 'sent') {
      if (outcome.get(key) === 'sent') continue
      // Написали позже, чем сорвалось, — человек считается написанным.
      for (const list of [skipped, failed]) {
        const at = list.findIndex((r) => targetKey(r.target) === key)
        if (at !== -1) list.splice(at, 1)
      }
      sent.push(row)
      outcome.set(key, 'sent')
    } else if (h.status === 'skipped' && !outcome.has(key)) {
      skipped.push(row); outcome.set(key, 'skipped')
    } else if (h.status === 'failed' && !outcome.has(key)) {
      failed.push(row); outcome.set(key, 'failed')
    }
  }

  const remaining = []
  const seen = new Set()
  for (const raw of targets || []) {
    const target = normalizeTarget(raw)
    if (!target) continue
    const key = targetKey(target)
    if (outcome.has(key) || seen.has(key)) continue
    seen.add(key)
    remaining.push({ target })
  }

  return { sent, skipped, failed, remaining }
}
