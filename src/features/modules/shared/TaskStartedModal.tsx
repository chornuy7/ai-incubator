import { CheckCircle2, ListChecks, ArrowUpRight, Terminal, Pencil } from 'lucide-react'
import { Modal } from '@/shared/ui'
import type { ModuleTask } from '@/api/modulesApi'

/**
 * Поп-ап после успешного запуска модуля: задача добавлена в Дашборд задач.
 * Оттуда — прогресс, логи по задаче, пауза/стоп/перезапуск (логи снизу в модуле больше не держим).
 */
export function TaskStartedModal({ task, moduleTitle, onClose }: {
  task: ModuleTask | null
  moduleTitle: string
  onClose: () => void
}) {
  if (!task) return null
  const href = `/panel/tasks?task=${encodeURIComponent(task.id)}`
  return (
    <Modal
      open={!!task}
      onClose={onClose}
      size="md"
      title="Задача запущена"
      subtitle={`${moduleTitle} · ${task.id}`}
      icon={<CheckCircle2 size={22} className="text-spark-400" />}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost h-10 text-sm">Остаться здесь</button>
          <a href={href} className="btn-primary h-10 whitespace-nowrap text-sm"><ArrowUpRight size={15} /> В Дашборд задач</a>
        </div>
      }
    >
      <p className="text-sm text-muted">
        Задача добавлена в работу и появилась в <b className="text-fg">Дашборде задач</b>. Там по каждой задаче доступны:
      </p>
      <ul className="mt-3 space-y-2 text-sm text-fg">
        <li className="flex items-center gap-2"><ListChecks size={15} className="text-spark-400" /> прогресс и статус в реальном времени</li>
        <li className="flex items-center gap-2"><Terminal size={15} className="text-spark-400" /> логи по этому модулю (теперь только там)</li>
        <li className="flex items-center gap-2"><Pencil size={15} className="text-spark-400" /> управление: пауза, стоп, перезапуск</li>
      </ul>
    </Modal>
  )
}
