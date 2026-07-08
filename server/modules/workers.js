import { generateComment, resolveSystemPrompt } from '../neuroCommenting/commentGenerator.js'
import {
  fetchPosts,
  sendChannelComment,
  sendReaction,
  searchPublic,
  fetchParticipants,
  fetchDialogs,
  markStoriesRead,
  mapTelegramError,
} from '../lib/gramHelpers.js'
import { joinTargetOrSkip, joinChannelDiscussion, prepareTarget } from '../lib/joinTarget.js'
import {
  connectAccount,
  disconnectAccount,
  handleFlood,
  perAccountLimitReached,
  totalLimitReached,
} from '../lib/accountRunner.js'
import {
  delayMultiplier,
  pickDelay,
  effectiveProbability,
  isAccountRunnable,
  postMeetsMinWords,
  postMatchesKeywords,
  sleep,
} from '../lib/protection.js'
import { getAccountMeta, setAccountMeta } from '../accountsMeta.js'
import { releaseTaskLocks } from '../lib/accountLocks.js'
import { loadSessionString, createClient } from '../tgAuth.js'
import { pickCommentCandidates, trackIdlePass } from '../lib/workerLoop.js'
import { parseTelegramPostLinks, resolvePostPeer } from '../lib/postLink.js'

/** @type {Map<string, Promise<void>>} */
const running = new Map()

/** @param {string} taskId @param {object} store @param {(task: object, store: object) => Promise<void>} runner */
export function startWorker(taskId, store, runner) {
  if (running.has(taskId)) return
  const job = (async () => {
    const task = await store.loadTask(taskId)
    if (!task) return
    await runner(task, store)
  })().finally(() => running.delete(taskId))
  running.set(taskId, job)
}

/** @param {string} taskId @param {object} store */
export async function stopWorker(taskId, store) {
  const task = await store.loadTask(taskId)
  if (!task) return null
  task.stopRequested = true
  await store.saveTask(task)
  return task
}

async function finalizeAccounts(accountIds, taskId) {
  if (taskId) releaseTaskLocks(taskId)
  for (const id of accountIds) {
    const meta = await getAccountMeta(id)
    if (meta.status === 'working') await setAccountMeta(id, { status: 'active' })
  }
}

function targets(settings) {
  return (settings.targets || settings.channels || []).map((t) => t.replace(/^@/, '').trim()).filter(Boolean)
}

function bumpProgress(task, store) {
  task.progress.actionsDone = (task.progress.actionsDone || 0) + 1
  task.progress.done = task.progress.actionsDone
  if (task.progress.commentsSent !== undefined) task.progress.commentsSent = task.progress.actionsDone
  return store.saveTask(task)
}

