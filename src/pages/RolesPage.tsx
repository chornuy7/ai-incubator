import { useEffect, useMemo, useState } from 'react'
import { ShieldCheck, Plus, Trash2, ChevronRight, ChevronDown, Save, Lock } from 'lucide-react'
import { PageHeader, Card, EmptyState, Badge } from '@/shared/ui'
import {
  fetchRoles, fetchRbacCatalog, createRole, updateRole, deleteRole, emptyPermissions,
  type Role, type RbacCatalog, type RolePermissions, type Perm,
} from '@/api/rolesApi'
import { ADMIN_BYPASS_ID } from '@/shared/config/rbac'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'

/** Пара чекбоксов «дать доступ / убрать доступ» (§8.1). */
function PermToggle({ value, onChange, disabled }: { value: Perm; onChange: (p: Perm) => void; disabled?: boolean }) {
  return (
    <div className="flex shrink-0 items-center gap-3">
      <label className={`flex items-center gap-1.5 text-xs ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
        <input type="checkbox" className="accent-spark-500" checked={value === 'allow'} disabled={disabled} onChange={() => onChange('allow')} />
        <span className={value === 'allow' ? 'text-spark-300' : 'text-white/50'}>Доступ</span>
      </label>
      <label className={`flex items-center gap-1.5 text-xs ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
        <input type="checkbox" className="accent-rose-500" checked={value === 'deny'} disabled={disabled} onChange={() => onChange('deny')} />
        <span className={value === 'deny' ? 'text-rose-300' : 'text-white/50'}>Убрать</span>
      </label>
    </div>
  )
}

/** Строка права: подсвечивается, если доступ снят (§8.1 «выделить, если убрал»).
 *  helpTopic — если задан, слева от чекбоксов показывается «?» со статьёй Help Center. */
function PermRow({ label, indent, value, onChange, disabled, helpTopic }: { label: string; indent?: boolean; value: Perm; onChange: (p: Perm) => void; disabled?: boolean; helpTopic?: string }) {
  return (
    <div className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 ${value === 'deny' ? 'bg-rose-500/8 ring-1 ring-inset ring-rose-500/20' : 'bg-elevated'} ${indent ? 'ml-6' : ''}`}>
      <span className={`truncate text-sm ${value === 'deny' ? 'text-rose-200/80' : 'text-fg'}`}>{label}</span>
      <div className="flex shrink-0 items-center gap-2">
        {helpTopic && <HelpButton topic={helpTopic} className="h-7 w-7" />}
        <PermToggle value={value} onChange={onChange} disabled={disabled} />
      </div>
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
    if (!confirm(`Удалить роль «${r.name}»? Действие необратимо.`)) return
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
  const setAccount = (id: string, p: Perm) => { setPerms((s) => ({ ...s, resources: { ...s.resources, accounts: { ...s.resources.accounts, [id]: p } } })); mark() }
  const setFolder = (id: string, p: Perm) => { setPerms((s) => ({ ...s, resources: { ...s.resources, folders: { ...s.resources.folders, [id]: p } } })); mark() }
  const setChannel = (id: string, p: Perm) => { setPerms((s) => ({ ...s, resources: { ...s.resources, channels: { ...s.resources.channels, [id]: p } } })); mark() }
  const setTimers = (p: Perm) => { setPerms((s) => ({ ...s, resources: { ...s.resources, timers: p } })); mark() }
  const setTemplates = (p: Perm) => { setPerms((s) => ({ ...s, resources: { ...s.resources, searchTemplates: p } })); mark() }
  const setFolderChannels = (id: string, channels: string[]) => { setPerms((s) => ({ ...s, resources: { ...s.resources, folderChannels: { ...(s.resources.folderChannels ?? {}), [id]: channels } } })); mark() }

  const mPerm = (k: string): Perm => perms.modules[k] ?? 'deny'
  const bPerm = (k: string): Perm => perms.blocks[k] ?? 'deny'
  const sPerm = (k: string): Perm => perms.sections?.[k] ?? 'deny'
  const aPerm = (id: string): Perm => perms.resources.accounts?.[id] ?? 'deny'
  const fPerm = (id: string): Perm => perms.resources.folders[id] ?? 'deny'
  const cPerm = (id: string): Perm => perms.resources.channels[id] ?? 'deny'
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
        actions={<button onClick={() => void addRole()} className="btn-primary h-10"><Plus size={16} /> Новая роль</button>}
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
                  <span onClick={(e) => { e.stopPropagation(); void removeRole(r) }} className="btn-icon h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100" aria-label="Удалить"><Trash2 size={13} /></span>
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
                  {/* Модули + блоки */}
                  <section>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">Модули и блоки</h3>
                    <div className="flex flex-col gap-1.5">
                      {catalog.modules.map((m) => {
                        const open = expanded.has(m.key)
                        return (
                          <div key={m.key}>
                            <div className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 ${mPerm(m.key) === 'deny' ? 'bg-rose-500/8 ring-1 ring-inset ring-rose-500/20' : 'bg-elevated'}`}>
                              <button onClick={() => toggleExpand(m.key)} className="flex min-w-0 items-center gap-1.5 text-sm text-fg">
                                {open ? <ChevronDown size={15} className="shrink-0 text-white/40" /> : <ChevronRight size={15} className="shrink-0 text-white/40" />}
                                <span className={`truncate ${mPerm(m.key) === 'deny' ? 'text-rose-200/80' : ''}`}>{m.label}</span>
                              </button>
                              <div className="flex shrink-0 items-center gap-2">
                                <HelpButton topic={m.key} className="h-7 w-7" />
                                <PermToggle value={mPerm(m.key)} onChange={(p) => setModule(m.key, p)} />
                              </div>
                            </div>
                            {open && (
                              <div className="mt-1 flex flex-col gap-1">
                                {catalog.blocks.map((b) => (
                                  <PermRow key={b.key} indent label={b.label} value={bPerm(`${m.key}:${b.key}`)} onChange={(p) => setBlock(`${m.key}:${b.key}`, p)} helpTopic={`perm-${b.key}`} />
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
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">Разделы панели</h3>
                      <div className="mb-2 text-[11px] text-white/35">«Мой аккаунт» и «Поддержка» доступны всем всегда. «Роли и доступы» / «Пользователи» — только админу.</div>
                      <div className="flex flex-col gap-1">
                        {catalog.sections.map((sec) => (
                          <PermRow key={sec.key} label={sec.label} value={sPerm(sec.key)} onChange={(p) => setSection(sec.key, p)} />
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
                          {res.type === 'timers' && <PermRow label="Доступ к таймерам / планировщику" value={perms.resources.timers} onChange={setTimers} />}
                          {res.type === 'searchTemplates' && <PermRow label="Доступ к шаблонам поиска" value={perms.resources.searchTemplates} onChange={setTemplates} />}
                          {res.perItem && (res.items?.length ? (
                            <div className="flex flex-col gap-1">
                              {res.items.map((it) => (
                                <div key={it.id}>
                                  <PermRow
                                    label={it.label}
                                    value={res.type === 'folders' ? fPerm(it.id) : res.type === 'channels' ? cPerm(it.id) : aPerm(it.id)}
                                    onChange={(p) => (res.type === 'folders' ? setFolder(it.id, p) : res.type === 'channels' ? setChannel(it.id, p) : setAccount(it.id, p))}
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
