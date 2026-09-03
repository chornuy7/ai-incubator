import { useEffect, useMemo, useState } from 'react'
import { Bookmark, Save } from 'lucide-react'
import { Modal, Select } from '@/shared/ui'
import { useSession } from '@/features/auth/session'
import { fetchUsers, type User } from '@/api/usersApi'
import type { ModuleTaskSettings, ModulePresetSettings } from '@/api/modulesApi'

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

/**
 * MR-195: что из текущих настроек уходит в шаблон.
 *
 * Галочка снята — ключ `accountIds` убираем СОВСЕМ, а не подставляем пустой массив:
 * применение такого шаблона не должно трогать уже выбранные аккаунты, а `[]` как раз
 * снял бы выбор. Отсутствие ключа применение и так пропускает.
 */
export function presetSettings(s: ModuleTaskSettings, withAccounts: boolean): ModulePresetSettings {
  if (withAccounts) return s
  const rest: ModulePresetSettings = { ...s }
  delete rest.accountIds
  return rest
}

export function SavePresetModal({ open, onClose, onSave }: {
  open: boolean
  onClose: () => void
  onSave: (name: string, color: string, owner: string, withAccounts: boolean) => void | Promise<void>
}) {
  // §7 (MR-107 · TPL-001): владелец шаблона — выбор ТОЛЬКО среди подключённых пользователей,
  // по умолчанию текущий пользователь (а не свободный ввод имени).
  const me = useSession((s) => s.user)
  const [users, setUsers] = useState<User[]>([])
  const [name, setName] = useState('')
  const [color, setColor] = useState(PRESET_COLORS[0].key)
  const [owner, setOwner] = useState('')
  // MR-195: аккаунты — возможность, а не поведение по умолчанию (созвон 27.08:
  // «высокая вероятность, что чаще нужны будут шаблоны без аккаунтов»). Поэтому
  // галочка СНЯТА при каждом открытии, а не запоминается с прошлого раза.
  const [withAccounts, setWithAccounts] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(''); setColor(PRESET_COLORS[0].key); setOwner(me?.name ?? ''); setWithAccounts(false)
    void fetchUsers().then(setUsers).catch(() => setUsers([]))
  }, [open, me])

  const ownerOptions = useMemo(() => {
    const names: string[] = []
    if (me?.name) names.push(me.name)
    for (const u of users) if (u.name && !names.includes(u.name)) names.push(u.name)
    return names.map((n) => ({ value: n, label: n === me?.name ? `${n} (вы)` : n }))
  }, [users, me])

  const submit = async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    try {
      await onSave(name.trim(), color, owner.trim(), withAccounts)
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

      <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-elevated/40 p-3">
        <input type="checkbox" checked={withAccounts} onChange={(e) => setWithAccounts(e.target.checked)} className="mt-0.5 h-4 w-4 accent-spark" />
        <span>
          <span className="text-sm font-semibold">Сохранить вместе с аккаунтами</span>
          {/* Поясняем только состояние ПО УМОЛЧАНИЮ. Что делает поставленная галочка,
              уже сказано её собственной подписью — повторять это второй раз незачем. */}
          <span className="mt-0.5 block text-xs text-muted">По умолчанию шаблон сохраняет только настройки; выбор аккаунтов в него не входит.</span>
        </span>
      </label>

      <label className="mb-1.5 mt-4 block text-xs font-semibold uppercase tracking-wide text-muted">Владелец <span className="normal-case text-faint">(персональный шаблон)</span></label>
      <Select value={owner} onChange={setOwner} options={ownerOptions} placeholder="Выберите пользователя" />
      <p className="mt-2 text-xs text-muted">Выбор только среди подключённых пользователей; по умолчанию — вы. Метка и владелец помогают быстро найти шаблон в списке.</p>
    </Modal>
  )
}
