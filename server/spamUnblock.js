/**
 * Снятие спамблока через @SpamBot — как НАСТОЯЩАЯ фоновая задача (модуль `spam-unblock`).
 *
 * Раньше это был отдельный in-memory джоб со своим статусом. Теперь — обычная задача:
 * видна в «Дашборде задач», со своими логами/прогрессом, кнопкой «Стоп», переживает
 * ничего лишнего. Идёт по спамблокнутым аккаунтам ПО ОДНОМУ с РАНДОМНЫМИ паузами
 * (пачка апелляций «под копирку» в минуту — сам по себе кластерный признак, §4.4).
 *
 * ⚠️ Апелляция ≠ гарантия: это жалоба модераторам Telegram.
 */
import { loadSessionString, createClient } from './tgAuth.js'
import { accountFingerprint } from './lib/deviceFingerprint.js'
import { getAccountMeta, setAccountStatus, setAccountMeta } from './accountsMeta.js'
import { appealSpamblock } from './lib/spamAppeal.js'
import { waitAccountWork, endAccountWork } from './lib/accountBusy.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const LABEL = {
  clean: 'ограничение СНЯТО',
  appealed: 'жалоба подана — ждём модерацию',
  blocked: 'ограничение осталось',
  unknown: 'статус неясен',
  busy: 'аккаунт занят другим модулем — пропущен',
  error: 'ошибка подключения',
}

/**
 * Снять спамблок с одного аккаунта: подключиться, апеллировать, при успехе — в строй.
 *
 * Слот занятости берём сам, а не через connectAccount: модуль по определению работает со
 * СПАМБЛОКНУТЫМИ аккаунтами, и статус-гейт connectAccount (isAccountRunnable) не пустил бы
 * сюда ни одного. Но вторую сессию тем же ключом, пока аккаунтом работает другой модуль,
 * открывать нельзя — за это и отвечает реестр занятости.
 * @param {string} accountId @param {string} [taskId] @param {() => boolean} [shouldStop]
 */
async function appealOne(accountId, taskId, shouldStop) {
  const meta = await getAccountMeta(accountId).catch(() => ({}))
  const name = meta?.name || accountId.slice(-6)
  const sessionStr = await loadSessionString(accountId).catch(() => '')
  if (!sessionStr) return { name, state: 'error', text: 'нет сессии', appealed: false }
  if (taskId) {
    try {
      // Апелляция не срочная — можно подождать, пока аккаунт закончит текущее действие.
      await waitAccountWork(accountId, 'spam-unblock', taskId, { timeoutMs: 60 * 1000, shouldStop })
    } catch (e) {
      return { name, state: 'busy', text: e instanceof Error ? e.message : '', appealed: false }
    }
  }
  let client
  try {
    client = await createClient(sessionStr, meta.proxy, accountFingerprint(accountId, meta))
    const res = await appealSpamblock(client)
    try { await client.disconnect() } catch { /* ignore */ }
    if (res.state === 'clean') {
      try {
        await setAccountStatus(accountId, 'active', { code: '', reason: 'Спамблок снят через @SpamBot', initiator: 'system' })
      } catch { await setAccountMeta(accountId, { status: 'active', statusReason: 'Спамблок снят через @SpamBot' }).catch(() => {}) }
    }
    return { name, state: res.state, text: res.text, appealed: res.appealed }
  } catch (e) {
    try { if (client) await client.disconnect() } catch { /* ignore */ }
    return { name, state: 'error', text: e instanceof Error ? e.message : 'ошибка', appealed: false }
  } finally {
    if (taskId) endAccountWork(accountId, taskId)
  }
}

/**
 * Воркер задачи `spam-unblock`. Сигнатура как у остальных: (task, store).
 * @param {object} task @param {object} store
 */
export async function runSpamUnblock(task, store) {
  // Живой объект задачи: «Стоп»/«Пауза» ставят флаг прямо на нём (signalLiveTask), а `task`
  // ниже переприсваивается перечитанной с диска копией и эту связь теряет.
  const liveTask = task
  const s = task.settings || {}
  const ids = Array.isArray(s.accountIds) ? s.accountIds : []
  const delayMin = Math.max(5, Math.round(Number(s.delayMin) || 30))
  const delayMax = Math.max(delayMin, Math.round(Number(s.delayMax) || 120))

  task.status = 'running'
  task.progress = { done: 0, total: ids.length, actionsDone: 0, cleared: 0 }
  await store.saveTask(task)
  await store.appendLog(task, 'info', `Снятие спамблока: ${ids.length} акк., паузы ${delayMin}–${delayMax}с (вразнобой)`)

  for (let i = 0; i < ids.length; i++) {
    // Перечитываем задачу — операторский «Стоп»/«Пауза» выставляет флаг на диске.
    task = (await store.loadTask(task.id)) || task
    if (task.stopRequested || task.pauseRequested) {
      await store.appendLog(task, 'info', 'Остановлено оператором — прервано')
      break
    }

    // shouldStop читает флаг с ПЕРЕЧИТАННОЙ задачи (см. выше по циклу): без него «Стоп»
    // ждал бы освобождения аккаунта до конца таймаута на каждом профиле.
    const r = await appealOne(ids[i], task.id, () => !!(liveTask.stopRequested || liveTask.pauseRequested || task.stopRequested || task.pauseRequested))
    const level = r.state === 'clean' ? 'success' : r.state === 'error' ? 'error' : r.state === 'busy' ? 'warning' : 'info'
    await store.appendLog(task, level, `@SpamBot: ${LABEL[r.state] || r.state}${r.text ? ` — ${r.text}` : ''}`, r.name)

    task = (await store.loadTask(task.id)) || task
    task.progress.done = i + 1
    task.progress.actionsDone = i + 1
    if (r.state === 'clean') task.progress.cleared = (task.progress.cleared || 0) + 1
    await store.saveTask(task)

    // Рандомная пауза перед следующим (после последнего не ждём).
    if (i < ids.length - 1 && !task.stopRequested) {
      const secs = delayMin + Math.random() * (delayMax - delayMin)
      await sleep(Math.round(secs * 1000))
    }
  }

  task = (await store.loadTask(task.id)) || task
  if (task.status === 'running') {
    task.status = 'done'
    await store.appendLog(task, 'info', `Готово · снято ${task.progress.cleared || 0} из ${task.progress.done}`)
    await store.saveTask(task)
  }
}
