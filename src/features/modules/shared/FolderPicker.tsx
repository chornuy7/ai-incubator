import { useEffect, useState } from 'react'
import { FolderOpen, Save, Settings2, Trash2, Pencil, Check, X, Download, FolderPlus, ShieldCheck, Loader2 } from 'lucide-react'
import { Modal, Select, Segmented, EmptyState } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import {
  fetchFolders, createFolder, updateFolder, deleteFolder, validateFolder, type TargetFolder,
} from '@/api/featuresApi'

const cleanTargets = (t: string[]) => [...new Set(t.map((x) => String(x || '').trim().replace(/^@/, '')).filter(Boolean))]

/**
 * Красивый поп-ап «Сохранить список в папку».
 * Переиспользуется: и в FolderPicker, и после парсинга. Умеет создать новую папку
 * или дозаписать цели в существующую (чтобы «собирать большую папку чатов»).
 */
export function SaveToFolderModal({ open, onClose, targets, onSaved }: {
  open: boolean
  onClose: () => void
  targets: string[]
  onSaved?: (folder: TargetFolder) => void
}) {
  const pushToast = useApp((s) => s.pushToast)
  const clean = cleanTargets(targets)
  const [folders, setFolders] = useState<TargetFolder[]>([])
  const [mode, setMode] = useState(0) // 0 — новая папка, 1 — в существующую
  const [name, setName] = useState('')
  const [folderId, setFolderId] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(''); setMode(0)
    void fetchFolders().then((fs) => { setFolders(fs); if (fs[0]) setFolderId(fs[0].id) }).catch(() => {})
  }, [open])

  const canSubmit = clean.length > 0 && (mode === 0 ? !!name.trim() : !!folderId)

  const submit = async () => {
    if (!clean.length) return pushToast({ type: 'error', title: 'Нет целей для сохранения' })
    if (mode === 0 && !name.trim()) return pushToast({ type: 'error', title: 'Введите название папки' })
    if (mode === 1 && !folderId) return pushToast({ type: 'error', title: 'Выберите папку' })
    setSaving(true)
    try {
      let folder: TargetFolder
      if (mode === 1) {
        const cur = folders.find((f) => f.id === folderId)
        const merged = cleanTargets([...(cur?.targets ?? []), ...clean])
        folder = await updateFolder(folderId, { targets: merged })
        pushToast({ type: 'success', title: 'Добавлено в папку', desc: `${cur?.name ?? ''} · теперь ${merged.length} целей` })
      } else {
        folder = await createFolder(name.trim(), clean)
        pushToast({ type: 'success', title: 'Папка сохранена', desc: `${name.trim()} · ${clean.length} целей` })
      }
      onSaved?.(folder)
      onClose()
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка сохранения', desc: e instanceof Error ? e.message : '' })
    } finally { setSaving(false) }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Сохранить в папку"
      subtitle={`${clean.length} ${plural(clean.length, 'цель', 'цели', 'целей')} для повторного использования и валидации`}
      icon={<FolderPlus size={22} />}
      size="sm"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-ghost h-10 text-sm">Отмена</button>
          <button type="button" onClick={submit} disabled={saving || !canSubmit} className="btn-primary h-10 text-sm disabled:opacity-40">
            <Save size={15} /> Сохранить
          </button>
        </>
      }
    >
      {folders.length > 0 && (
        <div className="mb-3"><Segmented options={['Новая папка', 'В существующую']} value={mode} onChange={setMode} size="sm" /></div>
      )}
      {mode === 1 && folders.length > 0 ? (
        <>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Папка</label>
          <Select value={folderId} onChange={setFolderId} options={folders.map((f) => ({ value: f.id, label: `${f.name} (${f.targets.length})` }))} />
          <p className="mt-2 text-xs text-muted">Цели добавятся к папке без дублей — так собирается большая база чатов.</p>
        </>
      ) : (
        <>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Название папки</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
            autoFocus
            placeholder="Напр. Крипто-каналы"
            className="input h-11 w-full"
          />
        </>
      )}
      {clean.length > 0 && (
        <div className="mt-3 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-line bg-elevated/40 p-2.5">
          {clean.slice(0, 40).map((t) => (
            <span key={t} className="rounded-lg border border-line bg-surface px-2 py-0.5 text-xs text-muted">{t}</span>
          ))}
          {clean.length > 40 && <span className="px-1 py-0.5 text-xs text-faint">+{clean.length - 40}</span>}
        </div>
      )}
    </Modal>
  )
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10, m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
  return many
}

/**
 * (5) Управление папками списков целей: загрузить в цели / сохранить / переименовать / удалить.
 * Общий компонент — используется во всех секциях с целями.
 */
