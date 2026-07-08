import { loadSessionString, createClient } from '../tgAuth.js'
import { getAccountMeta, setAccountMeta } from '../accountsMeta.js'
import { isAccountRunnable, extractFloodSeconds, sleep } from './protection.js'
import { assertAccountAvailable } from './accountLocks.js'

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

/** @param {object} task @param {string} accountId @param {object} store @param {unknown} err @param {object} settings */
export async function handleFlood(task, accountId, store, err, settings, accountName) {
  const floodSec = extractFloodSeconds(err)
  if (floodSec <= 0) return false
  task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
  task.accountStats[accountId].floodWaits += 1
  const fwDelay = floodSec + (settings.delays?.floodWait ?? 120)
  await store.appendLog(task, 'warning', `FloodWait ${floodSec}с — пауза ${fwDelay}с`, accountName)
  await sleep(fwDelay * 1000)
  const limit = settings.delays?.floodQuarantine ?? 3
  if (task.accountStats[accountId].floodWaits >= limit) {
    await setAccountMeta(accountId, { status: 'quarantine' })
    await store.appendLog(task, 'error', `Карантин после ${limit} FloodWait`, accountName)
  }
  await store.saveTask(task)
  return true
}

/** @param {object} settings @param {string} accountId */
export function perAccountLimitReached(settings, accountId, task) {
  const max = settings.maxPerAccount || 0
  if (!max) return false
  const done = task.accountStats?.[accountId]?.actions ?? 0
  return done >= max
}

/** @param {object} settings */
export function totalLimitReached(settings, task) {
  const max = settings.maxActions ?? settings.maxComments ?? 100
  if (settings.workMode === 1 && settings.durationMinutes) {
    const endAt = task.startedAt + settings.durationMinutes * 60_000
    if (Date.now() >= endAt) return true
  }
  if (settings.workMode === 1 && !settings.durationMinutes) return false
  return (task.progress?.actionsDone ?? task.progress?.commentsSent ?? 0) >= max
}