/** @param {object} task @param {object} store */
export async function runNeuroCommenting(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  task.readyTargets = task.readyTargets || []
  task.actionKeys = task.actionKeys || []
  await store.saveTask(task)
  await store.appendLog(task, 'info', 'Нейрокомментинг запущен')

  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const prob = effectiveProbability(s.probability ?? 30, !!s.aiProtection, s.protectionLevel ?? 1)
  const chs = targets(s)
  let idx = 0
  const accountIds = s.accountIds || []

  try {
    while (!task.stopRequested && !totalLimitReached(s, task)) {
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await getAccountMeta(accountId)
      if (!isAccountRunnable(meta.status || 'active')) {
        await store.appendLog(task, 'warning', `Пропуск: ${meta.status}`, meta.name)
        continue
      }
      if (perAccountLimitReached(s, accountId, task)) continue

      let client
      let progressed = false
      try {
        ;({ client } = await connectAccount(accountId, task.id))
        const ch = chs[Math.floor(Math.random() * chs.length)]
        const joinDelay = pickDelay(s.delays?.join?.[0] ?? 84, s.delays?.join?.[1] ?? 156, mul)
        const membership = await prepareTarget(
          client,
          ch,
          (level, message, acc) => store.appendLog(task, level, message, acc),
          meta.name,
          joinDelay,
          task.readyTargets,
          accountId,
        )
        if (!membership?.peer) {
          await disconnectAccount(client, accountId)
          if (trackIdlePass(task, false)) {
            await store.appendLog(task, 'error', 'Остановка: не удалось вступить в канал')
            break
          }
          await store.saveTask(task)
          continue
        }
        const channel = membership.peer

        const posts = await fetchPosts(client, channel, 20)
        if (!posts.length) {
          await store.appendLog(task, 'warning', 'В канале нет постов для комментирования', meta.name)
        } else {
          const candidates = pickCommentCandidates(posts, s)
          if (!candidates.length) {
            await store.appendLog(task, 'warning', 'Нет подходящих постов (фильтры или ключевые слова)', meta.name)
          }
          for (const post of candidates) {
            if (task.stopRequested || totalLimitReached(s, task)) break

            const key = `${accountId}:${ch}:${post.id}`
            if (task.actionKeys.includes(key)) continue

            if (Math.random() * 100 > prob) {
              await store.appendLog(task, 'info', `Пропуск по вероятности (${prob}%)`, meta.name)
              continue
            }

            await sleep(pickDelay(s.delays?.comment?.[0] ?? 30, s.delays?.comment?.[1] ?? 120, mul) * 1000)
            const postText = (post.message || '').trim() || (post.media ? '[медиа]' : '')
            const { text, mode } = await generateComment(postText, s.promptIndex ?? 0, resolveSystemPrompt(s))
            if (mode !== 'openai') {
              const hint = mode === 'template_no_key'
                ? 'Шаблон (нет OPENAI_API_KEY в .env)'
                : 'Шаблон (OpenAI недоступен)'
              await store.appendLog(task, 'warning', hint, meta.name)
            }
            try {
              await sendChannelComment(client, channel, post.id, text)
              task.actionKeys.push(key)
              task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
              task.accountStats[accountId].actions += 1
              await bumpProgress(task, store)
              await store.appendHistory(task, {
                id: `${task.id}_${Date.now()}`,
                ts: new Date().toISOString(),
                accountName: meta.name,
                channel: ch,
                comment: text,
                status: 'sent',
              }, 'commentHistory')
              await store.appendLog(task, 'success', `Коммент: ${text.slice(0, 50)}…`, meta.name)
              progressed = true
              break
            } catch (commentErr) {
              await store.appendLog(task, 'error', mapTelegramError(commentErr), meta.name)
            }
          }
        }
        await disconnectAccount(client, accountId)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'error', mapTelegramError(err), meta.name)
        }
      }

      if (trackIdlePass(task, progressed)) {
        await store.appendLog(task, 'error', 'Остановка: комментарий не отправлен после нескольких попыток')
        break
      }

      task = (await store.loadTask(task.id)) || task
      task.readyTargets = task.readyTargets || []
      task.actionKeys = task.actionKeys || []
      await store.saveTask(task)
      await sleep(pickDelay(5, 15, mul) * 1000)
    }
    task.status = task.stopRequested ? 'stopped' : 'done'
    await store.appendLog(task, 'info', task.status === 'done' ? 'Завершено' : 'Остановлено')
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id)
}

