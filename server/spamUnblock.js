/**
 * Массовое снятие спамблока через @SpamBot — с РАНДОМНЫМИ задержками между аккаунтами.
 *
 * Почему задержки случайные: пачка апелляций «под копирку» в одну минуту с похожих
 * аккаунтов — сама по себе паттерн (§4.4 анти-кластер). Живой человек так не делает.
 *
 * Джоб — один на процесс, в памяти: старт кладёт задание, фоновый цикл идёт по аккаунтам,
 * прогресс читается опросом. Не воркер задачи — это разовая сервисная операция.
 */
import { loadSessionString, createClient } from './tgAuth.js'
import { accountFingerprint } from './lib/deviceFingerprint.js'
import { getAccountMeta, setAccountStatus, setAccountMeta } from './accountsMeta.js'
import { appealSpamblock } from './lib/spamAppeal.js'
import { appendAudit } from './lib/auditLog.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Одно задание на процесс. null — ничего не идёт. */
let job = null

/** Текущее состояние для опроса из UI. */
export function unblockStatus() {
  if (!job) return { running: false, total: 0, done: 0, cleared: 0, results: [] }
  return {
    running: job.running,
    total: job.total,
    done: job.done,
    cleared: job.cleared,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    delay: { min: job.delayMin, max: job.delayMax },
    results: job.results.slice(-200), // последние — не раздуваем ответ
  }
}

/** Снять спамблок с одного аккаунта: подключиться, апеллировать, при успехе — вернуть в строй. */
async function appealOne(accountId) {
  const meta = await getAccountMeta(accountId).catch(() => ({}))
  const name = meta?.name || accountId.slice(-6)
  const sessionStr = await loadSessionString(accountId).catch(() => '')
  if (!sessionStr) return { accountId, name, state: 'unknown', text: 'нет сессии', appealed: false, ts: Date.now() }
  let client
  try {
    client = await createClient(sessionStr, meta.proxy, accountFingerprint(accountId, meta))
    const res = await appealSpamblock(client)
    try { await client.disconnect() } catch { /* ignore */ }
    if (res.state === 'clean') {
      // Ограничений больше нет — возвращаем аккаунт в работу. Переход может быть
      // не разрешён state-machine — тогда мягкий fallback, как в accountRunner.
      try {
        await setAccountStatus(accountId, 'active', { code: '', reason: 'Спамблок снят через @SpamBot', initiator: 'system' })
      } catch { await setAccountMeta(accountId, { status: 'active', statusReason: 'Спамблок снят через @SpamBot' }).catch(() => {}) }
    }
    return { accountId, name, state: res.state, text: res.text, appealed: res.appealed, ts: Date.now() }
  } catch (e) {
    try { if (client) await client.disconnect() } catch { /* ignore */ }
    return { accountId, name, state: 'error', text: e instanceof Error ? e.message : 'ошибка подключения', appealed: false, ts: Date.now() }
  }
}

/**
 * Запустить массовое снятие. Фоновый цикл; запрос возвращается сразу.
 * @param {string[]} accountIds @param {{delayMin?:number, delayMax?:number}} [opts]
 */
export async function startUnblock(accountIds, opts = {}) {
  if (job?.running) throw new Error('Снятие спамблока уже идёт — дождитесь окончания')
  const ids = [...new Set((Array.isArray(accountIds) ? accountIds : []).map((x) => String(x || '').trim()).filter(Boolean))]
  if (!ids.length) throw new Error('Не выбраны аккаунты')
  // Задержки: минимум 5 c (иначе @SpamBot сам ограничит темп), по умолчанию 30–120 c.
  const delayMin = Math.max(5, Math.round(Number(opts.delayMin) || 30))
  const delayMax = Math.max(delayMin, Math.round(Number(opts.delayMax) || 120))

  job = { running: true, total: ids.length, done: 0, cleared: 0, results: [], startedAt: Date.now(), finishedAt: null, delayMin, delayMax, stopRequested: false }

  ;(async () => {
    for (let i = 0; i < ids.length; i++) {
      if (job.stopRequested) break
      const r = await appealOne(ids[i])
      job.results.push(r)
      job.done += 1
      if (r.state === 'clean') job.cleared += 1
      // Рандомная пауза перед следующим (после последнего не ждём).
      if (i < ids.length - 1 && !job.stopRequested) {
        const secs = delayMin + Math.random() * (delayMax - delayMin)
        await sleep(Math.round(secs * 1000))
      }
    }
    job.running = false
    job.finishedAt = Date.now()
    await appendAudit({
      action: 'accounts.unblock', module: 'accounts', initiator: 'operator',
      reason: `Снятие спамблока: снято ${job.cleared} из ${job.done} (задержки ${delayMin}–${delayMax}с)`,
      meta: { total: job.total, cleared: job.cleared },
    }).catch(() => {})
  })()

  return { started: ids.length, delayMin, delayMax }
}

/** Остановить текущее снятие (мягко — после текущего аккаунта). */
export function stopUnblock() {
  if (job?.running) { job.stopRequested = true; return true }
  return false
}
