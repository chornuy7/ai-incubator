import {
  ensureJoined,
  joinDiscussionGroupIfNeeded,
  membershipLogMessage,
  peekMembership,
  mapTelegramError,
} from '../lib/gramHelpers.js'

/**
 * Вступить в канал/группу/чат перед действием модуля.
 * @param {{ quietIfMember?: boolean }} [opts]
 */
export async function joinTargetOrSkip(client, raw, appendLog, accountName, opts = {}) {
  const { quietIfMember = false } = opts
  const membership = await ensureJoined(client, raw)

  if (membership.status === 'already_member' && quietIfMember) {
    return membership
  }

  const level = membership.status === 'request_sent'
    ? 'warning'
    : membership.status === 'joined'
      ? 'success'
      : membership.status === 'already_member'
        ? 'info'
        : 'info'

  if (membership.status !== 'already_member' || !quietIfMember) {
    await appendLog(level, membershipLogMessage(membership), accountName)
  }

  if (membership.status === 'request_sent' && !membership.peer) {
    return null
  }
  if (!membership.peer) {
    await appendLog('error', `Не удалось вступить в ${membership.label}`, accountName)
    return null
  }
  return membership
}

/** @param {{ quietIfMember?: boolean }} [opts] */
export async function joinChannelDiscussion(client, raw, appendLog, accountName, peer, opts = {}) {
  const { quietIfMember = false } = opts
  const disc = await joinDiscussionGroupIfNeeded(client, peer)
  if (disc?.status === 'joined') {
    await appendLog('success', 'Вступил в группу обсуждения канала', accountName)
  } else if (disc?.status === 'already_member' && !quietIfMember) {
    await appendLog('info', 'Уже в группе обсуждения', accountName)
  }
  return disc
}

/**
 * Подготовить цель: задержка join только при первом вступлении.
 * @returns {import('../lib/gramHelpers.js').ensureJoined extends (...args: any) => Promise<infer R> ? R | null : never}
 */
export async function prepareTarget(client, raw, appendLog, accountName, joinDelaySec, readyKeys, accountId) {
  const ch = raw.replace(/^@/, '').trim()
  const readyKey = `${accountId}:${ch}`
  const alreadyReady = readyKeys.includes(readyKey)

  if (!alreadyReady) {
    const peek = await peekMembership(client, ch)
    if (peek.status === 'need_join' && joinDelaySec > 0) {
      await appendLog('info', `Задержка перед вступлением ${joinDelaySec}с`, accountName)
      const { sleep } = await import('../lib/protection.js')
      await sleep(joinDelaySec * 1000)
    }
  }

  const membership = await joinTargetOrSkip(
    client,
    ch,
    appendLog,
    accountName,
    { quietIfMember: alreadyReady },
  )
  if (!membership?.peer) return null

  await joinChannelDiscussion(
    client,
    ch,
    appendLog,
    accountName,
    membership.peer,
    { quietIfMember: alreadyReady },
  )

  if (!alreadyReady) readyKeys.push(readyKey)
  return membership
}

export { mapTelegramError }
