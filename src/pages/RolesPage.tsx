import { useEffect, useMemo, useState } from 'react'
import { ShieldCheck, Plus, Trash2, ChevronRight, ChevronDown, Save, Lock } from 'lucide-react'
import { PageHeader, Card, EmptyState, Badge, Switch } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { confirmDialog } from '@/shared/lib/dialog'
import {
  fetchRoles, fetchRbacCatalog, createRole, updateRole, deleteRole, emptyPermissions,
  type Role, type RbacCatalog, type RolePermissions, type Perm,
} from '@/api/rolesApi'
import { ADMIN_BYPASS_ID } from '@/shared/config/rbac'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { WARMING_MODULES } from '@/shared/lib/massAction'

/** Пара чекбоксов «дать доступ / убрать доступ» (§8.1). */
/**
 * Три состояния поэлементного права: «Доступ» (allow), «Убрать» (явный deny) и
 * НИ ОДНОЙ галочки — «не задано».
 *
 * Раньше состояний было два: незаданное право рисовалось как «Убрать» (из-за
 * фолбэка `?? 'deny'` у геттеров), поэтому админ видел красную «Убрать» у аккаунта,
 * который на самом деле доступен через группу. Хуже: чекбокс «Убрать» уже был
 * checked, и клик по нему ничего не менял — поставить явный запрет через интерфейс
 * было практически невозможно (прогон 21–22.07, тест 7.4). Повторный клик по
 * отмеченному варианту теперь снимает его и возвращает «не задано».
 */
/**
 * MR-36: ОДИН переключатель вместо двух галочек («Доступ» + «Убрать»).
 *
 * Две галочки описывали три состояния — allow / deny / «не задано», — но на поведение
 * влияет только `allow`: `can()` даёт доступ ТОЛЬКО при явном ALLOW, а роли пользователя
 * объединяются через `some()`. То есть «убрать» и «не задано» работают одинаково (нет
 * доступа) и `deny` не перебивает `allow` из другой роли. Значит состояний реально два,
 * и тумблер их выражает честно: включён = доступ есть, выключен = нет.
 *
 * Право, которое админ ещё не трогал, помечаем «не задано» — чтобы было видно, что
 * значение унаследовано по умолчанию, а не выставлено руками.
 */
function PermToggle({ value, onChange, disabled }: { value?: Perm; onChange: (p?: Perm) => void; disabled?: boolean }) {
  const on = value === 'allow'
  return (
    <div className="flex shrink-0 items-center gap-2">
      {value === undefined && (
        <span className="text-[11px] text-white/30" title="Право не задано: доступ решают другие роли и групповые правила">не задано</span>
      )}
      <span className={cn('text-xs', on ? 'text-spark-300' : 'text-white/40')}>{on ? 'Доступ' : 'Нет'}</span>
      <span className={disabled ? 'pointer-events-none opacity-40' : ''}>
        <Switch checked={on} onChange={(v) => onChange(v ? 'allow' : 'deny')} />
      </span>
    </div>
  )
}