export function FolderPicker({ targets, onLoad }: {
  targets: string[]
  onLoad: (targets: string[]) => void
}) {
  const pushToast = useApp((s) => s.pushToast)
  const [folders, setFolders] = useState<TargetFolder[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [manageOpen, setManageOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)

  const reload = async () => {
    try {
      const list = await fetchFolders()
      setFolders(list)
      if (list.length && !list.some((f) => f.id === selectedId)) setSelectedId(list[0].id)
    } catch { /* API offline */ }
  }

  useEffect(() => { void reload() }, [])

  const loadSelected = () => {
    const folder = folders.find((f) => f.id === selectedId)
    if (!folder) return pushToast({ type: 'error', title: 'Папка не выбрана' })
    onLoad(folder.targets)
    pushToast({ type: 'success', title: 'Загружено из папки', desc: `${folder.targets.length} целей` })
  }

  const saveCurrent = () => {
    if (!targets.length) return pushToast({ type: 'error', title: 'Нет целей для сохранения' })
    setSaveOpen(true)
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-elevated/40 p-2.5">
      <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted">
        <FolderOpen size={14} /> Папки
      </span>
      <Select
        className="min-w-[180px]"
        value={selectedId}
        onChange={setSelectedId}
        options={folders.length ? folders.map((f) => ({ value: f.id, label: `${f.name} (${f.targets.length})` })) : [{ value: '', label: 'Нет папок' }]}
      />
      <button type="button" onClick={loadSelected} disabled={!folders.length} className="btn-ghost h-9 text-xs disabled:opacity-40">
        <Download size={14} /> Загрузить
      </button>
      <button type="button" onClick={saveCurrent} className="btn-ghost h-9 text-xs">
        <Save size={14} /> В папку
      </button>
      <button type="button" onClick={() => setManageOpen(true)} className="btn-ghost h-9 text-xs">
        <Settings2 size={14} /> Управление
      </button>

      <SaveToFolderModal open={saveOpen} onClose={() => setSaveOpen(false)} targets={targets} onSaved={() => void reload()} />
      <FolderManageModal open={manageOpen} onClose={() => setManageOpen(false)} folders={folders} onChanged={reload} onLoad={onLoad} />
    </div>
  )
}

function FolderManageModal({ open, onClose, folders, onChanged, onLoad }: {
  open: boolean; onClose: () => void; folders: TargetFolder[]; onChanged: () => Promise<void>
  onLoad: (targets: string[]) => void
}) {
  const pushToast = useApp((s) => s.pushToast)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [validatingId, setValidatingId] = useState<string | null>(null)

  const validate = async (f: TargetFolder) => {
    setValidatingId(f.id)
    try {
      const r = await validateFolder(f.id)
      await onChanged()
      pushToast({ type: 'success', title: 'Папка проверена', desc: `Рабочих: ${r.kept} · удалено мёртвых: ${r.removed} из ${r.checked}` })
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка проверки', desc: e instanceof Error ? e.message : '' })
    } finally { setValidatingId(null) }
  }

  const rename = async (f: TargetFolder) => {
    if (!draftName.trim()) return
    try {
      await updateFolder(f.id, { name: draftName.trim() })
      setEditingId(null)
      await onChanged()
      pushToast({ type: 'success', title: 'Переименовано' })
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' })
    }
  }

  const remove = async (f: TargetFolder) => {
    try {
      await deleteFolder(f.id)
      setConfirmId(null)
      await onChanged()
      pushToast({ type: 'success', title: 'Папка удалена' })
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' })
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Папки списков целей" subtitle="Загрузка, переименование и удаление" icon={<FolderOpen size={22} />} size="lg">
      {folders.length === 0 ? (
        <EmptyState icon={<FolderOpen size={22} />} title="Нет папок" desc="Сохраните текущий список целей в папку кнопкой «В папку»." />
      ) : (
        <ul className="space-y-2">
          {folders.map((f) => (
            <li key={f.id} className="flex items-center gap-2 rounded-xl border border-line bg-elevated/40 p-3">
              {editingId === f.id ? (
                <>
                  <input value={draftName} onChange={(e) => setDraftName(e.target.value)} className="input h-9 flex-1" autoFocus />
                  <button type="button" onClick={() => rename(f)} className="btn-icon h-8 w-8 text-spark-400"><Check size={15} /></button>
                  <button type="button" onClick={() => setEditingId(null)} className="btn-icon h-8 w-8"><X size={15} /></button>
                </>
              ) : confirmId === f.id ? (
                <>
                  <div className="min-w-0 flex-1 text-sm text-rose-300">Удалить папку «{f.name}»?</div>
                  <button type="button" onClick={() => remove(f)} className="btn-danger h-8 px-3 text-xs">Удалить</button>
                  <button type="button" onClick={() => setConfirmId(null)} className="btn-icon h-8 w-8"><X size={15} /></button>
                </>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-fg">{f.name}</div>
                    <div className="text-xs text-muted">{f.targets.length} целей</div>
                  </div>
                  <button type="button" onClick={() => { onLoad(f.targets); pushToast({ type: 'success', title: 'Загружено', desc: `${f.targets.length} целей` }) }} className="btn-icon h-8 w-8" title="Загрузить в цели"><Download size={15} /></button>
                  <button type="button" onClick={() => void validate(f)} disabled={validatingId === f.id || !f.targets.length} className="btn-icon h-8 w-8 text-spark-400 disabled:opacity-40" title="Проверить и удалить мёртвые">{validatingId === f.id ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}</button>
                  <button type="button" onClick={() => { setEditingId(f.id); setDraftName(f.name) }} className="btn-icon h-8 w-8" title="Переименовать"><Pencil size={15} /></button>
                  <button type="button" onClick={() => setConfirmId(f.id)} className="btn-icon h-8 w-8 text-rose-300" title="Удалить"><Trash2 size={15} /></button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
