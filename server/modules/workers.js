import { generateComment, isAiGenerationEnabled, resolveSystemPrompt } from '../neuroCommenting/commentGenerator.js'
import { buildGoalContext } from '../lib/goalContext.js'
import { upsertMany } from '../channels.js'
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
  interruptibleSleep,
} from '../lib/protection.js'

/** #6: колбэк «пора остановиться?» — читает stop/pause с диска (свежий флаг). */
function makeStopCheck(store, taskId) {
  return async () => { try { const t = await store.loadTask(taskId); return !!(t?.stopRequested || t?.pauseRequested) } catch { return false } }
}
import { getAccountMeta, setAccountMeta } from '../accountsMeta.js'
import { releaseTaskLocks, markTaskLive, markTaskDone, assertAccountAvailable } from '../lib/accountLocks.js'
import { loadSessionString, createClient } from '../tgAuth.js'
import { pickCommentCandidates, trackIdlePass, warmingPace, pickWeightedKey } from '../lib/workerLoop.js'
import { limitReached, incAction } from '../lib/dailyActions.js'
import { cleanMailingNumbers, pickMailingAccount } from '../lib/mailing.js'
import { listLeads, sortDialogsByLeadPriority } from '../leads.js'
import { isSemanticEnabled, embedText, cosineSimilarity } from '../lib/semantic.js'
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

/**
 * Пауза (§3.9): воркер выйдет из цикла как при стопе, но задача останется «paused»
 * (прогресс сохранён) — можно продолжить с /resume. @param {string} taskId @param {object} store
 */
export async function pauseWorker(taskId, store) {
  const task = await store.loadTask(taskId)
  if (!task) return null
  if (task.status !== 'running' && task.status !== 'queued') return task
  task.pauseRequested = true
  await store.saveTask(task)
  return task
}

/** Итоговый статус воркера: пауза важнее стопа, стоп важнее «готово». @param {object} task */
export function statusAfterRun(task) {
  return task.pauseRequested ? 'paused' : task.stopRequested ? 'stopped' : 'done'
}