/** @param {object} task @param {object} store */
export async function runNeuroChatting(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  task.readyTargets = task.readyTargets || []
  await store.saveTask(task)
  await store.appendLog(task, 'info', 'Нейрочаттинг запущен')
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const prob = effectiveProbability(s.probability ?? 30, !!s.aiProtection, s.protectionLevel ?? 1)
  const groups = targets(s)
  let idx = 0
  const accountIds = s.accountIds || []

  try {
    while (!task.stopRequested && !totalLimitReached(s, task)) {
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await getAccountMeta(accountId)
      if (!isAccountRunnable(meta.status || 'active') || perAccountLimitReached(s, accountId, task)) continue
      let client
      let progressed = false
      try {
        ;({ client } = await connectAccount(accountId, task.id))
        const g = groups[Math.floor(Math.random() * groups.length)]
        const joinDelay = pickDelay(s.delays?.join?.[0] ?? 50, s.delays?.join?.[1] ?? 120, mul)
        const membership = await prepareTarget(
          client,
          g,
          (level, message, acc) => store.appendLog(task, level, message, acc),
          meta.name,
          joinDelay,
          task.readyTargets,
          accountId,
        )
        if (!membership?.peer) {
          await disconnectAccount(client, accountId)
          if (trackIdlePass(task, false)) break
          continue
        }
        const peer = membership.peer
        const msgs = await fetchPosts(client, peer, 15)
        const msg = msgs[Math.floor(Math.random() * msgs.length)]
        if (!msg || Math.random() * 100 > prob) {
          await store.appendLog(task, 'info', msg ? `Пропуск по вероятности (${prob}%)` : 'Нет сообщений в чате', meta.name)
          await disconnectAccount(client, accountId)
          if (trackIdlePass(task, false)) break
          continue
        }
        await sleep(pickDelay(s.delays?.action?.[0] ?? 42, s.delays?.action?.[1] ?? 78, mul) * 1000)
        const { text: reply, mode } = await generateComment(msg.message || '', s.promptIndex ?? 0, resolveSystemPrompt(s))
        if (mode !== 'openai') {
          await store.appendLog(task, 'warning', mode === 'template_no_key' ? 'Шаблон (нет OPENAI_API_KEY)' : 'Шаблон (OpenAI недоступен)', meta.name)
        }
        await client.sendMessage(peer, { message: reply, replyTo: msg.id })
        task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
        task.accountStats[accountId].actions += 1
        await bumpProgress(task, store)
        await store.appendHistory(task, { id: `${task.id}_${Date.now()}`, ts: new Date().toISOString(), accountName: meta.name, target: g, text: reply, status: 'sent' })
        await store.appendLog(task, 'success', `Ответ в @${g}`, meta.name)
        progressed = true
        await disconnectAccount(client, accountId)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'error', mapTelegramError(err), meta.name)
        }
      }
      if (trackIdlePass(task, progressed)) {
        await store.appendLog(task, 'error', 'Остановка: нет прогресса после нескольких попыток')
        break
      }
      task = (await store.loadTask(task.id)) || task
      task.readyTargets = task.readyTargets || []
      await store.saveTask(task)
      await sleep(pickDelay(5, 15, mul) * 1000)
    }
    task.status = task.stopRequested ? 'stopped' : 'done'
    await store.appendLog(task, 'info', 'Завершено')
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id)
}

