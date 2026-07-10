import { generateComment, isAiGenerationEnabled, resolveSystemPrompt } from '../neuroCommenting/commentGenerator.js'
import {
  fetchPosts,
  sendChannelComment,
  sendReaction,
  searchPublic,
  searchPublicDetailed,
  getChannelMembersCount,
  fetchParticipants,
  fetchDialogs,
  readUserHistory,
  markStoriesRead,
  viewRecentPosts,
  joinDiscussionGroupIfNeeded,
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
import { releaseTaskLocks, markTaskLive, markTaskDone, assertAccountAvailable } from '../lib/accountLocks.js'
import { loadSessionString, createClient } from '../tgAuth.js'
import { pickCommentCandidates, trackIdlePass } from '../lib/workerLoop.js'
import { parseTelegramPostLinks, resolvePostPeer } from '../lib/postLink.js'
import { filterBlacklisted, isBlacklistedSync } from '../targetBlacklist.js'

/** @type {Map<string, Promise<void>>} */
const running = new Map()

/** @param {string} taskId @param {object} store @param {(task: object, store: object) => Promise<void>} runner */
export function startWorker(taskId, store, runner) {
  if (running.has(taskId)) return
  markTaskLive(taskId)
  const job = (async () => {
    const task = await store.loadTask(taskId)
    if (!task) return
    try {
      await runner(task, store)
    } finally {
      // Страховка: любой терминальный путь воркера (в т.ч. ранний return,
      // исключение до finalizeAccounts) обязан снять блокировки и сбросить статусы.
      await finalizeAccounts(task.settings?.accountIds || [], taskId)
    }
  })().finally(() => {
    running.delete(taskId)
    markTaskDone(taskId)
  })
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
  const list = (settings.targets || settings.channels || []).map((t) => t.replace(/^@/, '').trim()).filter(Boolean)
  // feature 10: исключаем цели из чёрного списка перед любыми действиями
  return filterBlacklisted(list)
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
  // idleLap считает подряд пропущенные аккаунты. Полный круг пропусков = никто не может работать
  // (все выбрали лимит на аккаунт или недоступны), а общий лимit при малом числе аккаунтов может быть
  // недостижим — без этого while крутился бы вхолостую на 100% CPU. Тогда завершаем задачу.
  let idleLap = 0
  const accountIds = s.accountIds || []

  try {
    while (!task.stopRequested && !totalLimitReached(s, task)) {
      if (idleLap >= accountIds.length) {
        await store.appendLog(task, 'info', 'Все аккаунты исчерпали лимиты на эту задачу — завершаем')
        break
      }
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await getAccountMeta(accountId)
      if (!isAccountRunnable(meta.status || 'active')) {
        idleLap += 1
        await store.appendLog(task, 'warning', `Пропуск: ${meta.status}`, meta.name)
        continue
      }
      if (perAccountLimitReached(s, accountId, task)) { idleLap += 1; continue }
      idleLap = 0

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
  let idleLap = 0
  const accountIds = s.accountIds || []

  try {
    while (!task.stopRequested && !totalLimitReached(s, task)) {
      if (idleLap >= accountIds.length) {
        await store.appendLog(task, 'info', 'Все аккаунты исчерпали лимиты на эту задачу — завершаем')
        break
      }
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await getAccountMeta(accountId)
      if (!isAccountRunnable(meta.status || 'active') || perAccountLimitReached(s, accountId, task)) { idleLap += 1; continue }
      idleLap = 0
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
  // feature 10: исключаем посты из ЧС по username канала
  const fixedPosts = parseTelegramPostLinks(s.postUrls).filter((p) => !p.username || !isBlacklistedSync(p.username))
  let idx = 0
  let idleLap = 0
  const accountIds = s.accountIds || []

  try {
    while (!task.stopRequested && !totalLimitReached(s, task)) {
      if (idleLap >= accountIds.length) {
        await store.appendLog(task, 'info', 'Все аккаунты исчерпали лимиты на эту задачу — завершаем')
        break
      }
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await getAccountMeta(accountId)
      if (!isAccountRunnable(meta.status || 'active') || perAccountLimitReached(s, accountId, task)) { idleLap += 1; continue }
      idleLap = 0
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
  let idleLap = 0
  const accountIds = s.accountIds || []
  const lookMode = ['stories', 'posts', 'both'].includes(s.lookMode) ? s.lookMode : 'stories'
  const postsCount = Math.min(Math.max(Math.trunc(Number(s.lookPostsCount) || 0) || 3, 1), 50)

  try {
    while (!task.stopRequested && !totalLimitReached(s, task)) {
      if (idleLap >= accountIds.length) {
        await store.appendLog(task, 'info', 'Все аккаунты исчерпали лимиты на эту задачу — завершаем')
        break
      }
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await getAccountMeta(accountId)
      if (!isAccountRunnable(meta.status || 'active') || perAccountLimitReached(s, accountId, task)) { idleLap += 1; continue }
      idleLap = 0
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
        task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
        if (lookMode === 'stories' || lookMode === 'both') {
          const viewed = await markStoriesRead(client, membership.peer)
          await store.appendLog(task, 'success', `Просмотр @${t} (${viewed})`, meta.name)
        }
        if (lookMode === 'posts' || lookMode === 'both') {
          const res = await viewRecentPosts(client, membership.peer, postsCount)
          if (!res.isChannel) {
            await store.appendLog(task, 'warning', `Просмотр постов @${t}: цель не broadcast-канал — счётчик просмотров не применим`, meta.name)
          } else if (res.viewed === 0) {
            const why = res.reason === 'no_posts' ? 'посты не найдены' : 'просмотр не засчитан'
            await store.appendLog(task, 'warning', `Просмотр постов @${t}: ${why}`, meta.name)
          } else {
            const delta = res.viewsBefore != null
              ? ` (просмотры поста: было ${res.viewsBefore}${res.viewsAfter != null ? `, стало ${res.viewsAfter}` : ''})`
              : ''
            await store.appendLog(task, 'success', `Просмотр постов @${t}: ${res.viewed}${delta}`, meta.name)
          }
        }
        task.accountStats[accountId].actions += 1
        await bumpProgress(task, store)
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
  let idleLap = 0

  try {
    while (!task.stopRequested && !totalLimitReached(s, task)) {
      if (idleLap >= accountIds.length) {
        await store.appendLog(task, 'info', 'Нет доступных аккаунтов для прогрева — завершаем')
        break
      }
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await getAccountMeta(accountId)
      if (!isAccountRunnable(meta.status || 'active')) { idleLap += 1; continue }
      idleLap = 0
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

/**
 * Системный промпт для ЛС: промпт карточки + пользовательская инструкция и цель диалога.
 * @param {object} settings @param {string} goal
 */
function dialogSystemPrompt(settings, goal) {
  const base = resolveSystemPrompt(settings)
  const rules = 'Ты ведёшь личную переписку в Telegram от лица владельца аккаунта. Отвечай на языке собеседника, коротко (1–3 предложения), живо и по-человечески. Никогда не сообщай, что ты ИИ или бот.'
  return goal ? `${base}\n\n${rules}\n\nИнструкция и цель диалога:\n${goal}` : `${base}\n\n${rules}`
}

/**
 * Стенограмма последних сообщений (от старых к новым) как контекст для модели.
 * @param {Array<{out?: boolean, message?: string}>} msgs сообщения от новых к старым
 */
function buildDialogPrompt(msgs) {
  const lines = []
  let budget = 380 // generateComment обрезает промпт до 500 символов — держим самые свежие реплики
  for (const m of msgs) {
    const text = (m?.message || '').trim()
    if (!text) continue
    const line = `${m.out ? 'Я' : 'Собеседник'}: ${text.slice(0, 200)}`
    if (line.length > budget) break
    budget -= line.length + 1
    lines.unshift(line)
  }
  if (!lines.length) return 'Собеседник: Привет'
  return `Переписка:\n${lines.join('\n')}\n\nНапиши следующий ответ от лица «Я».`
}

/** @param {object} task @param {object} store */
export async function runNeuroDialogs(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  await store.saveTask(task)
  const replyAll = s.replyScope === 'all'
  await store.appendLog(
    task,
    'info',
    replyAll
      ? 'НейроДиалоги запущены · авто-ответы всем, кто писал (включая уже прочитанные ЛС), сам первым не пишет'
      : 'НейроДиалоги запущены · авто-ответы только на непрочитанные входящие ЛС (сам первым не пишет)',
  )
  const goal = (s.dialogGoal || '').trim()
  if (goal) await store.appendLog(task, 'info', `Цель диалога: ${goal.slice(0, 120)}`)
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const accountIds = s.accountIds || []
  // Сколько ЛС один аккаунт отвечает за один заход, прежде чем уступить очередь следующему.
  // Пачка ответов подряд с одного номера — самый быстрый путь к PEER_FLOOD и репортам.
  const perPassCap = [2, 4, 6][s.protectionLevel ?? 1] ?? 4
  let idx = 0
  let skips = 0
  // Последнее входящее сообщение, на которое уже ответили: не отвечаем дважды на одно и то же,
  // но отвечаем снова, когда собеседник напишет новое.
  const answeredUpTo = new Map()

  try {
    while (!task.stopRequested && !totalLimitReached(s, task)) {
      // Полный круг из пропусков (лимиты выбраны, аккаунты в карантине) — не крутим цикл вхолостую.
      if (skips >= accountIds.length) {
        skips = 0
        await sleep(5000)
        continue
      }
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await getAccountMeta(accountId)
      if (!isAccountRunnable(meta.status || 'active')) {
        skips += 1
        await store.appendLog(task, 'warning', `Пропуск аккаунта: ${meta.status}`, meta.name)
        continue
      }
      if (perAccountLimitReached(s, accountId, task)) {
        skips += 1
        continue
      }
      skips = 0
      let client
      try {
        ;({ client } = await connectAccount(accountId, task.id))
        const dialogs = await fetchDialogs(client, 20)
        // Авто-режим отвечает только на личные диалоги (ЛС) с людьми — каналы, группы и боты пропускаются.
        const personal = dialogs.filter((d) => d.entity?.className === 'User' && !d.entity?.bot)
        // «Только новые» — непрочитанные. «Всем, кто писал» — любой диалог, где последнее слово за собеседником.
        const waiting = personal.filter((d) => {
          if (!replyAll) return d.unread > 0
          if (d.lastOut || !d.lastMessageId) return false
          return (answeredUpTo.get(`${accountId}:${d.id}`) ?? 0) < d.lastMessageId
        })
        const pending = waiting.slice(0, perPassCap)
        await store.appendLog(
          task,
          'info',
          `Диалогов просмотрено: ${dialogs.length} · личных: ${personal.length} · ${replyAll ? 'ждут ответа' : 'непрочитанных ЛС'}: ${waiting.length}`
            + (waiting.length > pending.length ? ` · отвечаем ${pending.length}, остальные — на следующем круге` : ''),
          meta.name,
        )
        if (!pending.length) {
          await disconnectAccount(client, accountId)
          await sleep(5000)
          continue
        }
        for (const d of pending) {
          if (task.stopRequested || totalLimitReached(s, task) || perAccountLimitReached(s, accountId, task)) break
          const msgs = await client.getMessages(d.entity, { limit: 6 })
          const last = msgs[0]
          const incoming = (last?.message || '').trim()
          // Без OpenAI сработает шаблонный ответ — ему нужна реплика собеседника, а не стенограмма.
          const prompt = isAiGenerationEnabled() ? buildDialogPrompt(msgs) : incoming || 'Привет'
          const { text: reply, mode } = await generateComment(prompt, s.promptIndex ?? 0, dialogSystemPrompt(s, goal))
          if (mode !== 'openai') {
            await store.appendLog(task, 'warning', mode === 'template_no_key' ? 'Шаблонный ответ (нет OPENAI_API_KEY в .env)' : 'Шаблонный ответ (OpenAI недоступен)', meta.name)
          }
          await sleep(pickDelay(s.delays?.action?.[0] ?? 5, s.delays?.action?.[1] ?? 30, mul) * 1000)
          await client.sendMessage(d.entity, { message: reply })
          // Помечаем прочитанным, чтобы не отвечать повторно одному и тому же собеседнику.
          await readUserHistory(client, d.entity)
          answeredUpTo.set(`${accountId}:${d.id}`, Math.max(last?.id ?? 0, d.lastMessageId ?? 0))
          task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
          task.accountStats[accountId].actions += 1
          await bumpProgress(task, store)
          await store.appendHistory(task, { id: `${task.id}_${Date.now()}`, ts: new Date().toISOString(), accountName: meta.name, target: d.name, text: reply, status: 'sent' })
          const inPreview = incoming ? incoming.slice(0, 60) : '[без текста]'
          await store.appendLog(task, 'success', `Ответ в ЛС «${d.name}» → «${reply.slice(0, 60)}» (на: «${inPreview}»)`, meta.name)
        }
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
    await store.appendLog(task, 'info', task.status === 'stopped' ? 'Остановлено' : 'Завершено')
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id)
}

/** Статусы, которые GGR не имеет права перезатирать успешной проверкой сессии. */
const GGR_PROTECTED_STATUSES = new Set(['quarantine', 'spamblock', 'banned'])

/** Ошибка означает, что сессия действительно мертва (а не сеть/прокси моргнули). */
function isDeadSessionError(err) {
  const msg = `${err?.errorMessage || err?.message || ''}`
  return /NO_SESSION|AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|UNAUTHORIZED/i.test(msg)
}

/** @param {object} task @param {object} store */
export async function runGgr(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  const allIds = [...(s.accountIds || [])]

  if (!allIds.length) {
    const { loadAllMeta } = await import('../accountsMeta.js')
    const meta = await loadAllMeta()
    allIds.push(...Object.keys(meta).filter((id) => !meta[id].inTrash))
  }
  task.progress.total = allIds.length
  await store.saveTask(task)
  await store.appendLog(task, 'info', `GGR-проверка: ${allIds.length} аккаунтов`)

  try {
    for (const accountId of allIds) {
      if (task.stopRequested) break
      const meta = await getAccountMeta(accountId)

      // Аккаунт, занятый другой задачей, не трогаем: параллельный коннект той же сессией
      // роняет обе задачи и может выглядеть для Telegram как угон сессии.
      try {
        assertAccountAvailable(accountId, task.id)
      } catch {
        await store.appendLog(task, 'warning', 'Аккаунт занят другим модулем — пропущен', meta.name)
        continue
      }

      let client
      try {
        const sessionStr = await loadSessionString(accountId)
        if (!sessionStr) throw new Error('NO_SESSION')
        client = await createClient(sessionStr, meta.proxy)
        const me = await client.getMe()
        let score = 50
        if (me.username) score += 15
        if (me.phone) score += 10
        await client.disconnect()
        // Карантин/спамблок/бан — «сессия жива, но аккаунт наказан». Статус не понижаем и не поднимаем.
        const nextStatus = GGR_PROTECTED_STATUSES.has(meta.status) ? meta.status : 'active'
        await setAccountMeta(accountId, { status: nextStatus, ggrScore: score })
        task.results.push({ accountId, name: meta.name, score, status: 'valid' })
        await store.appendLog(task, 'success', `GGR ${score}/100 — ${meta.name}`, meta.name)
      } catch (err) {
        if (client) try { await client.disconnect() } catch { /* */ }
        if (isDeadSessionError(err)) {
          task.results.push({ accountId, name: meta.name, score: 0, status: 'invalid' })
          await setAccountMeta(accountId, { status: 'reauth', ggrScore: 0 })
          await store.appendLog(task, 'error', `Невалидная сессия — ${meta.name}`, meta.name)
        } else {
          // Сеть, прокси, таймаут, FloodWait — сессия не виновата, статус и балл не трогаем.
          task.results.push({ accountId, name: meta.name, score: meta.ggrScore ?? 0, status: 'error' })
          await store.appendLog(task, 'warning', `Проверка не удалась: ${mapTelegramError(err)}`, meta.name)
        }
      }
      task.progress.actionsDone = (task.progress.actionsDone || 0) + 1
      task.progress.done = task.progress.actionsDone
      await store.saveTask(task)
    }
    task.status = task.stopRequested ? 'stopped' : 'done'
    const valid = task.results.filter((r) => r.status === 'valid').length
    await store.appendLog(task, 'info', `Проверено ${task.results.length} аккаунтов · валидных ${valid}`)
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
}

/**
 * Богатый парсер каналов/групп (GRAMGPT-style): поиск по ключевым словам + окончаниям,
 * ротация аккаунтов, диапазон участников, фильтры активности/комментариев, дедуп, задержки.
 * @param {object} task @param {object} store @param {'parsing'|'parsing-groups'} kind
 */
export async function runChannelParser(task, store, kind) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  task.results = []
  await store.saveTask(task)

  const accountIds = s.accountIds || []
  if (!accountIds.length) {
    task.status = 'error'
    await store.appendLog(task, 'error', 'Нужен хотя бы один аккаунт')
    await store.saveTask(task)
    return
  }

  const wantGroups = kind === 'parsing-groups'
  const unitLabel = wantGroups ? 'групп' : 'каналов'
  const resultKind = wantGroups ? 'group' : 'channel'
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)

  const minMembers = Math.max(0, Number(s.minMembers ?? 0) || 0)
  const maxMembers = Math.max(0, Number(s.maxMembers ?? 0) || 0)
  const rawLimit = Number(s.resultLimit ?? s.limit ?? 0) || 0
  const limit = rawLimit > 0 ? rawLimit : Infinity
  const comments = Number(s.commentFilter ?? 0) || 0 // 0 любые / 1 открытые / 2 закрытые
  const reqFrom = s.delays?.request?.[0] ?? 2
  const reqTo = s.delays?.request?.[1] ?? reqFrom
  const chFrom = s.delays?.channel?.[0] ?? 1
  const chTo = s.delays?.channel?.[1] ?? chFrom

  // Собираем поисковые запросы: ключевые слова + комбинации с окончаниями
  const keywords = (s.keywords || []).map((k) => String(k).trim()).filter(Boolean)
  const endings = (s.endings || []).map((e) => String(e).trim()).filter(Boolean)
  const queries = []
  const seenQuery = new Set()
  const pushQuery = (q) => { const v = q.trim(); if (v && !seenQuery.has(v.toLowerCase())) { seenQuery.add(v.toLowerCase()); queries.push(v) } }
  for (const kw of keywords) {
    pushQuery(kw)
    for (const end of endings) pushQuery(`${kw} ${end}`)
  }
  if (!queries.length) {
    task.status = 'error'
    await store.appendLog(task, 'error', 'Укажите хотя бы одно ключевое слово')
    await store.saveTask(task)
    return
  }

  const seen = new Set() // дедуп по id/username
  const skipParsed = new Set((s.alreadyParsed || []).map((x) => String(x).toLowerCase()))
  let accIdx = 0

  async function nextAccountId() {
    for (let i = 0; i < accountIds.length; i++) {
      const id = accountIds[accIdx++ % accountIds.length]
      const meta = await getAccountMeta(id)
      if (isAccountRunnable(meta.status || 'active')) return id
    }
    return null
  }

  await store.appendLog(task, 'info', `Парсинг запущен · запросов: ${queries.length} · аккаунтов: ${accountIds.length}`)

  try {
    for (const q of queries) {
      if (task.stopRequested || task.results.length >= limit) break

      const accountId = await nextAccountId()
      if (!accountId) {
        await store.appendLog(task, 'warning', 'Нет доступных аккаунтов (все в карантине/невалидны)')
        break
      }
      const meta = await getAccountMeta(accountId)
      let client
      try {
        ;({ client } = await connectAccount(accountId, task.id))
        const found = await searchPublicDetailed(client, q, 50)
        let added = 0
        for (const c of found) {
          if (task.stopRequested || task.results.length >= limit) break

          // тип: канал vs группа
          if (wantGroups) { if (c.isBroadcast && !c.isMegagroup) continue }
          else if (!c.isBroadcast) continue

          const key = (c.username || c.id).toLowerCase()
          if (!key || seen.has(key)) continue
          if (skipParsed.has(key)) continue

          // фильтр комментариев: открытые = мегагруппа/есть обсуждение, закрытые = обычный канал
          if (comments === 1 && c.isBroadcast && !c.isMegagroup) continue
          if (comments === 2 && c.isMegagroup) continue

          // число участников (обогащаем через GetFullChannel если поиск не отдал)
          let members = c.members
          if (!members) {
            members = await getChannelMembersCount(client, c.entity)
            await sleep(pickDelay(chFrom, chTo, mul) * 1000)
          }
          if (minMembers && members < minMembers) continue
          if (maxMembers && members > maxMembers) continue

          seen.add(key)
          task.results.push({
            id: c.id,
            title: c.title,
            username: c.username,
            members,
            kind: resultKind,
            link: c.username ? `https://t.me/${c.username}` : '',
            hasComments: !!c.isMegagroup,
          })
          added += 1
          task.progress.actionsDone = task.results.length
          task.progress.done = task.results.length
          task.progress.total = Math.max(task.results.length, task.progress.total || 0)
          await store.saveTask(task)
        }
        await store.appendLog(task, added ? 'success' : 'info', `«${q}» → +${added} ${unitLabel} (всего ${task.results.length})`, meta.name)
        await disconnectAccount(client, accountId)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'error', `«${q}»: ${mapTelegramError(err)}`, meta.name)
        }
      }

      task = (await store.loadTask(task.id)) || task
      await sleep(pickDelay(reqFrom, reqTo, mul) * 1000)
    }

    task.progress.total = task.results.length
    task.status = task.stopRequested ? 'stopped' : 'done'
    await store.appendLog(task, 'info', `Готово · найдено ${task.results.length} ${unitLabel}`)
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id)
}

const mapUser = (u) => ({
  id: u?.id?.toString?.() ?? '',
  name: `${u?.firstName || ''} ${u?.lastName || ''}`.trim() || u?.username || (u?.id?.toString?.() ?? '—'),
  username: u?.username || '',
  bot: !!u?.bot,
  premium: !!u?.premium,
  hasPhoto: !!u?.photo,
  deleted: !!u?.deleted,
  scam: !!(u?.scam || u?.fake),
})

/**
 * Парсер участников: пользователи из групп / по сообщениям / из комментариев.
 * Мульти-цели, ротация аккаунтов, фильтры (боты/удалённые/scam/username/фото/premium/админы),
 * лимиты, ключевые слова, задержки, дедуп по id.
 * @param {object} task @param {object} store @param {'parsing-users'|'parsing-messages'|'parsing-comments'} kind
 */
export async function runParticipantsParser(task, store, kind) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  task.results = []
  await store.saveTask(task)

  const accountIds = s.accountIds || []
  if (!accountIds.length) {
    task.status = 'error'
    await store.appendLog(task, 'error', 'Нужен хотя бы один аккаунт')
    await store.saveTask(task)
    return
  }

  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const F = s.filters || {}
  const L = s.limits || {}
  const kw = (s.keywords || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean)
  const delayChatMs = Math.max(0, Number(s.delayChat ?? 5)) * 1000
  const delayItemMs = Math.max(0, Number(s.delayItem ?? 0.5)) * 1000
  const tgs = targets(s)
  if (!tgs.length) {
    task.status = 'error'
    await store.appendLog(task, 'error', 'Укажите хотя бы один источник (группу/канал/чат)')
    await store.saveTask(task)
    return
  }

  const passUser = (u) => {
    if (F.skipBots && u.bot) return false
    if (F.skipDeleted && u.deleted) return false
    if (F.skipScam && u.scam) return false
    if (F.onlyUsername && !u.username) return false
    if (F.onlyPhoto && !u.hasPhoto) return false
    if (F.onlyPremium && !u.premium) return false
    return true
  }
  const seen = new Set()
  // Пересечение аудиторий (только parsing-users): пользователь засчитывается, если встречается
  // минимум в intersectionMin группах (по умолчанию — во всех выбранных).
  const intersection = kind === 'parsing-users' && s.userSource !== 'writers' && !!s.intersectionMode && tgs.length > 1
  const intersectMin = intersection ? (Number(s.intersectionMin) > 0 ? Number(s.intersectionMin) : tgs.length) : 0
  const userHits = new Map() // id -> { user, hits }
  let accIdx = 0
  const nextAccountId = async () => {
    for (let i = 0; i < accountIds.length; i++) {
      const id = accountIds[accIdx++ % accountIds.length]
      const meta = await getAccountMeta(id)
      if (isAccountRunnable(meta.status || 'active')) return id
    }
    return null
  }

  let processed = 0
  task.progress.total = tgs.length
  task.progress.actionsDone = 0
  task.progress.done = 0
  await store.saveTask(task)
  await store.appendLog(task, 'info', `Парсинг участников: источников ${tgs.length}, аккаунтов ${accountIds.length}${intersection ? ` · режим пересечения (≥${intersectMin} групп)` : ''}`)

  try {
    for (const src of tgs) {
      if (task.stopRequested) break
      const accountId = await nextAccountId()
      if (!accountId) { await store.appendLog(task, 'warning', 'Нет доступных аккаунтов'); break }
      const meta = await getAccountMeta(accountId)
      let client
      try {
        ;({ client } = await connectAccount(accountId, task.id))
        const membership = await joinTargetOrSkip(client, src, (l, m, a) => store.appendLog(task, l, m, a), meta.name)
        if (!membership?.peer) { await disconnectAccount(client, accountId); continue }
        const peer = membership.peer
        let added = 0

        if (kind === 'parsing-users' && s.userSource === 'writers') {
          // Режим «Активные»: канал → находим чат обсуждения → парсим тех, кто писал,
          // разбивая на админ/премиум/обычный.
          let chatPeer = peer
          try { const disc = await joinDiscussionGroupIfNeeded(client, peer); if (disc?.peer) { chatPeer = disc.peer; await store.appendLog(task, 'info', `${src}: найден чат обсуждения`, meta.name) } } catch { /* нет обсуждения — читаем сам peer */ }
          // множество админов для категоризации
          let adminIds = new Set()
          try { const admins = await fetchParticipants(client, chatPeer, 200, { adminsOnly: true }); adminIds = new Set(admins.map((a) => a.id)) } catch { /* нет прав/список закрыт */ }
          const messages = await client.getMessages(chatPeer, { limit: L.messages || L.participants || 1000 })
          const bySender = new Map()
          for (const m of messages) {
            if (!m?.senderId) continue
            const sid = m.senderId.toString()
            const rec = bySender.get(sid) || { count: 0, sender: m.sender }
            rec.count++; if (!rec.sender && m.sender) rec.sender = m.sender
            bySender.set(sid, rec)
          }
          for (const [sid, rec] of bySender) {
            if (task.stopRequested || seen.has(sid)) continue
            const u = rec.sender ? mapUser(rec.sender) : { id: sid, name: sid, username: '', bot: false }
            if (!passUser(u)) continue
            const role = adminIds.has(sid) ? 'admin' : (u.premium ? 'premium' : 'user')
            if (F.onlyAdmins && role !== 'admin') continue
            seen.add(sid)
            task.results.push({ ...u, kind: 'user', messagesCount: rec.count, role })
            added++
          }
        } else if (kind === 'parsing-users') {
          let users = []
          try {
            users = await fetchParticipants(client, peer, L.participants || s.limit || 1000, { adminsOnly: !!F.onlyAdmins })
          } catch (e) {
            const msg = mapTelegramError(e)
            if (/ADMIN_REQUIRED|CHAT_ADMIN|CHANNEL_PRIVATE|not.*visible/i.test(msg)) {
              await store.appendLog(task, 'warning', `${src}: список участников закрыт — используйте режим «Активные (кто писал)»`, meta.name)
            } else { throw e }
          }
          const seenInThisTarget = new Set()
          for (const u of users) {
            if (task.stopRequested) break
            if (!u.id || !passUser(u)) continue
            if (intersection) {
              // считаем вхождение пользователя в каждую группу не более одного раза
              if (seenInThisTarget.has(u.id)) continue
              seenInThisTarget.add(u.id)
              const rec = userHits.get(u.id) || { user: u, hits: 0 }
              rec.hits++; rec.user = rec.user || u
              userHits.set(u.id, rec)
              added++
            } else {
              if (seen.has(u.id)) continue
              seen.add(u.id)
              task.results.push({ ...u, kind: 'user' })
              added++
            }
          }
        } else if (kind === 'parsing-messages') {
          const days = Number(L.days || 0)
          const minDate = days ? Math.floor(Date.now() / 1000) - days * 86400 : 0
          const messages = await client.getMessages(peer, { limit: L.messages || 1000 })
          const bySender = new Map()
          for (const m of messages) {
            if (!m?.senderId) continue
            if (minDate && m.date && m.date < minDate) continue
            if (!F.includeForwarded && m.fwdFrom) continue
            const text = m.message || ''
            if (kw.length && !kw.some((k) => text.toLowerCase().includes(k))) continue
            const sid = m.senderId.toString()
            const rec = bySender.get(sid) || { count: 0, first: m.date, last: m.date, sender: m.sender }
            rec.count++; rec.first = Math.min(rec.first, m.date); rec.last = Math.max(rec.last, m.date)
            if (!rec.sender && m.sender) rec.sender = m.sender
            bySender.set(sid, rec)
          }
          for (const [sid, rec] of bySender) {
            if (task.stopRequested || seen.has(sid)) continue
            const u = rec.sender ? mapUser(rec.sender) : { id: sid, name: sid, username: '', bot: false }
            if (!passUser(u)) continue
            seen.add(sid)
            task.results.push({ ...u, kind: 'user', messagesCount: rec.count, firstSeen: new Date(rec.first * 1000).toISOString(), lastSeen: new Date(rec.last * 1000).toISOString() })
            added++
          }
        } else if (kind === 'parsing-comments') {
          const minLen = Number(L.minCommentLen || 0)
          const posts = await fetchPosts(client, peer, L.posts || 50)
          for (const post of posts) {
            if (task.stopRequested) break
            let comments = []
            try { comments = await client.getMessages(peer, { replyTo: post.id, limit: L.commentsPerPost || 100 }) } catch { comments = [] }
            for (const c of comments) {
              if (!c?.senderId) continue
              const text = c.message || ''
              if (minLen && text.length < minLen) continue
              if (kw.length && !kw.some((k) => text.toLowerCase().includes(k))) continue
              const sid = c.senderId.toString()
              if (seen.has(sid)) continue
              const u = c.sender ? mapUser(c.sender) : { id: sid, name: sid, username: '', bot: false }
              if (!passUser(u)) continue
              seen.add(sid)
              task.results.push({ ...u, kind: 'user', ...(F.keepText ? { commentText: text.slice(0, 300) } : {}) })
              added++
            }
            if (delayItemMs) await sleep(delayItemMs)
          }
        }

        await store.saveTask(task)
        await store.appendLog(task, added ? 'success' : 'info', `${src}: +${added} (всего ${task.results.length})`, meta.name)
        await disconnectAccount(client, accountId)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'error', `${src}: ${mapTelegramError(err)}`, meta.name)
        }
      }
      // прогресс — по обработанным группам (а не по числу результатов)
      task = (await store.loadTask(task.id)) || task
      processed++
      task.progress.total = tgs.length
      task.progress.actionsDone = processed
      task.progress.done = processed
      await store.saveTask(task)
      if (!task.stopRequested) await sleep(delayChatMs || pickDelay(3, 6, mul) * 1000)
    }

    // Финализация пересечения: оставляем только тех, кто встретился в >= intersectMin группах.
    if (intersection) {
      task.results = []
      for (const { user, hits } of userHits.values()) {
        if (hits >= intersectMin) task.results.push({ ...user, kind: 'user', groupsCount: hits })
      }
      task.results.sort((a, b) => (b.groupsCount || 0) - (a.groupsCount || 0))
      await store.appendLog(task, 'info', `Пересечение: ${task.results.length} пользователей в ≥${intersectMin} из ${tgs.length} групп`)
    }

    task.progress.total = tgs.length
    task.progress.actionsDone = processed
    task.progress.done = processed
    task.status = task.stopRequested ? 'stopped' : 'done'
    await store.appendLog(task, 'info', `Готово · обработано ${processed}/${tgs.length} групп · найдено ${task.results.length} пользователей`)
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id)
}

export const WORKERS = {
  'neuro-commenting': runNeuroCommenting,
  'neuro-chatting': runNeuroChatting,
  'mass-react': runMassReact,
  'mass-looking': runMassLooking,
  warming: runWarming,
  'neuro-dialogs': runNeuroDialogs,
  ggr: runGgr,
  parsing: (t, s) => runChannelParser(t, s, 'parsing'),
  'parsing-groups': (t, s) => runChannelParser(t, s, 'parsing-groups'),
  'parsing-users': (t, s) => runParticipantsParser(t, s, 'parsing-users'),
  'parsing-messages': (t, s) => runParticipantsParser(t, s, 'parsing-messages'),
  'parsing-comments': (t, s) => runParticipantsParser(t, s, 'parsing-comments'),
}
