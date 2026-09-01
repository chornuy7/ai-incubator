import { useEffect, useState } from 'react'
import { FolderOpen, Save, Trash2, Pencil, Check, X, FolderPlus, ShieldCheck, Loader2, ListTree, Plus } from 'lucide-react'
import { Modal, Select, Segmented, EmptyState } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import {
  fetchFolders, createFolder, updateFolder, deleteFolder, validateFolder, type TargetFolder,
} from '@/api/featuresApi'
import { useSession, type SessionUser } from '@/features/auth/session'
import { confirmDialog } from '@/shared/lib/dialog'
import { cn } from '@/shared/lib/utils'

const cleanTargets = (t: string[]) => [...new Set(t.map((x) => String(x || '').trim().replace(/^@/, '')).filter(Boolean))]

/** Группы, доступные текущему пользователю (§8.1): админ — все; роль без выданных групп — все;
 *  иначе только те, что админ выдал роли (permissions.resources.folders = allow). */
function visibleFolders(folders: TargetFolder[], user: SessionUser | null): TargetFolder[] {
  if (!user || user.isAdmin) return folders
  const fp = user.permissions?.resources?.folders
  if (!fp || Object.keys(fp).length === 0) return folders
  return folders.filter((f) => fp[f.id] === 'allow')
}

const ntTarget = (t: string) => String(t || '').trim().replace(/^@/, '').toLowerCase()

/** Каналы группы, доступные пользователю (§8.1): админ/без ограничений — все; иначе только
 *  выданное подмножество (permissions.resources.folderChannels[folderId]). Пусто = все. */
function allowedTargets(f: TargetFolder, user: SessionUser | null): string[] {
  if (!user || user.isAdmin) return f.targets
  const fp = user.permissions?.resources?.folders
  if (!fp || Object.keys(fp).length === 0) return f.targets
  if (fp[f.id] !== 'allow') return []
  const fc = user.permissions?.resources?.folderChannels?.[f.id]
  if (!Array.isArray(fc) || fc.length === 0) return f.targets
  const allow = new Set(fc.map(ntTarget))
  return f.targets.filter((t) => allow.has(ntTarget(t)))
}

/**
 * Красивый поп-ап «Сохранить список в группу».
 * Переиспользуется: и в FolderPicker, и после парсинга. Умеет создать новую группу
 * или дозаписать группы в существующую (чтобы «собирать большую группу чатов»).
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
  const [mode, setMode] = useState(0) // 0 — новая группа, 1 — в существующую
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
    if (!clean.length) return pushToast({ type: 'error', title: 'Нет групп для сохранения' })
    if (mode === 0 && !name.trim()) return pushToast({ type: 'error', title: 'Введите название группы' })
    if (mode === 1 && !folderId) return pushToast({ type: 'error', title: 'Выберите группу' })
    setSaving(true)
    try {
      let folder: TargetFolder
      if (mode === 1) {
        const cur = folders.find((f) => f.id === folderId)
        const merged = cleanTargets([...(cur?.targets ?? []), ...clean])
        folder = await updateFolder(folderId, { targets: merged })
        pushToast({ type: 'success', title: 'Добавлено в группу', desc: `${cur?.name ?? ''} · теперь ${merged.length} групп` })
      } else {
        folder = await createFolder(name.trim(), clean)
        pushToast({ type: 'success', title: 'Группа сохранена', desc: `${name.trim()} · ${clean.length} групп` })
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
      title="Сохранить в группу"
      subtitle={`${clean.length} ${plural(clean.length, 'группа', 'группы', 'групп')} для повторного использования и валидации`}
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
        <div className="mb-3"><Segmented options={['Новая группа', 'В существующую']} value={mode} onChange={setMode} size="sm" /></div>
      )}
      {mode === 1 && folders.length > 0 ? (
        <>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Группа</label>
          <Select value={folderId} onChange={setFolderId} options={folders.map((f) => ({ value: f.id, label: `${f.name} (${f.targets.length})` }))} />
          <p className="mt-2 text-xs text-muted">Группы добавятся к группе без дублей — так собирается большая база чатов.</p>
        </>
      ) : (
        <>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Название группы</label>
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
 * (5) Управление группами списков групп: загрузить в группы / сохранить / переименовать / удалить.
 * Общий компонент — используется во всех секциях с группами.
 */
