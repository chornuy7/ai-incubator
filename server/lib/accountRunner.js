import { loadSessionString, createClient } from '../tgAuth.js'
import { getAccountMeta, setAccountMeta } from '../accountsMeta.js'
import { isAccountRunnable, extractFloodSeconds, sleep } from './protection.js'
import { assertAccountAvailable } from './accountLocks.js'
import { resolveDurationPeriodMinutes } from './workModeDuration.js'
import { getAiSafetySync } from '../aiSafety.js'
import { resolvePerAccountTarget, resolveTotalTarget } from './targets.js'

/** @param {string} accountId @param {string} [taskId] */
export async function connectAccount(accountId, taskId) {
  assertAccountAvailable(accountId, taskId)
  const meta = await getAccountMeta(accountId)
  if (!isAccountRunnable(meta.status || 'active')) {
    throw new Error(`ACCOUNT_SKIP:${meta.status}`)
  }
  const sessionStr = await loadSessionString(accountId)
  if (!sessionStr) {
    await setAccountMeta(accountId, { status: 'reauth' })
    throw new Error('NO_SESSION')
  }
  await setAccountMeta(accountId, { status: 'working' })
  const client = await createClient(sessionStr, meta.proxy)
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
    await sleep(fwDelay * 1000)
    const limit = settings.delays?.floodQuarantine ?? safety.floodQuarantineThreshold ?? 3
    if (task.accountStats[accountId].floodWaits >= limit) {
      await setAccountMeta(accountId, { status: 'quarantine' })
      await store.appendLog(task, 'error', `Карантин после ${limit} FloodWait`, accountName)
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
      await setAccountMeta(accountId, { status: 'quarantine' })
      await store.appendLog(task, 'error', 'Спамблок → карантин аккаунта', accountName)
      await store.saveTask(task)
      return true
    }
    await setAccountMeta(accountId, { status: 'spamblock' })
    await store.appendLog(task, 'warning', 'Спамблок — аккаунт помечен и пропускается', accountName)
    await store.saveTask(task)
    return true
  }

  switch (safety.onBan) {
    case 'quarantine':
      await setAccountMeta(accountId, { status: 'quarantine' })
      await store.appendLog(task, 'error', 'Бан → карантин аккаунта (политика ИИ-безопасности)', accountName)
      await store.saveTask(task)
      return true
    case 'stop-account':
      await setAccountMeta(accountId, { status: 'invalid' })
      await store.appendLog(task, 'error', 'Бан → аккаунт остановлен (политика ИИ-безопасности)', accountName)
      await store.saveTask(task)
      return true
    case 'stop-task':
      task.stopRequested = true
      await setAccountMeta(accountId, { status: 'invalid' })
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