/** @param {object} task @param {object} store */
export async function runMassReact(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  await store.saveTask(task)
  const emojis = s.emojis?.length ? s.emojis : ['👍', '❤️', '🔥']
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const prob = effectiveProbability(s.probability ?? 50, !!s.aiProtection, s.protectionLevel ?? 1)
  const tgs = targets(s)
  const fixedPosts = parseTelegramPostLinks(s.postUrls)
  let idx = 0
  const accountIds = s.accountIds || []

  try {
    while (!task.stopRequested && !totalLimitReached(s, task)) {
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await getAccountMeta(accountId)
      if (!isAccountRunnable(meta.status || 'active') || perAccountLimitReached(s, accountId, task)) continue
      let client
      try {
        ;({ client } = await connectAccount(accountId, task.id))
        await sleep(pickDelay(s.delays?.action?.[0] ?? 30, s.delays?.action?.[1] ?? 120, mul) * 1000)

        let peer
        let postId
        let targetLabel

        if (fixedPosts.length) {
          const pt = fixedPosts[Math.floor(Math.random() * fixedPosts.length)]
          targetLabel = pt.username ? `@${pt.username}` : pt.label
          peer = await resolvePostPeer(client, pt)
          postId = pt.msgId
        } else {
          if (!tgs.length) {
            await store.appendLog(task, 'error', 'Укажите группу/канал или ссылку на пост', meta.name)
            await disconnectAccount(client, accountId)
            continue
          }
          const t = tgs[Math.floor(Math.random() * tgs.length)]
          targetLabel = `@${t}`
          const membership = await joinTargetOrSkip(
            client, t,
            (level, message, acc) => store.appendLog(task, level, message, acc),
            meta.name,
          )
          if (!membership?.peer) {
            await disconnectAccount(client, accountId)
            continue
          }
          peer = membership.peer
          const posts = await fetchPosts(client, peer, 10)
          const post = posts[0]
          if (!post || Math.random() * 100 > prob) {
            await disconnectAccount(client, accountId)
            continue
          }
          postId = post.id
        }

        if (Math.random() * 100 > prob) {
          await disconnectAccount(client, accountId)
          continue
        }

        const emoji = emojis[Math.floor(Math.random() * emojis.length)]
        await sendReaction(client, peer, postId, emoji)
        task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
        task.accountStats[accountId].actions += 1
        await bumpProgress(task, store)
        await store.appendHistory(task, { id: `${task.id}_${Date.now()}`, ts: new Date().toISOString(), accountName: meta.name, target: targetLabel, emoji, postId, status: 'sent' })
        await store.appendLog(task, 'success', `Реакция ${emoji} ${targetLabel} · пост #${postId}`, meta.name)
        await disconnectAccount(client, accountId)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'error', mapTelegramError(err), meta.name)
        }
      }
      task = (await store.loadTask(task.id)) || task
      await sleep(pickDelay(5, 15, mul) * 1000)
    }
    task.status = task.stopRequested ? 'stopped' : 'done'
    await store.appendLog(task, 'info', 'Завершено')
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id)
}

/** @param {object} task @param {object} store */
export async function runMassLooking(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  await store.saveTask(task)
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const tgs = targets(s)
  let idx = 0
  const accountIds = s.accountIds || []

  try {
    while (!task.stopRequested && !totalLimitReached(s, task)) {
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await getAccountMeta(accountId)
      if (!isAccountRunnable(meta.status || 'active') || perAccountLimitReached(s, accountId, task)) continue
      let client
      try {
        ;({ client } = await connectAccount(accountId, task.id))
        const t = tgs[Math.floor(Math.random() * tgs.length)]
        await sleep(pickDelay(s.delays?.action?.[0] ?? 20, s.delays?.action?.[1] ?? 60, mul) * 1000)
        const membership = await joinTargetOrSkip(
          client, t,
          (level, message, acc) => store.appendLog(task, level, message, acc),
          meta.name,
        )
        if (!membership?.peer) {
          await disconnectAccount(client, accountId)
          continue
        }
        const viewed = await markStoriesRead(client, membership.peer)
        task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
        task.accountStats[accountId].actions += 1
        await bumpProgress(task, store)
        await store.appendLog(task, 'success', `Просмотр @${t} (${viewed})`, meta.name)
        await disconnectAccount(client, accountId)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'error', mapTelegramError(err), meta.name)
        }
      }
      task = (await store.loadTask(task.id)) || task
      await sleep(pickDelay(10, 30, mul) * 1000)
    }
    task.status = task.stopRequested ? 'stopped' : 'done'
    await store.appendLog(task, 'info', 'Завершено')
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id)
}