export function FolderPicker({ targets, onLoad }: {
  targets: string[]
  onLoad: (targets: string[]) => void
}) {
  const pushToast = useApp((s) => s.pushToast)
  const user = useSession((s) => s.user)
  const [folders, setFolders] = useState<TargetFolder[]>([])
  const [manageOpen, setManageOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)

  const reload = async () => {
    try { setFolders(await fetchFolders()) } catch { /* API offline */ }
  }
  useEffect(() => { void reload() }, [])

  const visible = visibleFolders(folders, user)
  /*
   * Права на группу разложены ровно так, как их проверяет сервер (`featureRoutes.js`), —
   * иначе кнопка есть, а нажатие даёт 403.
   *
   * Переименование и удаление — админ платформы (§8.1, гейт стоит с 22.07). Правка СОСТАВА
   * и проверка на мёртвые — всем, кому группа видна: дописывать цели «Сохранить в группу →
   * В существующую» и так может любой, и убирать лишнее из того же списка он вправе.
   *
   * Правка заказчика 01.09: «було фул редагування папки з групами в управлінні, тепер
   * немає». В MR-246 я закрыл под админа ВЕСЬ блок кнопок разом — вместе с проверкой,
   * которую сервер не ограничивал. Здесь это разделено обратно.
   */
  const canManage = !user || user.isAdmin
  const canEdit = true

  const saveCurrent = () => {
    if (!targets.length) return pushToast({ type: 'error', title: 'Нет групп для сохранения' })
    setSaveOpen(true)
  }
  const loadFolder = (f: TargetFolder) => {
    const allowed = allowedTargets(f, user)
    // Дедуп относительно уже добавленных целей: чтобы не сыпать «загружено N», когда часть
    // (или все) группы уже в списке — считаем сколько реально добавится и сколько повторов.
    const have = new Set(targets.map(ntTarget))
    const fresh = allowed.filter((t) => !have.has(ntTarget(t)))
    const dupes = allowed.length - fresh.length
    onLoad(allowed)
    setManageOpen(false)
    const hidden = f.targets.length - allowed.length
    const tail = `${dupes > 0 ? ` · повторов ${dupes}` : ''}${hidden > 0 ? ` · скрыто ${hidden}` : ''}`
    if (fresh.length === 0 && dupes > 0) {
      pushToast({ type: 'info', title: 'Уже в списке', desc: `${f.name} · все ${dupes} ${plural(dupes, 'группа', 'группы', 'групп')} уже добавлены` })
    } else {
      pushToast({ type: 'success', title: 'Группа загружена', desc: `${f.name} · добавлено ${fresh.length}${tail}` })
    }
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-elevated/40 p-2.5">
      <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted">
        <FolderOpen size={14} /> Группы
      </span>
      {/*
        MR-246: одна кнопка вместо двух. Владелец 30.08: «Зачем нам три кнопки, которые
        делают одно и то же? Давай сделаем управление и загрузить одной кнопочкой».
        «Загрузить» и «Управление» открывали разные окна с одним и тем же списком групп —
        в одном по клику грузили, в другом рядом с тем же кликом переименовывали. Теперь
        окно одно: выбираешь группу — она загружается; можешь управлять — рядом кнопки.
        «Сохранить в группу» осталось отдельно: это другое действие, оно пишет, а не читает.
      */}
      <button type="button" onClick={() => setManageOpen(true)} disabled={!visible.length && !canManage} className="btn-primary h-9 text-xs disabled:opacity-40">
        <FolderOpen size={14} /> Выбрать группу{visible.length ? ` (${visible.length})` : ''}
      </button>
      <button type="button" onClick={saveCurrent} className="btn-ghost h-9 text-xs">
        <Save size={14} /> Сохранить в группу
      </button>
      {!visible.length && (
        <span className="text-xs text-amber-300">{folders.length ? 'Нет доступных групп — попросите админа выдать доступ' : 'Групп пока нет — сохраните список кнопкой «Сохранить в группу»'}</span>
      )}

      <SaveToFolderModal open={saveOpen} onClose={() => setSaveOpen(false)} targets={targets} onSaved={() => void reload()} />
      <FolderManageModal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        // Видит человек ровно те группы, что и раньше в «Загрузить»; управление ниже
        // показывается только тем, кому оно разрешено (§8.1).
        folders={canManage ? folders : visible}
        canManage={canManage}
        canEdit={canEdit}
        onChanged={reload}
        onLoad={loadFolder}
      />
    </div>
  )
}


