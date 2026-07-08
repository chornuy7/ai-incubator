import { useEffect, useState } from 'react'
import { Star, Sparkles, Check, RotateCcw, Pencil } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { Modal } from '@/shared/ui'
import { DEFAULT_PROMPT_BODIES, loadPromptBodies, savePromptBodies } from './promptDefaults'

interface PromptCardsProps {
  moduleKey: string
  labels: string[]
  activeIndex: number
  onActiveChange: (index: number) => void
  onBodiesChange?: (bodies: string[]) => void
}

export function PromptCards({ moduleKey, labels, activeIndex, onActiveChange, onBodiesChange }: PromptCardsProps) {
  const [bodies, setBodies] = useState(() => loadPromptBodies(moduleKey, labels))
  const [modalIndex, setModalIndex] = useState<number | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    setBodies(loadPromptBodies(moduleKey, labels))
  }, [moduleKey, labels.length])

  useEffect(() => {
    onBodiesChange?.(bodies)
  }, [bodies, onBodiesChange])

  const isCustom = (i: number) =>
    (bodies[i] ?? '') !== (DEFAULT_PROMPT_BODIES[i] ?? DEFAULT_PROMPT_BODIES[0])

  const openModal = (i: number) => {
    setModalIndex(i)
    setDraft(bodies[i] ?? '')
  }

  const selectPrompt = (i: number) => onActiveChange(i)

  const closeModal = () => setModalIndex(null)

  const saveEdit = () => {
    if (modalIndex === null) return
    const next = [...bodies]
    next[modalIndex] = draft.trim() || DEFAULT_PROMPT_BODIES[modalIndex] || DEFAULT_PROMPT_BODIES[0]
    setBodies(next)
    savePromptBodies(moduleKey, next)
    closeModal()
  }

  const resetEdit = () => {
    if (modalIndex === null) return
    const def = DEFAULT_PROMPT_BODIES[modalIndex] ?? DEFAULT_PROMPT_BODIES[0]
    setDraft(def)
  }

  const activeBody = bodies[activeIndex] ?? ''

  return (
    <>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {labels.map((label, i) => (
            <div
              key={label}
              className={cn(
                'relative rounded-xl border transition-all',
                i === activeIndex
                  ? 'border-spark-500/60 bg-spark-500/8 ring-1 ring-spark-500/30'
                  : 'border-line bg-elevated',
              )}
            >
              <button
                type="button"
                onClick={() => selectPrompt(i)}
                className={cn(
                  'w-full rounded-xl p-3 pb-9 text-left text-sm font-semibold transition-all',
                  i === activeIndex ? 'text-fg' : 'text-muted hover:text-fg',
                )}
              >
                {i === activeIndex && (
                  <Star size={12} className="absolute right-2 top-2 text-amber-400" fill="currentColor" />
                )}
                {isCustom(i) && i !== activeIndex && (
                  <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-iris-400" title="Изменён" />
                )}
                {label}
              </button>
              <button
                type="button"
                onClick={() => openModal(i)}
                className="btn-icon absolute bottom-2 right-2 h-7 w-7 text-muted hover:text-fg"
                title="Редактировать промпт"
                aria-label={`Редактировать: ${label}`}
              >
                <Pencil size={13} />
              </button>
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-line bg-elevated/40 px-4 py-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wide text-muted">Активный промпт</span>
            {isCustom(activeIndex) && (
              <span className="rounded bg-iris-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-iris-300">
                изменён
              </span>
            )}
          </div>
          <p className="text-sm font-semibold text-fg">{labels[activeIndex]}</p>
          <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted">{activeBody}</p>
        </div>
      </div>

      <Modal
        open={modalIndex !== null}
        onClose={closeModal}
        title={modalIndex !== null ? labels[modalIndex] : undefined}
        subtitle="Системный промпт для генерации AI"
        icon={<Sparkles size={22} />}
        size="lg"
        footer={
          <>
            <button type="button" onClick={resetEdit} className="btn-ghost h-10 text-sm">
              <RotateCcw size={15} /> Сбросить
            </button>
            <button type="button" onClick={closeModal} className="btn-ghost h-10 text-sm">
              Отмена
            </button>
            <button type="button" onClick={saveEdit} className="btn-primary h-10 text-sm">
              <Check size={15} /> Сохранить
            </button>
          </>
        }
      >
        {modalIndex !== null && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              Этот текст уходит в AI как инструкция. Нажмите «Сохранить» — промпт станет активным для модуля.
            </p>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={8}
              className="input min-h-[180px] resize-y font-mono text-sm leading-relaxed"
              placeholder="Системный промпт для AI…"
              autoFocus
            />
            <div className="rounded-xl border border-line bg-elevated/50 px-3 py-2 text-xs text-muted">
              <span className="font-semibold text-fg">По умолчанию: </span>
              {DEFAULT_PROMPT_BODIES[modalIndex] ?? DEFAULT_PROMPT_BODIES[0]}
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}

export function usePromptBodies(moduleKey: string, labels: string[]) {
  const [bodies, setBodies] = useState(() => loadPromptBodies(moduleKey, labels))
  return { bodies, setBodies }
}
