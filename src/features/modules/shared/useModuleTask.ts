import { useCallback, useEffect, useState } from 'react'
import { useApp } from '@/mocks/store'
import { launchWithSkip } from './launchWithSkip'
import {
  startModuleTask,
  fetchModuleTask,
  fetchModuleTasks,
  stopModuleTask,
  saveModulePreset,
  fetchModulePresets,
  deleteModulePreset,
  type ModuleTask,
  type ModuleTaskSettings,
  type ModulePreset,
} from '@/api/modulesApi'
import { persistActiveTaskId, readActiveTaskId, pickTaskIdToRestore, mapTaskStatus } from './activeTaskStorage'

export function useModuleTask(moduleKey: string) {
  const addTask = useApp((s) => s.addTask)
  const updateTask = useApp((s) => s.updateTask)
  const pushToast = useApp((s) => s.pushToast)
  const guardNet = useApp((s) => s.guardNet)
  const loadAccounts = useApp((s) => s.loadAccounts)
  const loadAccountBusy = useApp((s) => s.loadAccountBusy)

  const [taskId, setTaskId] = useState<string | null>(null)
  const [task, setTask] = useState<ModuleTask | null>(null)
  const [starting, setStarting] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [presets, setPresets] = useState<ModulePreset[]>([])
  const [justStarted, setJustStarted] = useState<ModuleTask | null>(null) // для поп-апа «задача запущена»

  const running = task?.status === 'running' || task?.status === 'queued'

  const syncBackgroundTask = useCallback((t: ModuleTask) => {
    const done = t.progress.actionsDone ?? t.progress.commentsSent ?? 0
    const total = t.progress.total || 1
    const patch = {
      status: mapTaskStatus(t.status),
      progress: Math.round((done / total) * 100),
      logCount: t.logs.length,
    }
    const exists = useApp.getState().data.tasks.some((x) => x.id === t.id)
    if (exists) updateTask(t.id, patch)
    else {
      addTask({
        id: t.id,
        module: moduleKey,
        title: `${moduleKey} · ${t.settings.accountIds?.length ?? 0} акк.`,
        accountsCount: t.settings.accountIds?.length ?? 0,
        ...patch,
      })
    }
  }, [moduleKey, addTask, updateTask])

  useEffect(() => {
    void fetchModulePresets(moduleKey).then(setPresets).catch(() => {})
  }, [moduleKey])

  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      setRestoring(true)
      try {
        const tasks = await fetchModuleTasks(moduleKey)
        if (cancelled || !tasks.length) return
        // 1) активная задача текущей вкладки (running/queued);
        // 2) иначе — последняя задача модуля, чтобы её логи не пропадали после обновления страницы.
        const id = pickTaskIdToRestore(tasks, readActiveTaskId(moduleKey)) ?? tasks[0].id
        const t = await fetchModuleTask(moduleKey, id)
        if (cancelled) return
        setTaskId(t.id)
        setTask(t)
        if (t.status === 'running' || t.status === 'queued') persistActiveTaskId(moduleKey, t.id)
        syncBackgroundTask(t)
      } catch { /* API недоступен или задач нет */ }
      finally {
        if (!cancelled) setRestoring(false)
      }
    }
    void restore()
    return () => { cancelled = true }
  }, [moduleKey, syncBackgroundTask])

  useEffect(() => {
    if (!taskId || !running) return
    const poll = async () => {
      try {
        const t = await fetchModuleTask(moduleKey, taskId)
        setTask(t)
        syncBackgroundTask(t)
        if (t.status !== 'running' && t.status !== 'queued') {
          persistActiveTaskId(moduleKey, null)
          void loadAccounts()
          void loadAccountBusy()
        }
      } catch { /* ignore */ }
    }
    poll()
    const id = setInterval(poll, 2500)
    return () => clearInterval(id)
  }, [taskId, running, moduleKey, syncBackgroundTask, loadAccounts, loadAccountBusy])

  const start = useCallback(async (settings: ModuleTaskSettings, title: string) => {
    if (!guardNet(`запуск ${moduleKey}`)) return false
    setStarting(true)
    try {
      // Часть аккаунтов в карантине/спамблоке — не валим запуск, а предлагаем без них:
      // при трёх десятках профилей кто-то в блоке почти всегда.
      const t = await launchWithSkip((skip) => startModuleTask(moduleKey, settings, skip))
      if (!t) return false
      // §4.4 (D4): риск волнового бана показываем сразу после запуска. Не блокируем —
      // решение за оператором, — но молчать об этом нельзя: Telegram банит группами,
      // и узнать о паттерне постфактум означает потерять сразу несколько профилей.
      for (const w of (t as { clusterWarnings?: string[] }).clusterWarnings || []) {
        pushToast({ type: 'error', title: 'Риск блокировки группой', desc: w })
      }
      setTaskId(t.id)
      setTask(t)
      persistActiveTaskId(moduleKey, t.id)
      addTask({
        id: t.id,
        module: moduleKey,
        title,
        status: 'running',
        progress: 0,
        accountsCount: settings.accountIds.length,
        logCount: 0,
      })
      setJustStarted(t) // показать поп-ап со ссылкой в Дашборд задач (там прогресс/логи/управление)
      void loadAccountBusy()
      return true
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка запуска', desc: e instanceof Error ? e.message : '' })
      return false
    } finally {
      setStarting(false)
    }
  }, [moduleKey, addTask, pushToast, guardNet])

  const stop = useCallback(async () => {
    if (!taskId) return
    try {
      const t = await stopModuleTask(moduleKey, taskId)
      setTask(t)
      syncBackgroundTask(t)
      pushToast({ type: 'info', title: 'Остановка…' })
      void loadAccounts()
      void loadAccountBusy()
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' })
    }
  }, [taskId, moduleKey, syncBackgroundTask, pushToast, loadAccounts, loadAccountBusy])

  const savePreset = useCallback(async (name: string, settings: ModuleTaskSettings, color?: string, owner?: string) => {
    await saveModulePreset(moduleKey, name, settings, color, owner)
    const p = await fetchModulePresets(moduleKey)
    setPresets(p)
    pushToast({ type: 'success', title: 'Пресет сохранён', desc: owner ? `${name} · ${owner}` : name })
  }, [moduleKey, pushToast])

  const deletePreset = useCallback(async (id: string) => {
    // Оптимистично убираем из списка, откатываем при ошибке.
    const prev = presets
    setPresets((list) => list.filter((p) => p.id !== id))
    try {
      await deleteModulePreset(moduleKey, id)
    } catch (e) {
      setPresets(prev)
      pushToast({ type: 'error', title: 'Не удалён', desc: e instanceof Error ? e.message : '' })
    }
  }, [moduleKey, presets, pushToast])

  return { task, taskId, running, starting, restoring, start, stop, savePreset, deletePreset, presets, pushToast, guardNet, justStarted, dismissJustStarted: () => setJustStarted(null) }
}
