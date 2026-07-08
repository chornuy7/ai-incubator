import { useCallback, useEffect, useState } from 'react'
import { useApp } from '@/mocks/store'
import {
  startModuleTask,
  fetchModuleTask,
  fetchModuleTasks,
  stopModuleTask,
  saveModulePreset,
  fetchModulePresets,
  type ModuleTask,
  type ModuleTaskSettings,
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
  const [presets, setPresets] = useState<{ id: string; name: string }[]>([])

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
    void fetchModulePresets(moduleKey).then((p) => setPresets(p.map((x) => ({ id: x.id, name: x.name })))).catch(() => {})
  }, [moduleKey])

  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      setRestoring(true)
      try {
        const tasks = await fetchModuleTasks(moduleKey)
        const id = pickTaskIdToRestore(tasks, readActiveTaskId(moduleKey))
        if (!id || cancelled) return
        const t = await fetchModuleTask(moduleKey, id)
        if (cancelled) return
        setTaskId(t.id)
        setTask(t)
        persistActiveTaskId(moduleKey, t.id)
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
      const t = await startModuleTask(moduleKey, settings)
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
      pushToast({ type: 'success', title: 'Задача запущена', desc: t.id })
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

  const savePreset = useCallback(async (name: string, settings: ModuleTaskSettings) => {
    await saveModulePreset(moduleKey, name, settings)
    const p = await fetchModulePresets(moduleKey)
    setPresets(p.map((x) => ({ id: x.id, name: x.name })))
    pushToast({ type: 'success', title: 'Пресет сохранён', desc: name })
  }, [moduleKey, pushToast])

  return { task, taskId, running, starting, restoring, start, stop, savePreset, presets, pushToast, guardNet }
}
