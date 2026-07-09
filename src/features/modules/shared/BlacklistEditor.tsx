import { useEffect, useState } from 'react'
import { Ban, Plus, X } from 'lucide-react'
import { SectionCard } from './index'
import { useApp } from '@/mocks/store'
import { fetchBlacklist, addBlacklistEntry, removeBlacklistEntry } from '@/api/featuresApi'

/**
 * (10) Редактор чёрного списка целей. Глобальный список исключаемых каналов/групп.
 * Воркеры фильтруют эти цели перед действиями во всех модулях.
 */
export function BlacklistEditor({ title = 'Чёрный список каналов' }: { title?: string }) {
  const pushToast = useApp((s) => s.pushToast)
  const [entries, setEntries] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  const reload = async () => {
    try { setEntries(await fetchBlacklist()) } catch { /* API offline */ }
  }
  useEffect(() => { void reload() }, [])

  const add = async () => {
    const parsed = input.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean)
    if (!parsed.length) return pushToast({ type: 'error', title: 'Пусто', desc: 'Введите @username или ссылку' })
    setLoading(true)
    try {
      const next = await addBlacklistEntry(parsed)
      setEntries(next)
      setInput('')
      pushToast({ type: 'success', title: 'Добавлено в ЧС', desc: `${parsed.length}` })
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' })
    } finally { setLoading(false) }
  }

  const remove = async (entry: string) => {
    try { setEntries(await removeBlacklistEntry(entry)) } catch { /* ignore */ }
  }

  return (
    <SectionCard icon={<Ban size={18} />} title={title} badge={String(entries.length)}>
      <p className="mb-3 text-xs text-muted">Эти цели будут исключены из всех модулей при выборе/обработке (нейрокомментинг, реакции, чаттинг, масслукинг).</p>
      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          className="input resize-none font-mono text-sm"
          placeholder="@channel или https://t.me/channel (по одному на строку)"
        />
        <button type="button" onClick={add} disabled={loading} className="btn-ghost h-auto shrink-0 flex-col px-4"><Plus size={16} /> Добавить</button>
      </div>
      {entries.length > 0 ? (
        <div className="mt-4 flex max-h-52 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-line bg-elevated/40 p-3">
          {entries.map((e) => (
            <span key={e} className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/8 px-2 py-1 text-xs font-medium text-rose-200">
              @{e}
              <button type="button" onClick={() => remove(e)} className="text-rose-300/70 hover:text-rose-200"><X size={12} /></button>
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted">Чёрный список пуст.</p>
      )}
    </SectionCard>
  )
}