/** @param {object} task @param {object} store */
export async function runWarming(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  await store.saveTask(task)
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const accountIds = s.accountIds || []
  let idx = 0

  try {
    while (!task.stopRequested && !totalLimitReached(s, task)) {
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await getAccountMeta(accountId)
      if (!isAccountRunnable(meta.status || 'active')) continue
      let client
      try {
        ;({ client } = await connectAccount(accountId, task.id))
        const action = ['dialogs', 'search', 'read'][Math.floor(Math.random() * 3)]
        if (action === 'dialogs') {
          const ds = await fetchDialogs(client, 10)
          await store.appendLog(task, 'info', `Прогрев: ${ds.length} диалогов`, meta.name)
        } else if (action === 'search') {
          const chats = await searchPublic(client, 'news', 5)
          await store.appendLog(task, 'info', `Прогрев: поиск (${chats.length})`, meta.name)
        } else {
          await client.getMe()
          await store.appendLog(task, 'info', 'Прогрев: ping аккаунта', meta.name)
        }
        task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
        task.accountStats[accountId].actions += 1
        await bumpProgress(task, store)
        await disconnectAccount(client, accountId)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'warning', mapTelegramError(err), meta.name)
        }
      }
      task = (await store.loadTask(task.id)) || task
      await sleep(pickDelay(30, 90, mul) * 1000)
    }
    task.status = task.stopRequested ? 'stopped' : 'done'
    await store.appendLog(task, 'info', 'Прогрев завершён')
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id)
}

/** @param {object} task @param {object} store */
export async function runNeuroDialogs(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  await store.saveTask(task)
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const accountIds = s.accountIds || []
  let idx = 0

  try {
    while (!task.stopRequested && !totalLimitReached(s, task)) {
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await getAccountMeta(accountId)
      if (!isAccountRunnable(meta.status || 'active')) continue
      let client
      try {
        ;({ client } = await connectAccount(accountId, task.id))
        const dialogs = await fetchDialogs(client, 20)
        const unread = dialogs.filter((d) => d.unread > 0)
        if (!unread.length) {
          await store.appendLog(task, 'info', 'Нет непрочитанных ЛС', meta.name)
          await disconnectAccount(client, accountId)
          await sleep(5000)
          continue
        }
        const d = unread[0]
        const msgs = await client.getMessages(d.entity, { limit: 3 })
        const last = msgs[0]
        const { text: reply, mode } = await generateComment(last?.message || 'Привет', s.promptIndex ?? 0, resolveSystemPrompt(s))
        if (mode !== 'openai') {
          await store.appendLog(task, 'warning', mode === 'template_no_key' ? 'Шаблон (нет OPENAI_API_KEY)' : 'Шаблон (OpenAI недоступен)', meta.name)
        }
        await sleep(pickDelay(s.delays?.action?.[0] ?? 5, s.delays?.action?.[1] ?? 30, mul) * 1000)
        await client.sendMessage(d.entity, { message: reply })
        task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
        task.accountStats[accountId].actions += 1
        await bumpProgress(task, store)
        await store.appendLog(task, 'success', `Ответ в «${d.name}»`, meta.name)
        await disconnectAccount(client, accountId)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'error', mapTelegramError(err), meta.name)
        }
      }
      task = (await store.loadTask(task.id)) || task
      await sleep(pickDelay(10, 25, mul) * 1000)
    }
    task.status = task.stopRequested ? 'stopped' : 'done'
    await store.appendLog(task, 'info', 'Завершено')
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id)
}

