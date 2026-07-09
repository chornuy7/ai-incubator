import { useEffect, useState } from 'react'
import { Globe2, Check, RotateCcw, Sparkles } from 'lucide-react'
import { Modal } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import { fetchAiSettings, saveAiSettings } from '@/api/featuresApi'

/**
 * (6) Глобальный системный промпт для ИИ. Применяется ко ВСЕЙ генерации во всех модулях.
 * На бэкенде он объединяется с промптом карточки (resolveSystemPrompt).
 */
export function GlobalPromptEditor() {
  const pushToast = useApp((s) => s.pushToast)
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)

  const reload = async () => {
    try {
      const s = await fetchAiSettings()
      setPrompt(s.globalSystemPrompt || '')
    } catch { /* API offline */ }
  }
  useEffect(() => { void reload() }, [])

  const openModal = () => { setDraft(prompt); setOpen(true) }

  const save = async () => {
    setLoading(true)
    try {
      const s = await saveAiSettings({ globalSystemPrompt: draft })
      setPrompt(s.globalSystemPrompt || '')
      setOpen(false)
      pushToast({ type: 'success', title: 'Глобальный промпт сохранён' })
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' })
    } finally { setLoading(false) }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 rounded-xl border border-iris-500/30 bg-iris-500/8 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <Globe2 size={16} className="shrink-0 text-iris-300" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-fg">Глобальный системный промпт</div>
            <div className="truncate text-xs text-muted">{prompt ? prompt.slice(0, 80) : 'Не задан — применяется только промпт карточки'}</div>
          </div>
        </div>
        <button type="button" onClick={openModal} className="btn-ghost h-9 shrink-0 text-xs">Редактировать</button>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Глобальный системный промпт"
        subtitle="Добавляется ко всем генерациям ИИ во всех модулях"
        icon={<Sparkles size={22} />}
        size="lg"
        footer={
          <>
            <button type="button" onClick={() => setDraft('')} className="btn-ghost h-10 text-sm"><RotateCcw size={15} /> Очистить</button>
            <button type="button" onClick={() => setOpen(false)} className="btn-ghost h-10 text-sm">Отмена</button>
            <button type="button" onClick={save} disabled={loading} className="btn-primary h-10 text-sm"><Check size={15} /> Сохранить</button>
          </>
        }
      >
        <p className="mb-3 text-sm text-muted">Этот текст добавляется перед промптом каждой карточки. Например: правила бренда, язык, тон, запреты.</p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={8}
          className="input min-h-[180px] resize-y font-mono text-sm leading-relaxed"
          placeholder="Например: Всегда пиши на русском, без эмодзи, вежливо, не упоминай конкурентов…"
          autoFocus
        />
      </Modal>
    </>
  )
}
