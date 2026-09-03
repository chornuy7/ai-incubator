import {
  ensureJoined,
  joinDiscussionGroupIfNeeded,
  membershipLogMessage,
  peekMembership,
  mapTelegramError,
} from '../lib/gramHelpers.js'
import { resolveGroupCaptcha } from '../lib/captchaRunner.js'

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

  // §8.6: только что вступили → проверить капчу бота-антиспама и пройти/флагнуть/выйти.
  if (membership.status === 'joined') {
    try {
      await resolveGroupCaptcha(client, membership.peer, { appendLog, accountName })
    } catch { /* капча-хук не должен ломать вступление */ }
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
export async function prepareTarget(client, raw, appendLog, accountName, joinDelaySec, readyKeys, accountId, shouldStop) {
  const ch = raw.replace(/^@/, '').trim()
  const readyKey = `${accountId}:${ch}`
  const alreadyReady = readyKeys.includes(readyKey)

  if (!alreadyReady) {
    const peek = await peekMembership(client, ch)
    if (peek.status === 'need_join' && joinDelaySec > 0) {
      await appendLog('info', `Задержка перед вступлением ${joinDelaySec}с`, accountName)
      const { interruptibleSleep } = await import('../lib/protection.js')
      if (await interruptibleSleep(joinDelaySec * 1000, shouldStop)) return null // #6: прервано «Стоп»
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

/**
 * Вступление с человеческой паузой — для модулей, которым не нужна группа обсуждения.
 *
 * Просьба владельца 26.08: «почему у массовых реакций, масслукинга, прогрева нет задержки
 * перед вступлением — это же всё учитывать нужно полностью». Действительно: вступление
 * Telegram считает жёстче остальных действий, и мгновенный заход сразу после подключения
 * это ровно то, по чему находят ферму. У нейрокомментинга и чаттинга пауза была
 * (`prepareTarget`), у остальных — нет, хотя вступают они точно так же.
 *
 * Пауза только когда реально ВСТУПАЕМ: если аккаунт уже участник, ждать нечего и незачем.
 *
 * @param {number} joinDelaySec @param {() => Promise<boolean>} [shouldStop]
 * @returns {Promise<{peer:any,status:string,label:string}|null>} null — прервано «Стоп»
 */
export async function joinWithDelay(client, raw, appendLog, accountName, joinDelaySec, shouldStop) {
  const ch = String(raw).replace(/^@/, '').trim()
  try {
    const peek = await peekMembership(client, ch)
    if (peek.status === 'need_join' && joinDelaySec > 0) {
      await appendLog('info', `Задержка перед вступлением ${joinDelaySec}с`, accountName)
      const { interruptibleSleep } = await import('./protection.js')
      if (await interruptibleSleep(joinDelaySec * 1000, shouldStop)) return null // прервано «Стоп»
    }
  } catch { /* не смогли заглянуть — идём вступать как раньше, без паузы */ }
  return joinTargetOrSkip(client, ch, appendLog, accountName)
}

export { mapTelegramError }
