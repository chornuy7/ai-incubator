import { loadSessionString, createClient } from '../tgAuth.js'
import { getAccountMeta, setAccountMeta, setAccountStatus } from '../accountsMeta.js'
import { isAccountRunnable, extractFloodSeconds, sleep } from './protection.js'
import { assertAccountAvailable } from './accountLocks.js'
import { resolveDurationPeriodMinutes } from './workModeDuration.js'
import { getAiSafetySync } from '../aiSafety.js'
import { resolvePerAccountTarget, resolveTotalTarget } from './targets.js'
import { accountFingerprint } from './deviceFingerprint.js'

/** @param {string} accountId @param {string} [taskId] */
export async function connectAccount(accountId, taskId) {
  assertAccountAvailable(accountId, taskId)
  const meta = await getAccountMeta(accountId)
  if (!isAccountRunnable(meta.status || 'active')) {
    throw new Error(`ACCOUNT_SKIP:${meta.status}`)
  }
  const sessionStr = await loadSessionString(accountId)
  if (!sessionStr) {
    await setStatus(accountId, 'reauth', { code: 'NO_SESSION', reason: 'Нет сессии — нужна переавторизация', task: { id: taskId } })
    throw new Error('NO_SESSION')
  }
  await setAccountMeta(accountId, { status: 'working' })
  const client = await createClient(sessionStr, meta.proxy, accountFingerprint(accountId, meta))
  return { client, meta }
}

/** @param {import('telegram').TelegramClient} client @param {string} accountId */
export async function disconnectAccount(client, accountId) {
  try {
    await client.disconnect()
  } catch {
    /* ignore */
  }
  const meta = await getAccountMeta(accountId)
  if (meta.status === 'working') await setAccountMeta(accountId, { status: 'active' })
}

/**
 * Сменить статус аккаунта через state machine + аудит (§4). Не роняет воркер:
 * при недопустимом переходе падаем на прямую запись meta (совместимость).
 * @param {string} accountId @param {string} to @param {{ code?: string, reason?: string, until?: number|null, task?: object }} [opts]
 */
async function setStatus(accountId, to, opts = {}) {
  try {
    await setAccountStatus(accountId, to, {
      code: opts.code,
      reason: opts.reason,
      until: opts.until ?? null,
      initiator: 'system',
      module: opts.task?.moduleKey,
      taskId: opts.task?.id,
    })
  } catch (err) {
    // Недопустимый переход или сбой — не роняем воркер, но не молчим (аудит-пробел виден).
    console.warn(`[status] setAccountStatus(${accountId.slice(-6)}→${to}) fallback:`, err?.message || err)
    await setAccountMeta(accountId, { status: to })
  }
}

/**
 * Обработка ошибки аккаунта: FloodWait + политики ИИ-безопасности (feature 11).
 * Возвращает true, если ошибка «обработана» (генерик-лог в воркере не нужен).
 * @param {object} task @param {string} accountId @param {object} store @param {unknown} err @param {object} settings
 */
export async function handleFlood(task, accountId, store, err, settings, accountName) {
  const safety = getAiSafetySync()
  const floodSec = extractFloodSeconds(err)
  if (floodSec > 0) {
    task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
    task.accountStats[accountId].floodWaits += 1
    const fwDelay = floodSec + (settings.delays?.floodWait ?? safety.floodWaitExtraSeconds ?? 120)
    await store.appendLog(task, 'warning', `FloodWait ${floodSec}с — пауза ${fwDelay}с`, accountName)
    // Явный статус floodwait с длительностью (§3.3): аккаунт на паузу, никто по нему не работает.
    await setStatus(accountId, 'floodwait', { code: `FLOOD_WAIT_${floodSec}`, reason: `FloodWait ${floodSec}с`, until: Date.now() + fwDelay * 1000, task })
    await sleep(fwDelay * 1000)
    const limit = settings.delays?.floodQuarantine ?? safety.floodQuarantineThreshold ?? 3
    if (task.accountStats[accountId].floodWaits >= limit) {
      await setStatus(accountId, 'quarantine', { code: 'FLOOD_QUARANTINE', reason: `Карантин после ${limit} FloodWait`, task })
      await store.appendLog(task, 'error', `Карантин после ${limit} FloodWait`, accountName)
    } else {
      // Пауза выждана — возвращаем в работу.
      await setStatus(accountId, 'active', { code: 'FLOOD_CLEARED', reason: 'FloodWait истёк — возврат в работу', task })
    }
    await store.saveTask(task)
    return true
  }
  return applyBanPolicy(task, accountId, store, err, accountName)
}

