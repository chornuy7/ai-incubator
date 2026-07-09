import { useEffect, useState } from 'react'
import { FolderOpen, Save, Settings2, Trash2, Pencil, Check, X, Download } from 'lucide-react'
import { Modal, Select, EmptyState } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import {
  fetchFolders, createFolder, updateFolder, deleteFolder, type TargetFolder,
} from '@/api/featuresApi'

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
  const [loading, setLoading] = useState(false)

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

  const saveCurrent = async () => {
    if (!targets.length) return pushToast({ type: 'error', title: 'Нет целей для сохранения' })
    const name = window.prompt('Название папки')
    if (!name?.trim()) return
    setLoading(true)
    try {
      await createFolder(name.trim(), targets)
      await reload()
      pushToast({ type: 'success', title: 'Папка сохранена', desc: name.trim() })
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка сохранения', desc: e instanceof Error ? e.message : '' })
    } finally { setLoading(false) }
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
      <button type="button" onClick={saveCurrent} disabled={loading} className="btn-ghost h-9 text-xs">
        <Save size={14} /> В папку
      </button>
      <button type="button" onClick={() => setManageOpen(true)} className="btn-ghost h-9 text-xs">
        <Settings2 size={14} /> Управление
      </button>

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
    if (!window.confirm(`Удалить папку «${f.name}»?`)) return
    try {
      await deleteFolder(f.id)
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
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-fg">{f.name}</div>
                    <div className="text-xs text-muted">{f.targets.length} целей</div>
                  </div>
                  <button type="button" onClick={() => { onLoad(f.targets); pushToast({ type: 'success', title: 'Загружено', desc: `${f.targets.length} целей` }) }} className="btn-icon h-8 w-8" title="Загрузить в цели"><Download size={15} /></button>
                  <button type="button" onClick={() => { setEditingId(f.id); setDraftName(f.name) }} className="btn-icon h-8 w-8" title="Переименовать"><Pencil size={15} /></button>
                  <button type="button" onClick={() => remove(f)} className="btn-icon h-8 w-8 text-rose-300" title="Удалить"><Trash2 size={15} /></button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
