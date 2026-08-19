/**
 * Переживание перезапуска: задачи не должны умирать от деплоя.
 *
 * Воркеры живут в памяти процесса, поэтому раньше любой рестарт API убивал ВСЕ активные
 * задачи: `reconcileStaleTasksOnBoot` помечал их `stopped`, и оператору оставалось
 * поднимать каждую руками. На одном пользователе это раздражает, на тысяче — авария при
 * каждой выкатке.
 *
 * Механика намеренно опирается на уже проверенную пару «пауза → возобновление»:
 * прогресс, `actionKeys` и курсор парсеров и так лежат на диске, а `resumeModuleTask`
 * умеет перезахватить локи и продолжить с места. Нам нужно лишь пометить задачи, которые
 * прервал не человек, а рестарт, и поднять их на старте.
 *
 * Два пути в систему:
 *  - штатный деплой — `markRunningTasksForResume()` по SIGTERM: помечаем и просим воркеры
 *    выйти по паузе, то есть по-хорошему, дописав текущее действие;
 *  - падение процесса (kill -9, OOM, сбой хоста) — задачи остались в статусе `running`,
 *    их подхватывает `reconcileStaleTasksOnBoot`, помечая тем же флагом.
 */

/**
 * Сколько раз задачу можно поднять автоматически. Защита от петли: если задача роняет
 * процесс, без потолка мы будем перезапускать её вечно и падать снова и снова.
 */
export const MAX_BOOT_RESUMES = 3

/**
 * Сколько действий задача успела сделать. Разные модули пишут прогресс по-разному
 * (`done` у большинства, `actionsDone` у прогрева, `collected` у парсеров), поэтому
 * берём максимум из известных счётчиков — нам нужен факт «сдвинулась», а не точное число.
 */
export function progressDone(task) {
  const p = task?.progress || {}
  return Math.max(
    Number(p.done) || 0,
    Number(p.actionsDone) || 0,
    Number(p.collected) || 0,
    Number(task?.progressDone) || 0,
  )
}

/**
 * Пометить активные задачи как прерванные рестартом и мягко остановить воркеры.
 * Вызывается по сигналу завершения — до того, как процесс умрёт.
 *
 * @returns {Promise<string[]>} id помеченных задач
 */
export async function markRunningTasksForResume() {
  const marked = []
  const { listModuleKeys, getModuleStore } = await import('../modules/registry.js')
  const { pauseWorker } = await import('../modules/workers.js')

  for (const key of listModuleKeys()) {
    const store = getModuleStore(key)
    if (!store) continue
    let tasks = []
    try { tasks = await store.listTasks() } catch { continue }
    for (const t of tasks) {
      if (t.status !== 'running' && t.status !== 'queued') continue
      const full = await store.loadTask(t.id).catch(() => null)
      if (!full) continue
      full.resumeOnBoot = true
      full.interruptedAt = Date.now()
      // control-сейв: флаги останова читаются с диска, и обычная запись их бы затёрла.
      await store.saveTask(full, { control: true })
      // Пауза, а не стоп: пауза сохраняет прогресс и не освобождает аккаунты насовсем,
      // и ровно её умеет отменять `resumeModuleTask`.
      try { await pauseWorker(t.id, store) } catch { /* воркера может уже не быть */ }
      marked.push(t.id)
    }
  }
  return marked
}

/**
 * Поднять задачи, прерванные рестартом. Вызывается на старте, ПОСЛЕ согласования локов.
 *
 * Задачи, остановленные человеком, сюда не попадают: флаг ставится только тем, кого
 * прервал процесс. Запуск идёт через обычный `resumeModuleTask`, поэтому действуют те же
 * проверки, что и при нажатии «Возобновить» руками: просроченная цель, занятые аккаунты,
 * предстартовый преflight. Ограничение параллельности тоже общее — лишние задачи
 * встанут в очередь, а не ударят по Telegram все разом.
 *
 * @returns {Promise<{ resumed: string[], skipped: {id: string, reason: string}[] }>}
 */
export async function resumeMarkedTasks() {
  const resumed = []
  const skipped = []
  const { listModuleKeys, getModuleStore, resumeModuleTask } = await import('../modules/registry.js')

  for (const key of listModuleKeys()) {
    const store = getModuleStore(key)
    if (!store) continue
    let tasks = []
    try { tasks = await store.listTasks() } catch { continue }
    for (const t of tasks) {
      const full = await store.loadTask(t.id).catch(() => null)
      if (!full?.resumeOnBoot) continue

      // Счётчик подъёмов считает ПЕТЛИ, а не деплои. Если с прошлого восстановления
      // задача успела что-то сделать, значит она живая, а прервал её очередной рестарт —
      // и счётчик обнуляется. Без этого при нескольких выкатках в день любая длинная
      // задача умирала на третьей: ровно то, что случилось с прогревом wm_b7f289f9
      // 18.08 (три деплоя подряд подняли её, четвёртый — остановил на 7/30).
      const doneNow = progressDone(full)
      // Обнуляем только при ДОКАЗАННОМ движении: если отметки с прошлого подъёма нет,
      // сравнивать не с чем — считаем, что прогресса не было. Иначе задача без счётчика
      // прогресса сбрасывала бы лимит на каждом старте и петля стала бы вечной.
      const baseline = full.bootResumeProgress
      const moved = baseline !== undefined && baseline !== null && doneNow > Number(baseline)
      const attempts = moved ? 0 : Number(full.bootResumes || 0)
      if (attempts >= MAX_BOOT_RESUMES) {
        // Петля: задача поднимается и снова прерывается. Дальше — только руками,
        // иначе каждый старт будет воскрешать то, что стабильно роняет процесс.
        full.resumeOnBoot = false
        full.status = 'stopped'
        full.stopRequested = true
        await store.saveTask(full, { control: true })
        await store.appendLog(full, 'warning',
          `Автовосстановление отключено: задача прерывалась ${attempts} раза подряд. Запустите вручную, если это ожидаемо.`)
        skipped.push({ id: t.id, reason: 'превышен лимит автоподъёмов' })
        continue
      }

      full.resumeOnBoot = false
      full.bootResumes = attempts + 1
      full.bootResumeProgress = doneNow
      await store.saveTask(full, { control: true })

      try {
        await resumeModuleTask(key, t.id)
        await store.appendLog(await store.loadTask(t.id) || full, 'info',
          'Задача восстановлена после перезапуска сервиса — продолжаем с места остановки')
        resumed.push(t.id)
      } catch (err) {
        // Не смогли поднять (цель просрочена, аккаунты заняты) — это НЕ повод молчать:
        // иначе задача останется на паузе без объяснения, и это спишут на «всё слетело».
        const reason = err instanceof Error ? err.message : 'не удалось возобновить'
        await store.appendLog(full, 'warning', `Не удалось восстановить после перезапуска: ${reason}`)
        skipped.push({ id: t.id, reason })
      }
    }
  }
  return { resumed, skipped }
}