async function finalizeAccounts(accountIds, taskId, paused = false) {
  // На паузе аккаунты остаются зарезервированными за задачей (лок держим) и переходят в статус
  // «pause» — чтобы в менеджере было видно, в каком модуле аккаунт на паузе. На стопе/финише — освобождаем.
  if (taskId && !paused) releaseTaskLocks(taskId)
  for (const id of accountIds) {
    const meta = await getAccountMeta(id)
    if (meta.status === 'working') await setAccountMeta(id, { status: paused ? 'pause' : 'active' })
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
/** §3.5: взвешенный выбор индекса типа комментария по распределению (сумма ≈ 100%). */
function weightedPickIndex(weights) {
  const total = weights.reduce((a, b) => a + (Number(b) || 0), 0)
  if (total <= 0) return 0
  let r = Math.random() * total
  for (let i = 0; i < weights.length; i++) { r -= Number(weights[i]) || 0; if (r < 0) return i }
  return weights.length - 1
}

export async function runNeuroCommenting(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  task.readyTargets = task.readyTargets || []
  task.actionKeys = task.actionKeys || []
  await store.saveTask(task)
  await store.appendLog(task, 'info', 'Нейрокомментинг запущен')

  // §3.6/§4: если задача привязана к цели — подмешиваем цель + базу знаний в системный промпт.
  const goalCtx = await buildGoalContext(s.goalId)
  if (goalCtx) await store.appendLog(task, 'info', 'Комментарии генерируются к выбранной цели (с базой знаний)')

  // §3.5 семантика: если включён семантический фильтр и есть цель — считаем её вектор один раз.
  const semanticOn = !!s.semanticFilter && !!goalCtx && isSemanticEnabled()
  const semanticThreshold = Number(s.semanticThreshold ?? 0.2)
  let goalVec = null
  if (semanticOn) {
    goalVec = await embedText(goalCtx)
    await store.appendLog(task, goalVec ? 'info' : 'warning', goalVec
      ? `Семантический фильтр к цели включён (порог ${semanticThreshold})`
      : 'Семантический фильтр недоступен (нет ответа embeddings) — работаем без него')
  }

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
    while (!task.stopRequested && !task.pauseRequested && !totalLimitReached(s, task)) {
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
      if (await limitReached(accountId, 'comments')) { idleLap += 1; await store.appendLog(task, 'info', 'Суточный лимит комментариев достигнут (§6)', meta.name); continue }
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
          makeStopCheck(store, task.id), // #6: прерываемая задержка вступления
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
        if (membership.status === 'joined') await incAction(accountId, 'joins') // §6: суточный лимит вступлений

        // §3.5: окно постов — обрабатываем только последние N, не всю историю канала.
        const posts = await fetchPosts(client, channel, Math.min(50, Math.max(1, Number(s.postWindow) || 20)))
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

            if (await interruptibleSleep(pickDelay(s.delays?.comment?.[0] ?? 30, s.delays?.comment?.[1] ?? 120, mul) * 1000, makeStopCheck(store, task.id))) break // #6
            const postText = (post.message || '').trim() || (post.media ? '[медиа]' : '')
            // §3.5 семантика: пропускаем посты, семантически далёкие от цели кампании.
            if (goalVec) {
              const pv = await embedText(postText)
              const sim = pv ? cosineSimilarity(pv, goalVec) : 1 // нет вектора поста → не режем
              if (sim < semanticThreshold) {
                await store.appendLog(task, 'info', `Пропуск по семантике (близость к цели ${sim.toFixed(2)} < ${semanticThreshold})`, meta.name)
                continue
              }
            }
            // §3.5: если задано распределение типов — на каждый коммент выбираем тип по весу.
            const useDist = Array.isArray(s.typeWeights) && s.typeWeights.some((w) => Number(w) > 0)
            const typeIdx = useDist ? weightedPickIndex(s.typeWeights) : (s.promptIndex ?? 0)
            const sysPrompt = useDist ? resolveSystemPrompt({ ...s, promptIndex: typeIdx, promptText: '' }) : resolveSystemPrompt(s)
            const { text, mode } = await generateComment(postText, typeIdx, sysPrompt + goalCtx)
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
              await incAction(accountId, 'comments') // §6: суточный лимит действий
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
    task.status = statusAfterRun(task)
    await store.appendLog(task, 'info', task.status === 'done' ? 'Завершено' : 'Остановлено')
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
}

/** @param {object} task @param {object} store */
export async function runNeuroChatting(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  task.readyTargets = task.readyTargets || []
  await store.saveTask(task)
  await store.appendLog(task, 'info', 'Нейрочаттинг запущен')
  const goalCtx = await buildGoalContext(s.goalId) // §3.6: диалог к цели с базой знаний
  if (goalCtx) await store.appendLog(task, 'info', 'Ответы генерируются к выбранной цели (с базой знаний)')
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const prob = effectiveProbability(s.probability ?? 30, !!s.aiProtection, s.protectionLevel ?? 1)
  const groups = targets(s)
  let idx = 0
  let idleLap = 0
  const accountIds = s.accountIds || []

  try {
    while (!task.stopRequested && !task.pauseRequested && !totalLimitReached(s, task)) {
      if (idleLap >= accountIds.length) {
        await store.appendLog(task, 'info', 'Все аккаунты исчерпали лимиты на эту задачу — завершаем')
        break
      }
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await getAccountMeta(accountId)
      if (!isAccountRunnable(meta.status || 'active') || perAccountLimitReached(s, accountId, task)) { idleLap += 1; continue }
      if (await limitReached(accountId, 'comments')) { idleLap += 1; await store.appendLog(task, 'info', 'Суточный лимит сообщений достигнут (§6)', meta.name); continue }
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
          makeStopCheck(store, task.id), // #6
        )
        if (!membership?.peer) {
          await disconnectAccount(client, accountId)
          if (trackIdlePass(task, false)) break
          continue
        }
        const peer = membership.peer
        if (membership.status === 'joined') await incAction(accountId, 'joins') // §6: суточный лимит вступлений
        const msgs = await fetchPosts(client, peer, 15)
        const msg = msgs[Math.floor(Math.random() * msgs.length)]
        if (!msg || Math.random() * 100 > prob) {
          await store.appendLog(task, 'info', msg ? `Пропуск по вероятности (${prob}%)` : 'Нет сообщений в чате', meta.name)
          await disconnectAccount(client, accountId)
          if (trackIdlePass(task, false)) break
          continue
        }
        await sleep(pickDelay(s.delays?.action?.[0] ?? 42, s.delays?.action?.[1] ?? 78, mul) * 1000)
        const { text: reply, mode } = await generateComment(msg.message || '', s.promptIndex ?? 0, resolveSystemPrompt(s) + goalCtx)
        if (mode !== 'openai') {
          await store.appendLog(task, 'warning', mode === 'template_no_key' ? 'Шаблон (нет OPENAI_API_KEY)' : 'Шаблон (OpenAI недоступен)', meta.name)
        }
        await client.sendMessage(peer, { message: reply, replyTo: msg.id })
        task.accountStats[accountId] = task.accountStats[accountId] || { actions: 0, floodWaits: 0 }
        task.accountStats[accountId].actions += 1
        await incAction(accountId, 'comments') // §6: групповые сообщения — под лимит комментариев
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
    task.status = statusAfterRun(task)
    await store.appendLog(task, 'info', 'Завершено')
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
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
    while (!task.stopRequested && !task.pauseRequested && !totalLimitReached(s, task)) {
      if (idleLap >= accountIds.length) {
        await store.appendLog(task, 'info', 'Все аккаунты исчерпали лимиты на эту задачу — завершаем')
        break
      }
      const accountId = accountIds[idx++ % accountIds.length]
      const meta = await getAccountMeta(accountId)
      if (!isAccountRunnable(meta.status || 'active') || perAccountLimitReached(s, accountId, task)) { idleLap += 1; continue }
      if (await limitReached(accountId, 'reactions')) { idleLap += 1; await store.appendLog(task, 'info', 'Суточный лимит реакций достигнут (§6)', meta.name); continue }
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
          if (membership.status === 'joined') await incAction(accountId, 'joins') // §6: суточный лимит вступлений
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
        await incAction(accountId, 'reactions') // §6: суточный лимит реакций
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
    task.status = statusAfterRun(task)
    await store.appendLog(task, 'info', 'Завершено')
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
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
    while (!task.stopRequested && !task.pauseRequested && !totalLimitReached(s, task)) {
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
        if (membership.status === 'joined') await incAction(accountId, 'joins') // §6: суточный лимит вступлений
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
    task.status = statusAfterRun(task)
    await store.appendLog(task, 'info', 'Завершено')
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
}

/** @param {object} task @param {object} store */
export async function runWarming(task, store) {
  const s = task.settings
  task.startedAt = Date.now()
  task.status = 'running'
  await store.saveTask(task)
  // 3 уровня прогрева (§8.2, названия заказчика): длиннее уровень — медленнее/естественнее темп.
  const pace = warmingPace(s.warmLevel ?? 1)
  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1) * pace.mul
  await store.appendLog(task, 'info', `Прогрев запущен · уровень: ${pace.label} · ~${pace.actionsPerDay} действий/день на аккаунт`)
  const accountIds = s.accountIds || []
  let idx = 0
  let idleLap = 0

  try {
    while (!task.stopRequested && !task.pauseRequested && !totalLimitReached(s, task)) {
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
        // §8.2: тип действия выбирается по пропорции уровня (view/react/read/join/ping).
        // Реальные реакции/вступления выполняются под суточными лимитами §6 (при достижении
        // потолка действие деградирует в безопасный просмотр). Бизнес-логика — Help Center «Политика прогрева».
        const kind = pickWeightedKey(pace.weights)
        const warmQuery = () => ['news', 'music', 'tech', 'crypto', 'sport', 'movies'][Math.floor(Math.random() * 6)]
        if (kind === 'react' && !(await limitReached(accountId, 'reactions'))) {
          const chats = await searchPublic(client, warmQuery(), 6)
          const target = chats[Math.floor(Math.random() * chats.length)]
          let reacted = false
          if (target) {
            try {
              const posts = await fetchPosts(client, target, 5)
              const post = posts[Math.floor(Math.random() * posts.length)]
              if (post) {
                const emoji = ['👍', '❤️', '🔥', '👏'][Math.floor(Math.random() * 4)]
                await sendReaction(client, target, post.id, emoji)
                await incAction(accountId, 'reactions')
                await store.appendLog(task, 'success', `Прогрев: реакция ${emoji} в «${target.title || target.username || 'канал'}»`, meta.name)
                reacted = true
              }
            } catch { /* канал без реакций/приватный — деградируем в просмотр */ }
          }
          if (!reacted) await store.appendLog(task, 'info', 'Прогрев: просмотр каналов · react→view', meta.name)
        } else if (kind === 'join' && !(await limitReached(accountId, 'joins'))) {
          const chats = await searchPublic(client, warmQuery(), 8)
          const target = chats.find((c) => c.username)
          let joined = false
          if (target?.username) {
            const m = await joinTargetOrSkip(client, target.username, (l, msg, a) => store.appendLog(task, l, msg, a), meta.name)
            if (m?.status === 'joined') { await incAction(accountId, 'joins'); joined = true }
            else if (m?.peer) joined = true // уже участник — тоже засчитываем заход
          }
          if (!joined) { await client.getMe(); await store.appendLog(task, 'info', 'Прогрев: keepalive · join→ping', meta.name) }
        } else if (kind === 'read') {
          const ds = await fetchDialogs(client, 10)
          await store.appendLog(task, 'info', `Прогрев: чтение диалогов (${ds.length})`, meta.name)
        } else if (kind === 'ping') {
          await client.getMe()
          await store.appendLog(task, 'info', 'Прогрев: keepalive · ping', meta.name)
        } else {
          const chats = await searchPublic(client, 'news', 5)
          await store.appendLog(task, 'info', `Прогрев: просмотр каналов (${chats.length}) · ${kind}`, meta.name)
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
    task.status = statusAfterRun(task)
    await store.appendLog(task, 'info', 'Прогрев завершён')
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
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
  // Модуль-ответчик работает долго (ждёт входящие ЛС), поэтому при суточном лимите
  // не завершаемся, а тихо простаиваем — лог о достижении лимита пишем один раз на аккаунт.
  const dmCapLogged = new Set()
  // Последнее входящее сообщение, на которое уже ответили: не отвечаем дважды на одно и то же,
  // но отвечаем снова, когда собеседник напишет новое.
  const answeredUpTo = new Map()

  try {
    while (!task.stopRequested && !task.pauseRequested && !totalLimitReached(s, task)) {
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
      if (await limitReached(accountId, 'dm')) {
        skips += 1
        if (!dmCapLogged.has(accountId)) {
          dmCapLogged.add(accountId)
          await store.appendLog(task, 'info', 'Суточный лимит ЛС достигнут (§6) — аккаунт простаивает до сброса', meta.name)
        }
        continue
      }
      skips = 0
      dmCapLogged.delete(accountId) // снова активен (лимит сброшен новым днём) — разрешаем лог заново
      let client
      try {
        ;({ client } = await connectAccount(accountId, task.id))
        const dialogs = await fetchDialogs(client, 20)
        // Авто-режим отвечает только на личные диалоги (ЛС) с людьми — каналы, группы и боты пропускаются.
        const personal = dialogs.filter((d) => d.entity?.className === 'User' && !d.entity?.bot)
        // «Только новые» — непрочитанные. «Всем, кто писал» — любой диалог, где последнее слово за собеседником.
        const waitingRaw = personal.filter((d) => {
          if (!replyAll) return d.unread > 0
          if (d.lastOut || !d.lastMessageId) return false
          return (answeredUpTo.get(`${accountId}:${d.id}`) ?? 0) < d.lastMessageId
        })
        // §3.6: приоритет ответившему — отвечаем сначала горячим/ответившим лидам (CRM).
        const leadsForPrio = await listLeads(s.goalId ? { goalId: s.goalId } : {})
        const waiting = sortDialogsByLeadPriority(waitingRaw, leadsForPrio)
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
          if (await limitReached(accountId, 'dm')) { await store.appendLog(task, 'info', 'Суточный лимит ЛС достигнут (§6)', meta.name); break }
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
          await incAction(accountId, 'dm') // §6: суточный лимит ЛС
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
    task.status = statusAfterRun(task)
    await store.appendLog(task, 'info', task.status === 'stopped' ? 'Остановлено' : 'Завершено')
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
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
  await store.appendLog(task, 'info', `AIR-проверка: ${allIds.length} аккаунтов`)

  try {
    for (const accountId of allIds) {
      if (task.stopRequested || task.pauseRequested) break
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
    task.status = statusAfterRun(task)
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
  const baseChannels = [] // копим найденное для общей базы каналов (§3.8), упсерт батчем в конце
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

  // Собираем поисковые запросы: ключевые слова + комбинации с окончаниями.
  // Каждый запрос помнит индекс исходного ключевого слова (для AND-пересечения §3.8).
  const keywords = (s.keywords || []).map((k) => String(k).trim()).filter(Boolean)
  const endings = (s.endings || []).map((e) => String(e).trim()).filter(Boolean)
  const andMode = !!s.intersect && keywords.length > 1 // §3.8: канал должен совпасть со ВСЕМИ ключами
  const hitsByKey = new Map() // channelKey → Set<индекс ключевого слова> (для AND)
  const queries = []
  const seenQuery = new Set()
  const pushQuery = (q, kwIdx) => { const v = q.trim(); if (v && !seenQuery.has(v.toLowerCase())) { seenQuery.add(v.toLowerCase()); queries.push({ q: v, kwIdx }) } }
  keywords.forEach((kw, kwIdx) => {
    pushQuery(kw, kwIdx)
    for (const end of endings) pushQuery(`${kw} ${end}`, kwIdx)
  })
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
    for (const { q, kwIdx } of queries) {
      // В AND-режиме нельзя рано выходить по лимиту — нужно просканировать все ключи для пересечения.
      if (task.stopRequested || task.pauseRequested || (!andMode && task.results.length >= limit)) break

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
          if (task.stopRequested || task.pauseRequested || (!andMode && task.results.length >= limit)) break

          // тип: канал vs группа
          if (wantGroups) { if (c.isBroadcast && !c.isMegagroup) continue }
          else if (!c.isBroadcast) continue

          const key = (c.username || c.id).toLowerCase()
          if (!key) continue
          if (skipParsed.has(key)) continue

          // фильтр комментариев: открытые = мегагруппа/есть обсуждение, закрытые = обычный канал
          if (comments === 1 && c.isBroadcast && !c.isMegagroup) continue
          if (comments === 2 && c.isMegagroup) continue

          // §3.8 AND: отмечаем совпадение ключа — даже если канал уже добавлен другим ключом.
          if (andMode) { let set = hitsByKey.get(key); if (!set) { set = new Set(); hitsByKey.set(key, set) } set.add(kwIdx) }
          if (seen.has(key)) continue

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
          // §3.8/§4: копим для общей базы — упсертим одним батчем в конце (без дублей).
          baseChannels.push({ title: c.title, username: c.username, subscribers: members, hasComments: !!c.isMegagroup, tgPeerId: c.id })
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

    // §3.8 AND-пересечение: оставляем только каналы, совпавшие со ВСЕМИ ключевыми словами.
    if (andMode && !task.stopRequested) {
      const need = keywords.length
      const before = task.results.length
      const keep = (r) => (hitsByKey.get((r.username || r.id).toLowerCase())?.size || 0) >= need
      task.results = task.results.filter(keep).slice(0, limit === Infinity ? undefined : limit)
      const keepSet = new Set(task.results.map((r) => (r.username || r.id).toLowerCase()))
      for (let i = baseChannels.length - 1; i >= 0; i--) {
        if (!keepSet.has((baseChannels[i].username || baseChannels[i].tgPeerId || '').toString().toLowerCase())) baseChannels.splice(i, 1)
      }
      await store.appendLog(task, 'info', `AND-пересечение (${need} ключей): ${before} → ${task.results.length}`)
    }

    task.progress.total = task.results.length
    task.progress.done = task.results.length
    task.progress.actionsDone = task.results.length
    task.status = statusAfterRun(task)
    // §3.8/§4: найденные каналы — в общую базу одним батчем (дедуп, без потери данных).
    try { const n = await upsertMany(baseChannels, `parse:${task.id}`); if (n) await store.appendLog(task, 'info', `В базу каналов: ${n}`) } catch { /* ignore */ }
    await store.appendLog(task, 'info', `Готово · найдено ${task.results.length} ${unitLabel}`)
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
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
    task.status = statusAfterRun(task)
    await store.appendLog(task, 'info', `Готово · обработано ${processed}/${tgs.length} групп · найдено ${task.results.length} пользователей`)
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
}

/**
 * Мейлинг: реальная рассылка в Telegram по номерам телефонов (§8.4).
 * Отправка НЕ «слепая»: жёсткие предохранители §6 — только аккаунты с trust>70, суточный
 * лимит ЛС (dm), паузы 90–300с, пропуск номеров, которых нет в Telegram, FloodWait→карантин.
 * Номер резолвим через contacts.ImportContacts, шлём ЛС (шаблон или ИИ-текст к цели).
 * @param {object} task @param {object} store
 */
/** §11: тип вложения по URL (зеркало фронтового mediaKind). */
function mediaKindUrl(url) {
  const u = String(url).toLowerCase().split('?')[0]
  if (/\.(jpe?g|png|webp|gif|bmp|heic)$/.test(u)) return 'image'
  if (/\.(mp4|mov|webm|mkv|avi|m4v)$/.test(u)) return 'video'
  return 'link'
}

/**
 * §11: отправка сообщения с медиа и Markdown-форматированием.
 * Фото/видео (по URL) шлём как файлы с подписью; прочие ссылки добавляем в текст.
 * Markdown — с фолбеком на обычный текст, если разметка малформед.
 * @param {import('telegram').TelegramClient} client
 */
async function sendComposedMessage(client, peer, text, mediaUrls = []) {
  const urls = (Array.isArray(mediaUrls) ? mediaUrls : []).filter((u) => /^https?:\/\//i.test(u))
  const files = urls.filter((u) => mediaKindUrl(u) !== 'link')
  const links = urls.filter((u) => mediaKindUrl(u) === 'link')
  const caption = [text, ...links].filter(Boolean).join('\n')

  const sendText = async (msg) => {
    try { await client.sendMessage(peer, { message: msg, parseMode: 'md', linkPreview: true }) }
    catch { await client.sendMessage(peer, { message: msg }) } // малформед markdown → плейн-текст
  }

  if (files.length) {
    try {
      await client.sendFile(peer, { file: files, caption, parseMode: 'md' })
      return
    } catch {
      // Файлы недоступны по URL — шлём текст со всеми ссылками (Telegram сделает превью).
      await sendText([text, ...urls].filter(Boolean).join('\n'))
      return
    }
  }
  await sendText(caption)
}

export async function runMailing(task, store) {
  const s = task.settings || {}
  const accountIds = Array.isArray(s.accountIds) ? s.accountIds : []
  const numbers = cleanMailingNumbers(s.targets)
  const message = String(s.promptText || s.message || '').trim()

  task.status = 'running'
  task.progress = { done: 0, total: numbers.length }
  task.accountStats = task.accountStats || {}
  await store.saveTask(task)
  await store.appendLog(task, 'info', `Мейлинг: ${numbers.length} номеров на ${accountIds.length} аккаунт(ов)`)

  if (!numbers.length) { await store.appendLog(task, 'warning', 'Нет корректных номеров для рассылки'); task.status = 'done'; await store.saveTask(task); return }
  if (!accountIds.length) { await store.appendLog(task, 'warning', 'Не выбраны аккаунты'); task.status = 'done'; await store.saveTask(task); return }
  if (!message) { await store.appendLog(task, 'warning', 'Пустой текст рассылки'); task.status = 'done'; await store.saveTask(task); return }

  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const dm = s.delays?.dm || s.delays?.action || [90, 300] // §6: паузы рассылки ЛС 90–300с
  const maxPerAccount = Number(s.maxPerAccount || 0)
  const goalCtx = await buildGoalContext(s.goalId)
  const useAi = !!s.aiPerRecipient && isAiGenerationEnabled()
  const mediaCount = Array.isArray(s.mediaUrls) ? s.mediaUrls.filter((u) => /^https?:\/\//i.test(u)).length : 0
  await store.appendLog(task, 'info', `Текст: ${useAi ? 'ИИ-генерация к цели' : `"${message.slice(0, 70)}${message.length > 70 ? '…' : ''}"`}${mediaCount ? ` · медиа/ссылок: ${mediaCount}` : ''} · паузы ${dm[0]}–${dm[1]}с · лимит/акк ${maxPerAccount || '§6'}`)

  const { Api } = await import('telegram/tl/index.js')
  const { default: bigInt } = await import('big-integer')
  const { buildAccountStats } = await import('../accountStats.js')

  // Предохранитель §6: рассылка только с прогретых аккаунтов (trust > 70), активных.
  const usable = []
  for (const id of accountIds) {
    const meta = await getAccountMeta(id)
    if (!isAccountRunnable(meta.status || 'active')) { await store.appendLog(task, 'warning', `Пропуск: статус ${meta.status}`, meta.name); continue }
    let trust = 0
    try { trust = (await buildAccountStats(id)).trust?.score ?? 0 } catch { trust = 0 }
    if (trust <= 70) { await store.appendLog(task, 'warning', `${meta.name}: trust ${trust} ≤ 70 — пропущен (§6: рассылка только с trust>70)`, meta.name); continue }
    usable.push(id)
  }
  if (!usable.length) { await store.appendLog(task, 'warning', 'Нет аккаунтов с trust>70 — рассылка не запущена (§6). Прогрейте аккаунты.'); task.status = 'done'; await store.saveTask(task); return }
  await store.appendLog(task, 'info', `К рассылке допущено аккаунтов: ${usable.length}/${accountIds.length} (trust>70)`)

  let sent = 0
  let skipped = 0
  let idx = 0
  const perAccSent = {}

  try {
    for (const phone of numbers) {
      task = (await store.loadTask(task.id)) || task
      if (task.stopRequested || task.pauseRequested || totalLimitReached(s, task)) break

      // Выбрать аккаунт round-robin, у которого не исчерпан суточный лимит ЛС и maxPerAccount.
      // dm-лимит асинхронный — предвычисляем множество «исчерпавших» для чистого выбора.
      const dmReached = new Set()
      for (const cand of usable) if (await limitReached(cand, 'dm')) dmReached.add(cand)
      const picked = pickMailingAccount(usable, idx, { perAccSent, maxPerAccount, isDmReached: (id) => dmReached.has(id) })
      const account = picked.account
      idx = picked.idx
      if (!account) { await store.appendLog(task, 'info', 'Все аккаунты исчерпали суточный лимит ЛС (§6) — завершаем'); break }

      const meta = await getAccountMeta(account)
      let client
      try {
        ;({ client } = await connectAccount(account, task.id))
        // 1) Резолв номера → пользователь Telegram.
        const res = await client.invoke(new Api.contacts.ImportContacts({
          contacts: [new Api.InputPhoneContact({ clientId: bigInt(idx * 1000 + sent + skipped), phone: `+${phone}`, firstName: 'Lead', lastName: '' })],
        }))
        const user = res.users?.[0]
        if (!user) {
          skipped += 1
          task.progress.done = sent + skipped
          await store.appendLog(task, 'info', `+${phone}: нет в Telegram — пропуск`, meta.name)
          await disconnectAccount(client, account)
          continue
        }
        // 2) Текст: шаблон или ИИ к цели.
        let text = message
        if (useAi) {
          const gen = await generateComment(message || 'Напиши короткое дружелюбное первое сообщение по цели', s.promptIndex ?? 0, resolveSystemPrompt(s) + goalCtx)
          if (gen.text) text = gen.text
        }
        // 3) Пауза «по-человечески» и отправка (#6: прерываемая — стоп не шлёт лишнее ЛС).
        if (await interruptibleSleep(pickDelay(dm[0], dm[1], mul) * 1000, makeStopCheck(store, task.id))) { await disconnectAccount(client, account); break }
        await sendComposedMessage(client, user, text, s.mediaUrls) // §11: текст + медиа/ссылки
        await incAction(account, 'dm') // §6: суточный лимит ЛС
        // Не засоряем адресную книгу аккаунта импортированными номерами.
        try { await client.invoke(new Api.contacts.DeleteContacts({ id: [user] })) } catch { /* не критично */ }
        perAccSent[account] = (perAccSent[account] || 0) + 1
        sent += 1
        task.accountStats[account] = task.accountStats[account] || { actions: 0, floodWaits: 0 }
        task.accountStats[account].actions += 1
        task.progress.done = sent + skipped
        await store.appendHistory(task, { id: `${task.id}_${Date.now()}`, ts: new Date().toISOString(), accountName: meta.name, target: `+${phone}`, text, status: 'sent' })
        await store.appendLog(task, 'success', `ЛС → +${phone} (${user.firstName || 'user'})`, meta.name)
        await bumpProgress(task, store)
        await disconnectAccount(client, account)
      } catch (err) {
        if (client) await disconnectAccount(client, account)
        if (!(await handleFlood(task, account, store, err, s, meta.name))) {
          await store.appendLog(task, 'error', mapTelegramError(err), meta.name)
        }
      }
    }
    task.status = statusAfterRun(task)
    await store.appendLog(task, 'info', `Мейлинг завершён · отправлено ${sent} · пропущено ${skipped} (нет в Telegram)`)
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
}

/**
 * Автопостинг (§8.10, паритет): публикация поста в СВОИ каналы/группы по расписанию.
 * Безопасно — постим в свои каналы (аккаунт должен быть админом с правом постинга), не спам.
 * @param {object} task @param {object} store
 */
export async function runAutoPosting(task, store) {
  const s = task.settings || {}
  const accountIds = Array.isArray(s.accountIds) ? s.accountIds : []
  const channels = targets(s)
  const text = String(s.promptText || s.message || '').trim()

  task.status = 'running'
  task.progress = { done: 0, total: channels.length }
  await store.saveTask(task)
  await store.appendLog(task, 'info', `Автопостинг: ${channels.length} каналов · ${accountIds.length} аккаунт(ов)`)

  if (!channels.length) { await store.appendLog(task, 'warning', 'Нет целевых каналов'); task.status = 'done'; await store.saveTask(task); return }
  if (!accountIds.length) { await store.appendLog(task, 'warning', 'Не выбраны аккаунты'); task.status = 'done'; await store.saveTask(task); return }
  if (!text) { await store.appendLog(task, 'warning', 'Пустой текст поста'); task.status = 'done'; await store.saveTask(task); return }

  const mul = delayMultiplier(s.protectionLevel ?? 1, s.delayPreset ?? 1)
  const { resolvePeer } = await import('../lib/gramHelpers.js')
  let accIdx = 0
  try {
    for (const ch of channels) {
      if (task.stopRequested || task.pauseRequested) break
      const accountId = accountIds[accIdx++ % accountIds.length]
      const meta = await getAccountMeta(accountId)
      if (!isAccountRunnable(meta.status || 'active')) { await store.appendLog(task, 'warning', `Пропуск: ${meta.status}`, meta.name); continue }
      let client
      try {
        ;({ client } = await connectAccount(accountId, task.id))
        const entity = await resolvePeer(client, ch)
        await sendComposedMessage(client, entity, text, s.mediaUrls) // §11: текст + медиа/ссылки
        task.history = task.history || []
        task.history.unshift({ id: `${task.id}_${task.progress.done}`, ts: new Date().toISOString(), accountName: meta.name, channel: ch, text: text.slice(0, 200), status: 'sent' })
        task.progress.done += 1
        await store.appendLog(task, 'success', `Пост в ${ch}`, meta.name)
        await store.saveTask(task)
        await disconnectAccount(client, accountId)
        await sleep(pickDelay(s.delays?.action?.[0] ?? 60, s.delays?.action?.[1] ?? 180, mul) * 1000)
      } catch (err) {
        if (client) await disconnectAccount(client, accountId)
        if (!(await handleFlood(task, accountId, store, err, s, meta.name))) {
          await store.appendLog(task, 'error', `${ch}: ${mapTelegramError(err)} (нужны права админа на постинг?)`, meta.name)
        }
      }
      task = (await store.loadTask(task.id)) || task
    }
    task.status = statusAfterRun(task)
    await store.appendLog(task, 'info', 'Автопостинг завершён')
  } catch (err) {
    task.status = 'error'
    await store.appendLog(task, 'error', err instanceof Error ? err.message : 'Ошибка')
  }
  await store.saveTask(task)
  await finalizeAccounts(accountIds, task.id, !!task.pauseRequested)
}

export const WORKERS = {
  mailing: runMailing,
  autoposting: runAutoPosting,
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