/** @param {object} task @param {object} store */
export async function runGgr(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  await store.saveTask(task)
  const accountIds = s.accountIds?.length ? s.accountIds : []
  const allIds = accountIds.length ? accountIds : []

  if (!allIds.length) {
    const { loadAllMeta } = await import('../accountsMeta.js')
    const meta = await loadAllMeta()
    allIds.push(...Object.keys(meta).filter((id) => !meta[id].inTrash))
  }

  try {
    for (const accountId of allIds) {
      if (task.stopRequested) break
      const meta = await getAccountMeta(accountId)
      let score = 0
      let status = 'invalid'
      let client
      try {
        const sessionStr = await loadSessionString(accountId)
        if (!sessionStr) throw new Error('no session')
        client = await createClient(sessionStr, meta.proxy)
        const me = await client.getMe()
        score = 50
        if (me.username) score += 15
        if (me.phone) score += 10
        status = 'valid'
        await client.disconnect()
        await setAccountMeta(accountId, { status: 'active', ggrScore: score })
        task.results.push({ accountId, name: meta.name, score, status: 'valid' })
        await store.appendLog(task, 'success', `GGR ${score}/100 — ${meta.name}`, meta.name)
      } catch {
        if (client) try { await client.disconnect() } catch { /* */ }
        task.results.push({ accountId, name: meta.name, score: 0, status: 'invalid' })
        await setAccountMeta(accountId, { status: 'reauth', ggrScore: 0 })
        await store.appendLog(task, 'error', `Невалидная сессия — ${meta.name}`, meta.name)
      }
      task.progress.actionsDone = (task.progress.actionsDone || 0) + 1
      task.progress.done = task.progress.actionsDone
      await store.saveTask(task)
    }
    task.status = 'done'
    await store.appendLog(task, 'info', `Проверено ${task.results.length} аккаунтов`)
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
}

/** @param {object} task @param {object} store @param {string} kind */
export async function runParsing(task, store, kind) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  await store.saveTask(task)
  const accountIds = s.accountIds || []
  const accountId = accountIds[0]
  if (!accountId) {
    task.status = 'error'
    await store.appendLog(task, 'error', 'Нужен хотя бы один аккаунт')
    await store.saveTask(task)
    return
  }

  let client
  try {
    ;({ client } = await connectAccount(accountId, task.id))
    const meta = await getAccountMeta(accountId)

    if (kind === 'parsing-users' || kind === 'parsing-comments' || kind === 'parsing-messages') {
      const src = targets(s)[0]
      if (!src) throw new Error('Укажите группу/канал')
      const membership = await joinTargetOrSkip(
        client, src,
        (level, message, acc) => store.appendLog(task, level, message, acc),
        meta.name,
      )
      if (!membership?.peer) throw new Error('NOT_A_MEMBER')
      const users = await fetchParticipants(client, membership.peer, s.limit || 100)
      task.results = users.filter((u) => !u.bot).map((u) => ({ ...u, kind: 'user' }))
      await store.appendLog(task, 'success', `Найдено ${task.results.length} пользователей`, meta.name)
    } else {
      const kw = (s.keywords || ['crypto'])[0]
      const chats = await searchPublic(client, kw, s.limit || 20)
      task.results = chats.map((c) => ({
        id: c.id?.toString?.() ?? '',
        title: c.title || c.username || '—',
        username: c.username || '',
        members: c.participantsCount || 0,
        kind: kind === 'parsing-groups' ? 'group' : 'channel',
      }))
      await store.appendLog(task, 'success', `Найдено ${task.results.length} ${kind === 'parsing-groups' ? 'групп' : 'каналов'}`, meta.name)
    }
    task.progress.actionsDone = task.results.length
    task.progress.done = task.results.length
    task.progress.total = task.results.length
    task.status = 'done'
    await disconnectAccount(client, accountId)
  } catch (err) {
    if (client) await disconnectAccount(client, accountId)
    task.status = 'error'
    await store.appendLog(task, 'error', mapTelegramError(err))
  }
  await store.saveTask(task)
}

export const WORKERS = {
  'neuro-commenting': runNeuroCommenting,
  'neuro-chatting': runNeuroChatting,
  'mass-react': runMassReact,
  'mass-looking': runMassLooking,
  warming: runWarming,
  'neuro-dialogs': runNeuroDialogs,
  ggr: runGgr,
  parsing: (t, s) => runParsing(t, s, 'parsing'),
  'parsing-groups': (t, s) => runParsing(t, s, 'parsing-groups'),
  'parsing-users': (t, s) => runParsing(t, s, 'parsing-users'),
  'parsing-messages': (t, s) => runParsing(t, s, 'parsing-messages'),
  'parsing-comments': (t, s) => runParsing(t, s, 'parsing-comments'),
}
