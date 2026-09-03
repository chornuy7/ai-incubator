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
import { getCronSync } from './cronSettings.js'

/**
 * Сколько запросов обновляем ОДНОВРЕМЕННО (решение владельца 26.08: «максимум до 3 в
 * параллель, с рандомными задержками»).
 *
 * Это не про экономию, а про заметность: три сервисных аккаунта, разом начавшие
 * одинаковый поиск, выглядят машиной. Между стартами — случайная пауза.
 */
const PER_TICK = 3
/** Случайная пауза между стартами обновлений, мс. */
const STAGGER_MS = { min: 20_000, max: 90_000 }
/** Пауза берётся из настроек админки на каждом тике — правка применяется без выката. */
function jitter() {
  const c = getCronSync()
  const lo = Math.min(c.parserStaggerMinSec, c.parserStaggerMaxSec) * 1000
  const hi = Math.max(c.parserStaggerMinSec, c.parserStaggerMaxSec) * 1000
  return lo + Math.round(Math.random() * (hi - lo))
}
/** Сколько ждём завершения одной задачи. Парс группы на тысячи участников идёт долго. */
const WAIT_MS = 40 * 60 * 1000
/** Сколько аккаунтов даём одному обновлению. */
const ACCOUNTS_PER_RUN = 2

/**
 * Кем обновлять базу.
 *
 * Решение владельца 26.08: ревизию ведёт СЕРВИСНЫЙ ПУЛ платформы — наши аккаунты,
 * которые клиентам не продаются. Причина простая: обновление идёт по нашей инициативе,
 * значит и парк, и деньги наши. Аккаунты клиента в фоне не трогаем вовсе — он их купил
 * под свои задачи, а не под обслуживание общей базы.
 *
 * Если сервисных нет — обновление не делаем и говорим об этом в ошибке запроса, а не
 * подменяем их чужими: молча тратить аккаунты клиента было бы именно тем, чего решили
 * не делать.
 */
async function pickAccounts() {
  const { tgListAccounts } = await import('./tgAccounts.js')
  const { isAccountRunnable } = await import('./lib/protection.js')
  const all = await tgListAccounts({ includeTrash: false })
  /*
   * Только аккаунты ПЛАТФОРМЫ (правка 27.08). Прежний фильтр смотрел на одну отметку
   * «сервисный», а поставить её можно было любому аккаунту из общего парка — в том числе
   * рабочему профилю клиента. Отметка осталась (ею выбирают, кто из наших дежурит), но
   * теперь она действует только поверх признака «наш».
   */
  const pool = all.filter((a) => a.platform === true && a.service === true && isAccountRunnable(a.status || 'active'))
  return pool.slice(0, getCronSync().parserAccounts ?? ACCOUNTS_PER_RUN).map((a) => a.id)
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
export async function parserRefreshTick(opts = {}) {
  const c = getCronSync()
  const perTick = opts.perTick ?? c.parserParallel ?? PER_TICK
  const waitMs = opts.waitMs ?? (c.parserWaitMin ?? 40) * 60_000
  const out = { checked: 0, added: 0, gone: 0, failed: 0 }
  let due = []
  try { due = await dueWatches(Date.now(), perTick) } catch { return out }
  /*
   * Обрабатываем параллельно, но со случайным сдвигом старта: одновременный залп с трёх
   * аккаунтов по одному и тому же каталогу — сигнатура фермы, ровно от которой мы
   * защищаемся во всех остальных модулях.
   */
  await Promise.all(due.map((w, i) => new Promise((resolve) => {
    setTimeout(() => { void refreshOne(w, out).then(resolve) }, i === 0 ? 0 : jitter() * i)
  })))
  return out
}

/** Обновить ОДИН сохранённый запрос. Ошибку не роняем наверх — она пишется в строку запроса. */
async function refreshOne(w, out) {
  const common = { failCount: w.failCount, periodH: w.periodH }
  try {
    /*
     * TGStat перезапускаем НАПРЯМУЮ, а не задачей модуля: он ходит куками каталога,
     * а не аккаунтами. Значит перепроверка здесь не занимает профили и не списывает
     * монеты — а если куки протухли, это и будет ошибкой запроса, которую увидит
     * админка. Ровно тот случай, ради которого и заводился `last_error`.
     */
    if (w.kind === 'tgstat') {
      const [{ searchTgstatChannels }, { getSessionDto, loadSessionRaw }] = await Promise.all([
        import('./tgstat/parser.js'),
        import('./tgstat/store.js'),
      ])
      const session = await getSessionDto()
      if (!session.has_session) throw new Error('TGStat не подключён — загрузите cookies')
      const chats = await searchTgstatChannels(w.settings.filters || {}, await loadSessionRaw(), Math.max(1, Number(w.settings.maxPages) || 3))
      const { saveParserResults } = await import('./parserCache.js')
      await saveParserResults('tgstat', w.settings, chats, w.ownerId)
      const d = diffResults(w.results, chats)
      await markWatchRun(w.sig, { ...common, added: d.added.length, gone: d.gone.length, failCount: 0 })
      out.checked += 1
      out.added += d.added.length
      out.gone += d.gone.length
      return
    }
    const accountIds = await pickAccounts()
    if (!accountIds.length) {
      // Не ошибка кода, а состояние парка — но владелец должен это видеть, иначе
      // «слежение включено, а ничего не обновляется» выглядит поломкой.
      await markWatchRun(w.sig, { ...common, error: 'Нет свободных сервисных аккаунтов для ревизии базы' })
      out.failed += 1
      return
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

let timer = null
/** Запустить крон перепроверки. Тик частый, а «пора или нет» решает сама строка запроса. */
export function startParserRefreshScheduler(intervalMs = (getCronSync().parserTickMin ?? 30) * 60_000) {
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
