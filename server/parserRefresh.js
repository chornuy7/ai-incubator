/**
 * ПЕРЕПРОВЕРКА СОХРАНЁННЫХ ЗАПРОСОВ ПАРСИНГА (просьба владельца 24.08).
 *
 * «Весь парсинг чтобы сохранял, потом проходился по ним и перепроверял актуальность и
 * новые каналы по тем же ключевым словам — какая-то крона раз в 24 часа; ошибки видно
 * в админке».
 *
 * КАК УСТРОЕНО. У сохранённого запроса (кэш §6/MR-38) поднимается флаг слежения. Раз в
 * полчаса планировщик смотрит, кому пора, и перезапускает ТОТ ЖЕ парс — обычной задачей
 * модуля. Именно обычной, а не «тихо в обход»: тогда работают суточные лимиты, списание
 * монет, блокировки аккаунтов и логи, и авто-обновление ничем не отличается от ручного
 * запуска, кроме инициатора. Результат воркер сам кладёт в кэш под ту же сигнатуру, а мы
 * сравниваем со снимком до прохода: сколько каналов появилось и сколько пропало.
 *
 * ПОЧЕМУ НЕ ВСЁ ПОДРЯД. Перепроверка — это реальный проход по аккаунтам и деньги
 * владельца. Поэтому слежение выключено по умолчанию, включается на конкретный запрос,
 * и за тик берём немного запросов: сотня разом выгребла бы весь парк аккаунтов.
 *
 * ОШИБКИ НЕ ГЛОТАЕМ. Причина падения пишется в строку запроса (`last_error`) и видна в
 * админке. Три неудачи подряд — слежение снимается само, чтобы не долбиться в сломанное;
 * причина остаётся на виду.
 */
import { dueWatches, markWatchRun, diffResults } from './parserCache.js'
import { startModuleTask, launchTask, getModuleStore } from './modules/registry.js'

/** Сколько запросов обновляем за один тик — чтобы не выгрести весь парк аккаунтов. */
const PER_TICK = 3
/** Сколько ждём завершения одной задачи. Парс группы на тысячи участников идёт долго. */
const WAIT_MS = 40 * 60 * 1000
/** Сколько аккаунтов даём одному обновлению. */
const ACCOUNTS_PER_RUN = 2

/** Свободные пригодные аккаунты владельца запроса. */
async function pickAccounts(ownerId) {
  const { tgListAccounts } = await import('./tgAccounts.js')
  const { isAccountRunnable } = await import('./lib/protection.js')
  const all = await tgListAccounts({ includeTrash: false })
  const mine = all.filter((a) => {
    if (ownerId && String(a.ownerId || '') !== String(ownerId)) return false
    return isAccountRunnable(a.status || 'active')
  })
  return mine.slice(0, ACCOUNTS_PER_RUN).map((a) => a.id)
}

/** Дождаться конца задачи. Пауза — тоже конец: дальше сама она не поедет. */
async function waitTask(store, taskId, maxMs = WAIT_MS) {
  const started = Date.now()
  while (Date.now() - started < maxMs) {
    await new Promise((r) => setTimeout(r, 5000))
    const t = await store.loadTask(taskId)
    if (!t) return null
    if (['done', 'stopped', 'error', 'paused'].includes(t.status)) return t
  }
  return null
}

/** Почему задача закончилась плохо — берём последнюю строку лога уровня error. */
function whyFailed(task) {
  const err = (task?.logs || []).find((l) => l.level === 'error')
  return err?.message || `задача завершилась со статусом «${task?.status || 'неизвестно'}»`
}

/**
 * Один проход планировщика.
 * @returns {Promise<{checked:number, added:number, gone:number, failed:number}>}
 */
export async function parserRefreshTick({ perTick = PER_TICK, waitMs = WAIT_MS } = {}) {
  const out = { checked: 0, added: 0, gone: 0, failed: 0 }
  let due = []
  try { due = await dueWatches(Date.now(), perTick) } catch { return out }
  for (const w of due) {
    const common = { failCount: w.failCount, periodH: w.periodH }
    try {
      const accountIds = await pickAccounts(w.ownerId)
      if (!accountIds.length) {
        // Не ошибка кода, а состояние парка — но владелец должен это видеть, иначе
        // «слежение включено, а ничего не обновляется» выглядит поломкой.
        await markWatchRun(w.sig, { ...common, error: 'Нет свободных аккаунтов для перепроверки' })
        out.failed += 1
        continue
      }
      const { store, task } = startModuleTask(w.kind, { ...w.settings, accountIds })
      task.userId = w.ownerId || null
      task.initiator = 'auto-refresh' // в логах и журнале видно, что запуск не ручной
      task.name = `Авто-обновление: ${w.label}`
      await store.saveTask(task)
      await launchTask(w.kind, task, store)
      const fin = await waitTask(store, task.id, waitMs)
      if (!fin || fin.status !== 'done') throw new Error(fin ? whyFailed(fin) : 'перепроверка не уложилась в отведённое время')
      const { added, gone } = diffResults(w.results, fin.results || [])
      await markWatchRun(w.sig, { ...common, added: added.length, gone: gone.length, failCount: 0 })
      out.checked += 1
      out.added += added.length
      out.gone += gone.length
    } catch (err) {
      await markWatchRun(w.sig, { ...common, error: err instanceof Error ? err.message : 'Ошибка перепроверки' }).catch(() => {})
      out.failed += 1
    }
  }
  return out
}

let timer = null
/** Запустить крон перепроверки. Тик частый, а «пора или нет» решает сама строка запроса. */
export function startParserRefreshScheduler(intervalMs = 30 * 60 * 1000) {
  if (timer) clearInterval(timer)
  const run = () => parserRefreshTick()
    .then((r) => { if (r.checked || r.failed) console.log(`[parser] перепроверено запросов: ${r.checked} (новых ${r.added}, пропало ${r.gone})${r.failed ? `, с ошибкой ${r.failed}` : ''}`) })
    .catch((e) => console.warn('[parser] refresh tick failed:', e?.message || e))
  timer = setInterval(run, intervalMs)
  // Первый заход не сразу: на старте бэкенд и так занят — прогрев кэшей, проверка прокси.
  setTimeout(run, 2 * 60 * 1000)
  console.log('[parser] перепроверка сохранённых запросов включена')
}

export function stopParserRefreshScheduler() {
  if (timer) clearInterval(timer)
  timer = null
}

export { getModuleStore }