/**
 * Одно окно и на выбор, и на управление (MR-246). Раньше их было два с одним и тем же
 * списком: в «Загрузить» по клику грузили, в «Управлении» рядом с тем же кликом
 * переименовывали. Кому управление не разрешено — видит только выбор.
 */
function FolderManageModal({ open, onClose, folders, onChanged, onLoad, canManage = true, canEdit = true }: {
  open: boolean; onClose: () => void; folders: TargetFolder[]; onChanged: () => Promise<void>
  /** Выбор группы. Папка целиком: дедуп и скрытие недоступных целей живут у родителя. */
  onLoad: (folder: TargetFolder) => void
  /** Переименование и удаление — админ платформы (§8.1). */
  canManage?: boolean
  /** Правка состава и проверка на мёртвые — всем, кому группа видна. */
  canEdit?: boolean
}) {
  const pushToast = useApp((s) => s.pushToast)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [validatingId, setValidatingId] = useState<string | null>(null)
  /*
   * Правка заказчика 01.09: «було фул редагування папки з групами в управлінні, тепер немає».
   * Управление группой и правда сводилось к имени: загрузить, переименовать, проверить,
   * удалить — а сам СОСТАВ можно было только пополнять («Сохранить в группу» → «В
   * существующую»). Убрать из группы один лишний канал было нечем: только «проверить и
   * удалить мёртвые», а живой, но ненужный канал так не выкинуть.
   *
   * Состав правим черновиком, а не по клику: список отправляется целиком, и правка «на
   * лету» превратила бы каждый крестик в отдельную запись на сервер — с половиной группы,
   * если посреди правки отвалилась сеть.
   */
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState<string[]>([])
  const [add, setAdd] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)

  const validate = async (f: TargetFolder) => {
    setValidatingId(f.id)
    try {
      const r = await validateFolder(f.id)
      await onChanged()
      pushToast({ type: 'success', title: 'Группа проверена', desc: `Рабочих: ${r.kept} · удалено мёртвых: ${r.removed} из ${r.checked}` })
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

  const openEditor = (f: TargetFolder) => {
    if (openId === f.id) return setOpenId(null)
    setOpenId(f.id); setDraft(f.targets); setAdd('')
  }

  /** Добавление: строка целиком — по запятым, пробелам и переносам, как в поле целей модуля. */
  const addTargets = () => {
    const next = cleanTargets([...draft, ...add.split(/[\s,;]+/)])
    setDraft(next); setAdd('')
  }

  const saveTargets = async (f: TargetFolder) => {
    setSavingId(f.id)
    try {
      await updateFolder(f.id, { targets: draft })
      setOpenId(null)
      await onChanged()
      pushToast({ type: 'success', title: 'Состав сохранён', desc: `${f.name} · ${draft.length} ${plural(draft.length, 'группа', 'группы', 'групп')}` })
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка сохранения', desc: e instanceof Error ? e.message : '' })
    } finally { setSavingId(null) }
  }

  const remove = async (f: TargetFolder) => {
    // Всегда спрашиваем подтверждение — удаление группы необратимо (§12).
    if (!(await confirmDialog({
      title: 'Удалить группу?',
      message: `«${f.name}» (${f.targets.length} ${plural(f.targets.length, 'группа', 'группы', 'групп')}) будет удалена безвозвратно.`,
      confirmLabel: 'Удалить',
      tone: 'danger',
    }))) return
    try {
      await deleteFolder(f.id)
      await onChanged()
      pushToast({ type: 'success', title: 'Группа удалена' })
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' })
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Выбрать группу"
      subtitle={canManage
        ? 'Клик по названию загружает; рядом — состав, проверка, переименование и удаление'
        : 'Клик по названию загружает; рядом — состав и проверка на мёртвые'}
      icon={<FolderOpen size={22} />}
      size="lg"
    >
      {folders.length === 0 ? (
        <EmptyState icon={<FolderOpen size={22} />} title="Нет групп" desc="Сохраните текущий список кнопкой «Сохранить в группу»." />
      ) : (
        <ul className="space-y-2">
          {folders.map((f) => {
            const открыт = openId === f.id
            // Кнопка сохранения гаснет, пока состав не тронули: нечего сохранять — нечего и жать.
            const изменён = открыт && (draft.length !== f.targets.length || draft.some((t, i) => t !== f.targets[i]))
            return (
            <li key={f.id} className="rounded-xl border border-line bg-elevated/40 p-3">
              <div className="flex items-center gap-2">
              {editingId === f.id ? (
                <>
                  <input value={draftName} onChange={(e) => setDraftName(e.target.value)} className="input h-9 flex-1" autoFocus />
                  <button type="button" onClick={() => rename(f)} className="btn-icon h-8 w-8 text-spark-400"><Check size={15} /></button>
                  <button type="button" onClick={() => setEditingId(null)} className="btn-icon h-8 w-8"><X size={15} /></button>
                </>
              ) : (
                <>
                  {/* Клик по всей строке грузит группу — это главное, зачем окно открывают. */}
                  <button
                    type="button"
                    onClick={() => onLoad(f)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    title="Загрузить в список"
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-iris-500/12 text-iris-300"><FolderOpen size={16} /></span>
                    <span className="min-w-0">
                      <span className="block truncate font-semibold text-fg">{f.name}</span>
                      <span className="block text-xs text-muted">{f.targets.length} групп</span>
                    </span>
                  </button>
                  {canEdit && <>
                    <button type="button" onClick={() => openEditor(f)} className={cn('btn-icon h-8 w-8', открыт && 'text-spark-400')} title="Состав группы: добавить или убрать цели"><ListTree size={15} /></button>
                    <button type="button" onClick={() => void validate(f)} disabled={validatingId === f.id || !f.targets.length} className="btn-icon h-8 w-8 text-spark-400 disabled:opacity-40" title="Проверить и удалить мёртвые">{validatingId === f.id ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}</button>
                  </>}
                  {canManage && <>
                    <button type="button" onClick={() => { setEditingId(f.id); setDraftName(f.name) }} className="btn-icon h-8 w-8" title="Переименовать"><Pencil size={15} /></button>
                    <button type="button" onClick={() => void remove(f)} className="btn-icon h-8 w-8 text-rose-300" title="Удалить"><Trash2 size={15} /></button>
                  </>}
                </>
              )}
              </div>

              {canEdit && открыт && (
                <div className="mt-3 space-y-2 border-t border-line pt-3">
                  <div className="flex items-center gap-2">
                    <input
                      value={add}
                      onChange={(e) => setAdd(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTargets() } }}
                      placeholder="Добавить цель — @канал, ссылка; можно несколько через запятую"
                      className="input h-9 flex-1"
                    />
                    <button type="button" onClick={addTargets} disabled={!add.trim()} className="btn-ghost h-9 shrink-0 text-xs disabled:opacity-40">
                      <Plus size={14} /> Добавить
                    </button>
                  </div>

                  {draft.length === 0 ? (
                    <p className="text-xs text-amber-300">
                      Группа пуста. Добавьте цель: пустую группу сохранить нельзя — если она не нужна, удалите её целиком.
                    </p>
                  ) : (
                    <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-line bg-surface/60 p-2.5">
                      {draft.map((t) => (
                        <span key={t} className="inline-flex items-center gap-1 rounded-lg border border-line bg-elevated px-2 py-0.5 text-xs text-fg">
                          {t}
                          <button type="button" onClick={() => setDraft(draft.filter((x) => x !== t))} className="text-muted transition-colors hover:text-rose-300" title={`Убрать ${t} из группы`}>
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted">
                      {draft.length} {plural(draft.length, 'группа', 'группы', 'групп')}
                      {изменён ? ` · было ${f.targets.length}` : ''}
                    </span>
                    <div className="flex shrink-0 gap-2">
                      <button type="button" onClick={() => setOpenId(null)} className="btn-ghost h-9 text-xs">Отмена</button>
                      <button
                        type="button"
                        onClick={() => void saveTargets(f)}
                        disabled={savingId === f.id || !draft.length || !изменён}
                        className="btn-primary h-9 text-xs disabled:opacity-40"
                      >
                        {savingId === f.id ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Сохранить состав
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
