import { loadSessionString, createClient } from '../tgAuth.js'
import { getAccountMeta, setAccountMeta } from '../accountsMeta.js'
import { generateComment, resolveSystemPrompt } from './commentGenerator.js'
import {
  fetchChannelPosts,
  sendChannelComment,
  mapTelegramError,
} from './gramHelpers.js'
import { prepareTarget } from '../lib/joinTarget.js'
import { pickCommentCandidates, trackIdlePass } from '../lib/workerLoop.js'
import {
  delayMultiplier,
  pickDelay,
  effectiveProbability,
  isAccountRunnable,
  accountLimitReached,
  sleep,
  extractFloodSeconds,
} from './protection.js'
import { appendLog, appendCommentHistory, saveTask } from './taskStore.js'
import { releaseTaskLocks, assertAccountAvailable } from '../lib/accountLocks.js'

/** @type {Map<string, Promise<void>>} */
const running = new Map()

/** @param {object} task */
export function startTaskWorker(task) {
  if (running.has(task.id)) return
  const job = runTask(task).finally(() => running.delete(task.id))
  running.set(task.id, job)
}

/** @param {string} taskId */
export async function stopTaskWorker(taskId) {
  const { loadTask } = await import('./taskStore.js')
  const task = await loadTask(taskId)
  if (!task) return null
  task.stopRequested = true
  await saveTask(task)
  return task
}

