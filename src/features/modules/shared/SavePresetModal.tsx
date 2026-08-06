import { useEffect, useState } from 'react'
import { Bookmark, Save } from 'lucide-react'
import { Modal } from '@/shared/ui'

// §7: шаблон модуля = быстрый конфиг с цветовой меткой и «владельцем» (персональные — Маша/Паша).
// Палитра меток — фиксированный набор, чтобы шаблоны визуально различались в списке.
export const PRESET_COLORS: { key: string; hex: string; label: string }[] = [
  { key: 'spark', hex: '#0ec464', label: 'Зелёный' },
  { key: 'iris', hex: '#7145ff', label: 'Фиолетовый' },
  { key: 'sky', hex: '#06b6d4', label: 'Голубой' },
  { key: 'amber', hex: '#f59e0b', label: 'Янтарный' },
  { key: 'rose', hex: '#f43f5e', label: 'Розовый' },
  { key: 'slate', hex: '#94a1b8', label: 'Серый' },
]

export function presetHex(color?: string): string {
  return PRESET_COLORS.find((c) => c.key === color)?.hex ?? PRESET_COLORS[0].hex
}

export function SavePresetModal({ open, onClose, onSave }: {
  open: boolean
  onClose: () => void
  onSave: (name: string, color: string, owner: string) => void | Promise<void>
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState(PRESET_COLORS[0].key)
  const [owner, setOwner] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(''); setColor(PRESET_COLORS[0].key); setOwner('')
  }, [open])

  const submit = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      await onSave(name.trim(), color, owner.trim())
      onClose()
    } finally { setSaving(false) }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Сохранить шаблон"
      subtitle="Быстрый конфиг настроек: цветовая метка и владелец для персональных шаблонов"
      icon={<Bookmark size={22} />}
      size="sm"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-ghost h-10 text-sm">Отмена</button>
          <button type="button" onClick={submit} disabled={saving || !name.trim()} className="btn-primary h-10 text-sm disabled:opacity-40">
            <Save size={15} /> Сохранить
          </button>
        </>
      }
    >
      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Название</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
        autoFocus
        placeholder="Напр. Крипто · агрессивный"
        className="input h-11 w-full"
      />

      <label className="mb-1.5 mt-4 block text-xs font-semibold uppercase tracking-wide text-muted">Цветовая метка</label>
      <div className="flex flex-wrap gap-2">
        {PRESET_COLORS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setColor(c.key)}
            title={c.label}
            className={`grid h-9 w-9 place-items-center rounded-xl border-2 transition-all ${color === c.key ? 'border-fg scale-105' : 'border-transparent opacity-70 hover:opacity-100'}`}
            style={{ background: `${c.hex}22` }}
          >
            <span className="h-4 w-4 rounded-full" style={{ background: c.hex }} />
          </button>
        ))}
      </div>

      <label className="mb-1.5 mt-4 block text-xs font-semibold uppercase tracking-wide text-muted">Владелец <span className="normal-case text-faint">(опционально — персональный шаблон)</span></label>
      <input
        value={owner}
        onChange={(e) => setOwner(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
        placeholder="Напр. Маша, Паша…"
        className="input h-11 w-full"
      />
      <p className="mt-2 text-xs text-muted">Метка и владелец помогают быстро найти нужный шаблон в списке.</p>
    </Modal>
  )
}