/** Строка права: подсвечивается, если доступ снят (§8.1 «выделить, если убрал»). */
function PermRow({ label, indent, value, onChange, disabled }: { label: string; indent?: boolean; value?: Perm; onChange: (p?: Perm) => void; disabled?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 ${value === 'deny' ? 'bg-rose-500/8 ring-1 ring-inset ring-rose-500/20' : 'bg-elevated'} ${indent ? 'ml-6' : ''}`}>
      <span className={`truncate text-sm ${value === 'deny' ? 'text-rose-200/80' : 'text-fg'}`}>{label}</span>
      <PermToggle value={value} onChange={onChange} disabled={disabled} />
    </div>
  )
}

export function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([])
  const [catalog, setCatalog] = useState<RbacCatalog | null>(null)
  const [selId, setSelId] = useState<string>('')
  const [perms, setPerms] = useState<RolePermissions>(emptyPermissions())
  const [name, setName] = useState('')
  const [isTemplate, setIsTemplate] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  const selected = useMemo(() => roles.find((r) => r.id === selId) || null, [roles, selId])
  const isAdminRole = selected?.builtin && selected.id === ADMIN_BYPASS_ID

  async function load() {
    setLoading(true)
    try {
      const [rs, cat] = await Promise.all([fetchRoles(), fetchRbacCatalog()])
      setRoles(rs)
      setCatalog(cat)
      if (!selId && rs.length) selectRole(rs[0])
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function selectRole(r: Role) {
    setSelId(r.id)
    setName(r.name)
    setIsTemplate(!!r.isTemplate)
    setPerms(JSON.parse(JSON.stringify(r.permissions)))
    setDirty(false)
    setErr('')
  }

  async function addRole() {
    try {
      const r = await createRole({ name: `Новая роль ${roles.length}`, permissions: emptyPermissions() })
      setRoles((prev) => [...prev, r])
      selectRole(r)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка') }
  }

  async function removeRole(r: Role) {
    if (r.builtin) return
    if (!(await confirmDialog({ title: 'Удалить роль?', message: `«${r.name}» будет удалена безвозвратно. Пользователи с этой ролью потеряют её доступы.`, confirmLabel: 'Удалить', tone: 'danger' }))) return
    try {
      await deleteRole(r.id)
      const next = roles.filter((x) => x.id !== r.id)
      setRoles(next)
      if (selId === r.id) { setSelId(''); if (next[0]) selectRole(next[0]) }
    } catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка') }
  }

  async function save() {
    if (!selected) return
    setSaving(true); setErr('')
    try {
      const updated = await updateRole(selected.id, { name: name.trim(), isTemplate, permissions: perms })
      setRoles((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
      setDirty(false)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка сохранения') }
    finally { setSaving(false) }
  }

  // ── сеттеры прав (иммутабельно + dirty) ──
  const mark = () => setDirty(true)
  const setModule = (key: string, p: Perm) => { setPerms((s) => ({ ...s, modules: { ...s.modules, [key]: p } })); mark() }
  const setBlock = (key: string, p: Perm) => { setPerms((s) => ({ ...s, blocks: { ...s.blocks, [key]: p } })); mark() }
  const setSection = (key: string, p: Perm) => { setPerms((s) => ({ ...s, sections: { ...s.sections, [key]: p } })); mark() }

  // MR-36: массовые переключатели. Роль на 14 модулей × 6 блоков = 84 клика, чтобы «выключить
  // всё» или «снять запуск везде». Ниже — три вида разом: все модули, все блоки одного модуля,
  // один блок во ВСЕХ модулях (типовой сценарий «смотреть можно, запускать нельзя»).
  const allModuleKeys = () => (catalog?.modules || []).map((m) => m.key)
  const allBlockKeys = () => (catalog?.blocks || []).map((b) => b.key)
  /** Все модули разом (и их блоки — иначе «выключил модуль, а блоки остались allow»). */
  const setAllModules = (p: Perm) => {
    setPerms((s) => {
      const modules = { ...s.modules }
      const blocks = { ...s.blocks }
      for (const k of allModuleKeys()) {
        modules[k] = p
        for (const b of allBlockKeys()) blocks[`${k}:${b}`] = p
      }
      return { ...s, modules, blocks }
    })
    mark()
  }
  /** Все блоки одного модуля. */
  const setModuleBlocks = (moduleKey: string, p: Perm) => {
    setPerms((s) => {
      const blocks = { ...s.blocks }
      for (const b of allBlockKeys()) blocks[`${moduleKey}:${b}`] = p
      return { ...s, blocks }
    })
    mark()
  }
  /** Один блок во всех модулях: «запуск запрещён везде», «логи видны везде». */
  const setBlockEverywhere = (blockKey: string, p: Perm) => {
    setPerms((s) => {
      const blocks = { ...s.blocks }
      for (const k of allModuleKeys()) blocks[`${k}:${blockKey}`] = p
      return { ...s, blocks }
    })
    mark()
  }
  /** Все разделы панели разом. */
  const setAllSections = (p: Perm) => {
    setPerms((s) => {
      const sections = { ...s.sections }
      for (const sec of (catalog?.sections || [])) sections[sec.key] = p
      return { ...s, sections }
    })
    mark()
  }
  /** Записать поэлементное право; undefined — снять его (вернуть «не задано»). */
  const putPerm = (map: Record<string, Perm>, id: string, p?: Perm) => {
    const next = { ...map }
    if (p === undefined) delete next[id]
    else next[id] = p
    return next
  }
  const setAccount = (id: string, p?: Perm) => { setPerms((s) => ({ ...s, resources: { ...s.resources, accounts: putPerm(s.resources.accounts, id, p) } })); mark() }
  const setAccountGroup = (id: string, p?: Perm) => { setPerms((s) => ({ ...s, resources: { ...s.resources, accountGroups: putPerm(s.resources.accountGroups ?? {}, id, p) } })); mark() }
  const setFolder = (id: string, p?: Perm) => { setPerms((s) => ({ ...s, resources: { ...s.resources, folders: putPerm(s.resources.folders, id, p) } })); mark() }
  const setChannel = (id: string, p?: Perm) => { setPerms((s) => ({ ...s, resources: { ...s.resources, channels: putPerm(s.resources.channels, id, p) } })); mark() }
  const setTimers = (p: Perm) => { setPerms((s) => ({ ...s, resources: { ...s.resources, timers: p } })); mark() }
  const setTemplates = (p: Perm) => { setPerms((s) => ({ ...s, resources: { ...s.resources, searchTemplates: p } })); mark() }
  const setAllTasks = (p: Perm) => { setPerms((s) => ({ ...s, resources: { ...s.resources, allTasks: p } })); mark() }
  const setFolderChannels = (id: string, channels: string[]) => { setPerms((s) => ({ ...s, resources: { ...s.resources, folderChannels: { ...(s.resources.folderChannels ?? {}), [id]: channels } } })); mark() }

  const mPerm = (k: string): Perm => perms.modules[k] ?? 'deny'
  const bPerm = (k: string): Perm => perms.blocks[k] ?? 'deny'
  const sPerm = (k: string): Perm => perms.sections?.[k] ?? 'deny'
  const aPerm = (id: string): Perm | undefined => perms.resources.accounts?.[id]
  const agPerm = (id: string): Perm | undefined => perms.resources.accountGroups?.[id]
  const fPerm = (id: string): Perm | undefined => perms.resources.folders[id]
  const cPerm = (id: string): Perm | undefined => perms.resources.channels[id]
  // Выбранные каналы папки. Пусто = все каналы папки (в т.ч. будущие). Ключи нормализованы (без @, lower).
  const ntCh = (t: string) => String(t || '').trim().replace(/^@/, '').toLowerCase()
  const fChannels = (id: string): string[] => perms.resources.folderChannels?.[id] ?? []
  const chChecked = (id: string, ch: string): boolean => { const cur = fChannels(id); return cur.length === 0 || cur.includes(ntCh(ch)) }
  const toggleFolderChannel = (id: string, ch: string, all: string[]) => {
    const allN = all.map(ntCh)
    const cur = fChannels(id)
    const base = cur.length === 0 ? allN : cur
    const k = ntCh(ch)
    const next = base.includes(k) ? base.filter((x) => x !== k) : [...base, k]
    setFolderChannels(id, next.length === allN.length ? [] : next)
  }

  const toggleExpand = (key: string) => setExpanded((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })

  return (
    <div>
      <PageHeader
        title="Роли и доступы"
        subtitle="Главный админ создаёт роли и раздаёт доступ к модулям, блокам и ресурсам. Снятый доступ выделен."
        icon={<ShieldCheck size={22} />}
        badge={roles.length ? `${roles.length}` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <HelpButton topic="rbac-roles" className="h-10 w-10" />
            <button onClick={() => void addRole()} className="btn-primary h-10"><Plus size={16} /> Новая роль</button>
          </div>
        }
      />

      {err && <Card className="mb-3 border-rose-500/30 p-3 text-sm text-rose-300">{err}</Card>}

      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : roles.length === 0 ? (
        <EmptyState title="Ролей пока нет" desc="Создайте первую роль и раздайте ей доступы." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          {/* Список ролей */}
          <div className="flex flex-col gap-2">
            {roles.map((r) => (
              <button
                key={r.id}
                onClick={() => selectRole(r)}
                className={`group flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left transition ${selId === r.id ? 'border-spark-500/50 bg-spark-500/10' : 'border-line bg-elevated hover:border-spark-500/30'}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-fg">{r.name}</span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {r.builtin && <Badge tone="iris">Встроенная</Badge>}
                    {r.isTemplate && <Badge tone="amber">Шаблон</Badge>}
                  </span>
                </span>
                {!r.builtin && (
                  <span onClick={(e) => { e.stopPropagation(); void removeRole(r) }} className="btn-icon-danger h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100" aria-label="Удалить роль" title="Удалить роль"><Trash2 size={13} /></span>
                )}
              </button>
            ))}
          </div>

          {/* Редактор выбранной роли */}
          {selected && (
            <Card className="p-4">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <input
                  value={name}
                  onChange={(e) => { setName(e.target.value); mark() }}
                  className="h-10 flex-1 rounded-lg border border-line bg-elevated px-3 text-sm text-fg outline-none focus:border-spark-500/50"
                  placeholder="Название роли"
                />
                <label className="flex items-center gap-2 text-sm text-white/70">
                  <input type="checkbox" className="accent-amber-500" checked={isTemplate} onChange={(e) => { setIsTemplate(e.target.checked); mark() }} />
                  Шаблон
                </label>
                <button onClick={() => void save()} disabled={!dirty || saving} className="btn-primary h-10 disabled:opacity-40">
                  <Save size={15} /> {saving ? 'Сохранение…' : 'Сохранить'}
                </button>
              </div>

              {isAdminRole ? (
                <div className="flex items-center gap-2 rounded-lg bg-iris-500/10 px-4 py-6 text-sm text-iris-200">
                  <Lock size={16} /> Полный доступ ко всему — встроенная роль администратора. Права не редактируются.
                </div>
              ) : catalog ? (
                <div className="flex flex-col gap-5">
                  {/* Роль «без оплаты»: доступ к модулям даёт роль в обход подписки (тест/модер). */}
                  <section className="rounded-lg border border-iris-500/25 bg-iris-500/[.06] p-3">
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        checked={!!perms.freeAccess}
                        onChange={(e) => { setPerms((s) => ({ ...s, freeAccess: e.target.checked })); mark() }}
                        className="mt-0.5 h-4 w-4 rounded border-line accent-spark-500"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-fg">Тестовый доступ — без оплаты</span>
                        <span className="block text-xs text-muted">Роль видит и запускает разрешённые ей модули в обход подписки. Для тестеров и модераторов, которым не нужно платить (монеты за действия всё равно расходуются).</span>
                      </span>
                    </label>
                  </section>

                  {/* Модули + блоки */}
                  <section>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-white/40">Модули и блоки</h3>
                      {/* MR-36: выключить/включить всё разом — вместо 84 кликов по модулям и блокам. */}
                      <div className="ml-auto flex items-center gap-1.5">
                        <button type="button" onClick={() => setAllModules('allow')}
                          className="rounded-lg border border-line px-2 py-1 text-[11px] text-muted hover:border-spark-500/40 hover:text-spark-200">
                          Включить всё
                        </button>
                        <button type="button" onClick={() => setAllModules('deny')}
                          className="rounded-lg border border-line px-2 py-1 text-[11px] text-muted hover:border-rose-500/40 hover:text-rose-300">
                          Выключить всё
                        </button>
                      </div>
                    </div>
                    {/* Один блок во ВСЕХ модулях: типовой сценарий «смотреть можно, запускать нельзя». */}
                    <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-elevated/40 px-2 py-1.5">
                      <span className="text-[11px] text-white/35">Блок во всех модулях:</span>
                      {(catalog?.blocks || []).map((b) => (
                        <span key={b.key} className="inline-flex items-center gap-0.5">
                          <span className="text-[11px] text-muted">{b.label}</span>
                          <button type="button" title={`Разрешить «${b.label}» во всех модулях`} onClick={() => setBlockEverywhere(b.key, 'allow')}
                            className="rounded border border-line px-1 text-[10px] text-muted hover:border-spark-500/40 hover:text-spark-200">вкл</button>
                          <button type="button" title={`Запретить «${b.label}» во всех модулях`} onClick={() => setBlockEverywhere(b.key, 'deny')}
                            className="rounded border border-line px-1 text-[10px] text-muted hover:border-rose-500/40 hover:text-rose-300">выкл</button>
                        </span>
                      ))}
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {catalog.modules.map((m) => {
                        const open = expanded.has(m.key)
                        return (
                          <div key={m.key}>
                            <div className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 ${mPerm(m.key) === 'deny' ? 'bg-rose-500/8 ring-1 ring-inset ring-rose-500/20' : 'bg-elevated'}`}>
                              <button onClick={() => toggleExpand(m.key)} className="flex min-w-0 items-center gap-1.5 text-sm text-fg">
                                {open ? <ChevronDown size={15} className="shrink-0 text-white/40" /> : <ChevronRight size={15} className="shrink-0 text-white/40" />}
                                <span className={`truncate ${mPerm(m.key) === 'deny' ? 'text-rose-200/80' : ''}`}>{m.label}</span>
                                {/* §12: доступ к модулю НЕ даёт права его останавливать. Без этой пометки
                                    админ думает, что выдал оператору полный контроль над прогревом. */}
                                {WARMING_MODULES.has(m.key) && (
                                  <span
                                    className="shrink-0 rounded-md bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-300 ring-1 ring-inset ring-rose-500/30"
                                    title="Остановить или поставить на паузу прогрев может только супер-админ — ролью это не выдаётся. Прогрев это недели работы аккаунтов, откатить его нельзя. Проверка стоит и на сервере, не только в интерфейсе."
                                  >
                                    стоп — только админ
                                  </span>
                                )}
                              </button>
                              <PermToggle value={mPerm(m.key)} onChange={(p) => setModule(m.key, p ?? 'deny')} />
                            </div>
                            {open && (
                              <div className="mt-1 flex flex-col gap-1">
                                {/* Все блоки этого модуля разом. */}
                                <div className="flex items-center gap-1.5 pl-6 text-[11px] text-white/35">
                                  <span>Все блоки модуля:</span>
                                  <button type="button" onClick={() => setModuleBlocks(m.key, 'allow')}
                                    className="rounded border border-line px-1.5 text-[10px] text-muted hover:border-spark-500/40 hover:text-spark-200">вкл</button>
                                  <button type="button" onClick={() => setModuleBlocks(m.key, 'deny')}
                                    className="rounded border border-line px-1.5 text-[10px] text-muted hover:border-rose-500/40 hover:text-rose-300">выкл</button>
                                </div>
                                {catalog.blocks.map((b) => (
                                  <PermRow key={b.key} indent label={b.label} value={bPerm(`${m.key}:${b.key}`)} onChange={(p) => setBlock(`${m.key}:${b.key}`, p ?? 'deny')} />
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </section>

                  {/* Разделы панели (§8.1: доступ выдаётся не только на модули) */}
                  {catalog.sections?.length ? (
                    <section>
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-white/40">Разделы панели</h3>
                        <div className="ml-auto flex items-center gap-1.5">
                          <button type="button" onClick={() => setAllSections('allow')}
                            className="rounded-lg border border-line px-2 py-1 text-[11px] text-muted hover:border-spark-500/40 hover:text-spark-200">Включить все</button>
                          <button type="button" onClick={() => setAllSections('deny')}
                            className="rounded-lg border border-line px-2 py-1 text-[11px] text-muted hover:border-rose-500/40 hover:text-rose-300">Выключить все</button>
                        </div>
                      </div>
                      <div className="mb-2 text-[11px] text-white/35">«Мой аккаунт» и «Поддержка» доступны всем всегда. «Роли и доступы» / «Пользователи» — только админу.</div>
                      <div className="flex flex-col gap-1">
                        {catalog.sections.map((sec) => (
                          <PermRow key={sec.key} label={sec.label} value={sPerm(sec.key)} onChange={(p) => setSection(sec.key, p ?? 'deny')} />
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {/* Ресурсы */}
                  <section>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">Ресурсы</h3>
                    <div className="flex flex-col gap-4">
                      {catalog.resources.map((res) => (
                        <div key={res.type}>
                          <div className="mb-1.5 text-sm font-medium text-white/70">{res.label}</div>
                          {res.type === 'timers' && <PermRow label="Доступ к таймерам / планировщику" value={perms.resources.timers} onChange={(p) => setTimers(p ?? 'deny')} />}
                          {res.type === 'searchTemplates' && <PermRow label="Доступ к шаблонам поиска" value={perms.resources.searchTemplates} onChange={(p) => setTemplates(p ?? 'deny')} />}
                          {res.type === 'allTasks' && <PermRow label="Видеть и вести чужие задачи в Дашборде (иначе — только свои)" value={perms.resources.allTasks ?? 'deny'} onChange={(p) => setAllTasks(p ?? 'deny')} />}
                          {res.perItem && (res.items?.length ? (
                            <div className="flex flex-col gap-1">
                              {res.items.map((it) => (
                                <div key={it.id}>
                                  <PermRow
                                    label={it.label}
                                    value={res.type === 'folders' ? fPerm(it.id) : res.type === 'channels' ? cPerm(it.id) : res.type === 'accountGroups' ? agPerm(it.id) : aPerm(it.id)}
                                    onChange={(p) => (res.type === 'folders' ? setFolder(it.id, p) : res.type === 'channels' ? setChannel(it.id, p) : res.type === 'accountGroups' ? setAccountGroup(it.id, p) : setAccount(it.id, p))}
                                  />
                                  {res.type === 'folders' && fPerm(it.id) === 'allow' && (it.channels?.length ? (
                                    <div className="ml-4 mt-1 rounded-lg border border-line bg-elevated/60 px-3 py-2">
                                      <div className="mb-1.5 flex items-center gap-2">
                                        <span className="text-xs font-medium text-white/60">
                                          Каналы папки — {fChannels(it.id).length === 0 ? `все (${it.channels.length})` : `${fChannels(it.id).length} из ${it.channels.length}`}
                                        </span>
                                        <button type="button" onClick={() => setFolderChannels(it.id, [])} className="ml-auto text-xs font-semibold text-spark-300 hover:text-spark-200">Выбрать все</button>
                                      </div>
                                      <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                                        {it.channels.map((ch) => (
                                          <label key={ch} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs text-white/70 hover:bg-white/5">
                                            <input type="checkbox" checked={chChecked(it.id, ch)} onChange={() => toggleFolderChannel(it.id, ch, it.channels!)} className="accent-spark-500" />
                                            <span className="truncate">{ch}</span>
                                          </label>
                                        ))}
                                      </div>
                                      <div className="mt-1 text-[11px] text-white/35">Ничего не выбрано = показываются все каналы папки (включая будущие).</div>
                                    </div>
                                  ) : (
                                    <div className="ml-4 mt-1 text-[11px] text-white/35">В папке пока нет каналов.</div>
                                  ))}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-lg bg-elevated px-3 py-2 text-xs text-white/40">Пусто — {res.label.toLowerCase()} появятся здесь после создания.</div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              ) : null}
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