/** @param {object} task */
async function runTask(task) {
  task.status = 'running'
  await saveTask(task)
  await appendLog(task, 'info', 'Задача запущена', undefined)

  const s = task.settings
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const prob = effectiveProbability(s.probability ?? 30, !!s.aiProtection, s.protectionLevel ?? 1)
  const maxTotal = s.workMode === 1 ? Infinity : (s.maxComments || 100)
  const endAt = s.workMode === 1 && s.durationMinutes
    ? Date.now() + s.durationMinutes * 60_000
    : null

  const accountIds = s.accountIds || []
  if (!accountIds.length) {
    task.status = 'error'
    await appendLog(task, 'error', 'Не выбраны аккаунты')
    await saveTask(task)
    return
  }

  const channels = (s.channels || []).map((c) => c.replace(/^@/, '').trim()).filter(Boolean)
  if (!channels.length) {
    task.status = 'error'
    await appendLog(task, 'error', 'Не указаны каналы')
    await saveTask(task)
    return
  }

  task.readyTargets = task.readyTargets || []
  task.commentedKeys = task.commentedKeys || []

  let accountIdx = 0

  try {
    while (!task.stopRequested) {
      if (endAt && Date.now() >= endAt) break
      if ((task.progress.commentsSent || 0) >= maxTotal) break

      const accountId = accountIds[accountIdx % accountIds.length]
      accountIdx += 1

      const meta = await getAccountMeta(accountId)
      if (!isAccountRunnable(meta.status || 'active')) {
        await appendLog(task, 'warning', `Пропуск: статус «${meta.status}»`, meta.name || accountId)
        await sleep(800)
        continue
      }

      task.accountStats[accountId] = task.accountStats[accountId] || { comments: 0, floodWaits: 0 }
      if (accountLimitReached(s, task.accountStats[accountId].comments)) {
        await appendLog(task, 'info', 'Лимит комментариев на аккаунт достигнут', meta.name || accountId)
        if (accountIds.every((id) => accountLimitReached(s, task.accountStats[id]?.comments || 0))) break
        continue
      }

      const sessionStr = await loadSessionString(accountId)
      if (!sessionStr) {
        await appendLog(task, 'error', 'Нет сессии — нужна реавторизация', meta.name || accountId)
        await setAccountMeta(accountId, { status: 'reauth' })
        continue
      }

      let client
      let progressed = false
      try {
        assertAccountAvailable(accountId, task.id)
        await setAccountMeta(accountId, { status: 'working' })
        client = await createClient(sessionStr, meta.proxy)

        const channelRaw = channels[Math.floor(Math.random() * channels.length)]
        const joinDelay = pickDelay(s.delays?.join?.[0] ?? 84, s.delays?.join?.[1] ?? 156, mul)
        const logFn = (level, message, acc) => appendLog(task, level, message, acc)

        const membership = await prepareTarget(
          client,
          channelRaw,
          logFn,
          meta.name || accountId,
          joinDelay,
          task.readyTargets,
          accountId,
        )
        if (task.stopRequested) break

        if (!membership?.peer) {
          await client.disconnect()
          await setAccountMeta(accountId, { status: 'active' })
          if (trackIdlePass(task, false)) {
            await appendLog(task, 'error', 'Остановка: не удалось вступить в канал')
            break
          }
          await saveTask(task)
          continue
        }
        const channel = membership.peer

        const posts = await fetchChannelPosts(client, channel, 20)
        if (!posts.length) {
          await appendLog(task, 'warning', 'Нет постов для комментирования', meta.name || accountId)
          await client.disconnect()
          await setAccountMeta(accountId, { status: 'active' })
          continue
        }

        let candidates = pickCommentCandidates(posts, s)
        let commented = false
        for (const post of candidates) {
          if (task.stopRequested) break
          if ((task.progress.commentsSent || 0) >= maxTotal) break

          const key = `${accountId}:${channelRaw}:${post.id}`
          if (task.commentedKeys?.includes(key)) continue

          if (Math.random() * 100 > prob) {
            await appendLog(task, 'info', `Пропуск по вероятности (${prob}%)`, meta.name || accountId)
            continue
          }

          const commentDelay = pickDelay(s.delays?.comment?.[0] ?? 30, s.delays?.comment?.[1] ?? 120, mul)
          await appendLog(task, 'info', `Задержка перед комментарием ${commentDelay}с`, meta.name || accountId)
          await sleep(commentDelay * 1000)

          if (task.stopRequested) break

          const { text, mode } = await generateComment(
            (post.message || '').trim() || (post.media ? '[медиа]' : ''),
            s.promptIndex ?? 0,
            resolveSystemPrompt(s),
          )
          if (mode !== 'openai') {
            const hint = mode === 'template_no_key'
              ? 'Шаблон (нет OPENAI_API_KEY в .env)'
              : 'Шаблон (OpenAI недоступен)'
            await appendLog(task, 'warning', hint, meta.name || accountId)
          }
          try {
            await sendChannelComment(client, channel, post.id, text)
            task.commentedKeys = task.commentedKeys || []
            task.commentedKeys.push(key)
            task.accountStats[accountId].comments += 1
            task.progress.commentsSent = (task.progress.commentsSent || 0) + 1
            task.progress.done = task.progress.commentsSent
            commented = true
            progressed = true

            await appendCommentHistory(task, {
              id: `${task.id}_${Date.now()}`,
              ts: new Date().toISOString(),
              accountId,
              accountName: meta.name || accountId,
              channel: channelRaw,
              postId: post.id,
              comment: text,
              status: 'sent',
            })
            await appendLog(task, 'success', `Комментарий отправлен: «${text.slice(0, 60)}…»`, meta.name || accountId)
          } catch (err) {
            const floodSec = extractFloodSeconds(err)
            if (floodSec > 0) {
              task.accountStats[accountId].floodWaits += 1
              const fwDelay = floodSec + (s.delays?.floodWait ?? 120)
              await appendLog(task, 'warning', `FloodWait ${floodSec}с — пауза ${fwDelay}с`, meta.name || accountId)
              await sleep(fwDelay * 1000)
              const limit = s.delays?.floodQuarantine ?? 3
              if (task.accountStats[accountId].floodWaits >= limit) {
                await setAccountMeta(accountId, { status: 'quarantine' })
                await appendLog(task, 'error', `Карантин: ${limit} FloodWait подряд`, meta.name || accountId)
              }
            } else {
              await appendLog(task, 'error', mapTelegramError(err), meta.name || accountId)
            }
          }
          await saveTask(task)
          if (commented) break
        }

        if (!commented && !task.stopRequested) {
          await appendLog(task, 'info', 'Подходящих постов не найдено в этом проходе', meta.name || accountId)
        }

        await client.disconnect()
        const freshMeta = await getAccountMeta(accountId)
        if (freshMeta.status === 'working') await setAccountMeta(accountId, { status: 'active' })
      } catch (err) {
        if (client) {
          try {
            await client.disconnect()
          } catch {
            /* ignore */
          }
        }
        const floodSec = extractFloodSeconds(err)
        if (floodSec > 0) {
          task.accountStats[accountId] = task.accountStats[accountId] || { comments: 0, floodWaits: 0 }
          task.accountStats[accountId].floodWaits += 1
          await appendLog(task, 'warning', `FloodWait ${floodSec}с`, meta.name || accountId)
          await sleep((floodSec + 30) * 1000)
        } else {
          await appendLog(task, 'error', mapTelegramError(err), meta.name || accountId)
        }
        await setAccountMeta(accountId, { status: 'active' })
        await saveTask(task)
      }

      if (task.stopRequested) break

      if (trackIdlePass(task, progressed)) {
        await appendLog(task, 'error', 'Остановка: комментарий не отправлен после нескольких попыток')
        break
      }

      await sleep(pickDelay(5, 15, mul) * 1000)
      const reloaded = await (await import('./taskStore.js')).loadTask(task.id)
      if (!reloaded) break
      task = reloaded
      task.readyTargets = task.readyTargets || []
      task.commentedKeys = task.commentedKeys || []
    }

    task.status = task.stopRequested ? 'stopped' : 'done'
    await appendLog(task, 'info', task.status === 'done' ? 'Задача завершена' : 'Задача остановлена')
  } catch (err) {
    task.status = 'error'
    await appendLog(task, 'error', err instanceof Error ? err.message : 'Критическая ошибка')
  }

  await saveTask(task)

  releaseTaskLocks(task.id)
  for (const accountId of accountIds) {
    const meta = await getAccountMeta(accountId)
    if (meta.status === 'working') await setAccountMeta(accountId, { status: 'active' })
  }
}
