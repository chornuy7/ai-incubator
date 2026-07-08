import { Plus, Trash2, ListChecks, X } from 'lucide-react'
import { Segmented } from '@/shared/ui'

export function TargetsEditor({ tabs, tab, onTab, input, onInput, targets, onAdd, onClear, onRemove, placeholder }: {
  tabs?: string[]; tab: number; onTab: (n: number) => void
  input: string; onInput: (v: string) => void
  targets: string[]; onAdd: () => void; onClear: () => void; onRemove: (t: string) => void
  placeholder?: string
}) {
  return (
    <>
      {tabs && tabs.length > 1 && <Segmented className="mb-3" size="sm" options={tabs} value={tab} onChange={onTab} />}
      <p className="mb-2 text-xs text-muted">Если аккаунта нет в чате/группе — вступит автоматически (@username или t.me/+invite).</p>
      {tab === 0 && (
        <>
          <div className="flex gap-2">
            <textarea value={input} onChange={(e) => onInput(e.target.value)} rows={3} className="input resize-none font-mono text-sm" placeholder={placeholder} />
            <button type="button" onClick={onAdd} className="btn-ghost h-auto shrink-0 flex-col px-4"><Plus size={16} /> Добавить</button>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted"><ListChecks size={13} /> Строк: {input.split('\n').filter((l) => l.trim()).length}</div>
        </>
      )}
      {targets.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-bold text-fg">{targets.length} целей</span>
            <button type="button" onClick={onClear} className="flex items-center gap-1 text-xs font-semibold text-rose-300 hover:underline"><Trash2 size={13} /> Очистить</button>
          </div>
          <div className="flex max-h-52 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-line bg-elevated/40 p-3">
            {targets.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-xs font-medium text-fg">
                @{t}
                <button type="button" onClick={() => onRemove(t)} className="text-faint hover:text-rose-300"><X size={12} /></button>
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