/**
 * Политики на бан/спамблок из ИИ-безопасности (feature 11).
 * Дефолт onBan='continue' сохраняет прежнее поведение (просто лог ошибки в воркере).
 * @param {object} task @param {string} accountId @param {object} store @param {unknown} err @param {string} [accountName]
 */
export async function applyBanPolicy(task, accountId, store, err, accountName) {
  const msg = `${/** @type {any} */ (err)?.errorMessage || /** @type {any} */ (err)?.message || ''}`
  const isBan = /USER_BANNED|USER_DEACTIVATED|BANNED|AUTH_KEY|ACCOUNT_.*BAN/i.test(msg)
  const isSpam = /SPAM|PEER_FLOOD/i.test(msg)
  if (!isBan && !isSpam) return false
  const safety = getAiSafetySync()

  if (isSpam) {
    if (safety.onSpamblock === 'quarantine') {
      await setStatus(accountId, 'quarantine', { code: 'SPAM', reason: 'Спамблок → карантин аккаунта', task })
      await store.appendLog(task, 'error', 'Спамблок → карантин аккаунта', accountName)
      await store.saveTask(task)
      return true
    }
    await setStatus(accountId, 'spamblock', { code: 'SPAM', reason: 'Спамблок — аккаунт помечен и пропускается', task })
    await store.appendLog(task, 'warning', 'Спамблок — аккаунт помечен и пропускается', accountName)
    await store.saveTask(task)
    return true
  }

  switch (safety.onBan) {
    case 'quarantine':
      await setStatus(accountId, 'quarantine', { code: 'BAN', reason: 'Бан → карантин аккаунта (политика ИИ-безопасности)', task })
      await store.appendLog(task, 'error', 'Бан → карантин аккаунта (политика ИИ-безопасности)', accountName)
      await store.saveTask(task)
      return true
    case 'stop-account':
      await setStatus(accountId, 'invalid', { code: 'BAN', reason: 'Бан → аккаунт остановлен (политика ИИ-безопасности)', task })
      await store.appendLog(task, 'error', 'Бан → аккаунт остановлен (политика ИИ-безопасности)', accountName)
      await store.saveTask(task)
      return true
    case 'stop-task':
      task.stopRequested = true
      await setStatus(accountId, 'invalid', { code: 'BAN', reason: 'Бан → задача остановлена (политика ИИ-безопасности)', task })
      await store.appendLog(task, 'error', 'Бан → задача остановлена (политика ИИ-безопасности)', accountName)
      await store.saveTask(task)
      return true
    default:
      return false
  }
}

/** @param {object} settings @param {string} accountId */
export function perAccountLimitReached(settings, accountId, task) {
  // Суточный кап из ИИ-безопасности (мягкое ограничение на уровне задачи).
  const dailyCap = getAiSafetySync().perAccountDailyCap || 0
  const done = task.accountStats?.[accountId]?.actions ?? 0
  if (dailyCap > 0 && done >= dailyCap) return true

  const target = resolvePerAccountTarget(settings, accountId, task)
  if (!target) return false
  return done >= target
}

/** @param {object} settings */
export function totalLimitReached(settings, task) {
  const target = resolveTotalTarget(settings, task)
  if (settings.workMode === 1 && settings.durationMinutes) {
    const period = resolveDurationPeriodMinutes(settings, { taskId: task.id, startedAt: task.startedAt })
    if (!period) return false
    const endAt = task.startedAt + period.chosen * 60_000
    if (Date.now() >= endAt) return true
  }
  if (settings.workMode === 1 && !settings.durationMinutes) return false
  return (task.progress?.actionsDone ?? task.progress?.commentsSent ?? 0) >= target
}
