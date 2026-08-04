import { useEffect, useMemo, useState } from 'react'
import { Users2, Plus, Trash2, ShieldCheck, Check, Users, Wifi, ChevronDown, Search } from 'lucide-react'
import { PageHeader, Card, EmptyState, Badge, Modal } from '@/shared/ui'
import { confirmDialog } from '@/shared/lib/dialog'
import { fetchUsers, createUser, updateUser, deleteUser, fetchWorktime, type User, type WorkSummary } from '@/api/usersApi'
import { fetchRoles, type Role } from '@/api/rolesApi'
import { fetchAccountGroups, type AccountGroup } from '@/api/accountGroupsApi'
import { fetchAccounts } from '@/api/accountsApi'
import type { TgAccount } from '@/shared/types'
import { useSession } from '@/features/auth/session'
import { ADMIN_BYPASS_ID } from '@/shared/config/rbac'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { cn } from '@/shared/lib/utils'

/** Мультивыбор ролей: клик по чипу добавляет/убирает роль. Права ролей суммируются (union). */
function RolePicker({ roles, value, onChange }: { roles: Role[]; value: string[]; onChange: (ids: string[]) => void }) {
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  return (
    <div className="flex flex-wrap gap-1.5">
      {roles.map((r) => {
        const on = value.includes(r.id)
        const admin = r.id === ADMIN_BYPASS_ID
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => toggle(r.id)}
            className={cn(
              'inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
              on
                ? admin ? 'border-iris-500/50 bg-iris-500/15 text-iris-200' : 'border-spark-500/50 bg-spark-500/15 text-spark-200'
                : 'border-line text-white/45 hover:text-white/80',
            )}
          >
            {on && <Check size={12} />}{r.name}
          </button>
        )
      })}
    </div>
  )
}

/**
 * §5.4 (MR-37): владелец выдаёт субу аккаунты из своего пула — отдельно ГРУППЫ и отдельно
 * ОДИНОЧНЫЕ аккаунты (назначение каждого раздела однозначно). Пишет прямые гранты на профиль
 * суба (accountGroupIds/accountIds), которые вливаются в его эффективные права на сервере.
 */
function SubAccessEditor({ sub, groups, accounts, onSaved }: { sub: User; groups: AccountGroup[]; accounts: TgAccount[]; onSaved: (u: User) => void }) {
  const [open, setOpen] = useState(false)
  const [groupIds, setGroupIds] = useState<string[]>(sub.accountGroupIds || [])
  const [accIds, setAccIds] = useState<string[]>(sub.accountIds || [])
  const [q, setQ] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const toggleGroup = (id: string) => setGroupIds((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]))
  const toggleAcc = (id: string) => setAccIds((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]))
  const needle = q.trim().toLowerCase()
  const shown = useMemo(
    () => (needle ? accounts.filter((a) => [a.name, a.phone, a.username].some((s) => (s || '').toLowerCase().includes(needle))) : accounts),
    [accounts, needle],
  )
  const save = async () => {
    setSaving(true); setErr('')
    try { onSaved(await updateUser(sub.id, { accountGroupIds: groupIds, accountIds: accIds })) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка') }
    finally { setSaving(false) }
  }

  return (
    <div className="mt-1 w-full">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-xs text-white/55 hover:text-white/85">
        <ChevronDown size={13} className={cn('transition-transform', open && 'rotate-180')} />
        Доступ к аккаунтам: {groupIds.length} групп · {accIds.length} отдельных
      </button>
      {open && (
        <div className="mt-2 space-y-3 rounded-xl border border-line bg-elevated/40 p-3">
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-white/50"><Users size={12} /> Группы аккаунтов</div>
            {groups.length ? (
              <div className="flex flex-wrap gap-1.5">
                {groups.map((g) => {
                  const on = groupIds.includes(g.id)
                  return (
                    <button key={g.id} onClick={() => toggleGroup(g.id)}
                      className={cn('rounded-lg border px-2 py-1 text-xs transition-colors', on ? 'border-spark-500/50 bg-spark-500/10 text-spark-200' : 'border-line text-white/45 hover:text-white/80')}>
                      {on ? '✓ ' : ''}{g.name} <span className="text-white/30">({g.accountIds.length})</span>
                    </button>
                  )
                })}
              </div>
            ) : <div className="text-xs text-white/40">Групп нет — создайте их в «Менеджере аккаунтов».</div>}
          </div>
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-white/50"><Wifi size={12} /> Отдельные аккаунты</div>
            <div className="relative mb-1.5">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-white/40" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск аккаунта" className="input h-8 w-full pl-8 text-xs" />
            </div>
            <div className="max-h-44 space-y-0.5 overflow-y-auto pr-1">
              {shown.map((a) => {
                const on = accIds.includes(a.id)
                return (
                  <button key={a.id} onClick={() => toggleAcc(a.id)}
                    className={cn('flex w-full items-center gap-2 rounded-lg border px-2 py-1 text-left text-xs transition-colors', on ? 'border-spark-500/40 bg-spark-500/10 text-spark-100' : 'border-transparent text-white/70 hover:bg-white/5')}>
                    <span className={cn('grid h-4 w-4 shrink-0 place-items-center rounded border', on ? 'border-spark-400 bg-spark-500/30' : 'border-line')}>{on && <Check size={10} />}</span>
                    <span className="truncate">{a.name}</span>
                    <span className="ml-auto shrink-0 text-white/35">{a.phone || a.username}</span>
                  </button>
                )
              })}
              {!shown.length && <div className="px-1 py-2 text-xs text-white/40">Ничего не найдено.</div>}
            </div>
          </div>
          {err && <div className="text-xs text-rose-300">{err}</div>}
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-[11px] text-white/40">Выдано: {groupIds.length} групп, {accIds.length} аккаунтов</span>
            <button onClick={() => void save()} disabled={saving} className="btn-primary h-8 text-xs disabled:opacity-40">{saving ? 'Сохранение…' : 'Сохранить доступ'}</button>
          </div>
        </div>
      )}
    </div>
  )
}

/** мс → «2ч 15м» / «12м». */
function fmtDur(ms: number): string {
  const min = Math.floor(ms / 60000)
  if (min < 1) return '—'
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? `${h}ч ${m}м` : `${m}м`
}

export function UsersPage() {
  const sessionUser = useSession((s) => s.user)
  const [users, setUsers] = useState<User[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [worktime, setWorktime] = useState<Record<string, WorkSummary>>({})
  const [groups, setGroups] = useState<AccountGroup[]>([])
  const [accounts, setAccounts] = useState<TgAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<{ email: string; name: string; password: string; roleIds: string[] }>({ email: '', name: '', password: '', roleIds: ['role_moderator'] })
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoading(true)
    try {
      // §5.4 (MR-37): группы и аккаунты пула — чтобы владелец мог выдавать их субам.
      const [us, rs, wt, gr, accs] = await Promise.all([
        fetchUsers(), fetchRoles(), fetchWorktime().catch(() => ({})),
        fetchAccountGroups().then((r) => r.groups).catch(() => []),
        fetchAccounts().catch(() => []),
      ])
      setUsers(us); setRoles(rs); setWorktime(wt); setGroups(gr); setAccounts(accs.filter((a) => !a.inTrash))
    } catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка загрузки') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  // §5.4 (MR-37): владелец раздаёт субам СВОИ группы (созданные им) + «общие» без владельца.
  const myGroups = useMemo(
    () => groups.filter((g) => !g.userId || g.userId === sessionUser?.id || !!sessionUser?.isAdmin),
    [groups, sessionUser],
  )

  async function assignRoles(u: User, roleIds: string[]) {
    try {
      const upd = await updateUser(u.id, { roleIds })
      setUsers((prev) => prev.map((x) => (x.id === u.id ? upd : x)))
    } catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка') }
  }
  async function toggleActive(u: User) {
    try {
      const upd = await updateUser(u.id, { active: !u.active })
      setUsers((prev) => prev.map((x) => (x.id === u.id ? upd : x)))
    } catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка') }
  }
  async function remove(u: User) {
    if (!(await confirmDialog({ title: 'Удалить пользователя?', message: `Оператор «${u.name}» (${u.email}) потеряет доступ к панели. Действие необратимо.`, confirmLabel: 'Удалить', tone: 'danger' }))) return
    try {
      await deleteUser(u.id)
      setUsers((prev) => prev.filter((x) => x.id !== u.id))
    } catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка') }
  }
  async function submit() {
    setSaving(true); setErr('')
    try {
      const u = await createUser(form)
      setUsers((prev) => [...prev, u])
      setOpen(false)
      setForm({ email: '', name: '', password: '', roleIds: ['role_moderator'] })
    } catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка') }
    finally { setSaving(false) }
  }

  return (
    <div>
      <PageHeader
        title="Пользователи"
        subtitle="Операторы панели и их роли. Главный админ назначает роль и включает/отключает доступ."
        icon={<Users2 size={22} />}
        badge={users.length ? `${users.length}` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <HelpButton topic="rbac-roles" className="h-10 w-10" />
            <button onClick={() => setOpen(true)} className="btn-primary h-10"><Plus size={16} /> Новый пользователь</button>
          </div>
        }
      />

      {err && <Card className="mb-3 border-rose-500/30 p-3 text-sm text-rose-300">{err}</Card>}

      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : users.length === 0 ? (
        <EmptyState title="Пользователей нет" desc="Создайте первого оператора и назначьте роль." />
      ) : (
        <div className="flex flex-col gap-2">
          {users.map((u) => {
            const roleIds = u.roleIds?.length ? u.roleIds : (u.roleId ? [u.roleId] : [])
            const isAdmin = roleIds.includes(ADMIN_BYPASS_ID)
            const locked = u.id === 'usr_admin' // встроенного главного админа не трогаем
            return (
              <Card key={u.id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-fg">{u.name}</span>
                    {isAdmin && <Badge tone="iris">Админ</Badge>}
                    {!u.active && <Badge tone="rose">Отключён</Badge>}
                  </div>
                  <div className="truncate text-xs text-white/50">{u.email}</div>
                  {worktime[u.id] && (
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-white/45">
                      {worktime[u.id].open && <span className="inline-flex items-center gap-1 text-spark-300"><span className="h-1.5 w-1.5 rounded-full bg-spark-400" /> в сети</span>}
                      <span>сегодня {fmtDur(worktime[u.id].todayMs)}</span>
                      <span className="text-white/25">·</span>
                      <span>7 дней {fmtDur(worktime[u.id].weekMs)}</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {locked ? (
                    <span className="flex items-center gap-1.5 rounded-lg bg-iris-500/10 px-3 py-2 text-xs text-iris-200"><ShieldCheck size={14} /> Полный доступ</span>
                  ) : (
                    <div className="flex flex-col items-end gap-1">
                      <RolePicker roles={roles} value={roleIds} onChange={(ids) => void assignRoles(u, ids)} />
                      <span className="text-[11px] text-white/35">
                        {isAdmin ? 'Полный доступ (админ-роль)' : roleIds.length > 1 ? `${roleIds.length} роли — права суммируются` : roleIds.length === 0 ? 'Нет ролей — нет доступа' : ''}
                      </span>
                    </div>
                  )}
                  <button onClick={() => void toggleActive(u)} className="btn-ghost h-9 text-xs">{u.active ? 'Отключить' : 'Включить'}</button>
                  {!locked && (
                    <button onClick={() => void remove(u)} className="btn-icon-danger h-9 w-9" aria-label="Удалить пользователя" title="Удалить пользователя">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                {/* §5.4 (MR-37): выдача субу групп/аккаунтов из пула владельца. Не для главного
                    админа и не для админ-ролей (у них и так полный доступ). */}
                {!locked && !isAdmin && (
                  <SubAccessEditor sub={u} groups={myGroups} accounts={accounts}
                    onSaved={(upd) => setUsers((prev) => prev.map((x) => (x.id === upd.id ? upd : x)))} />
                )}
              </Card>
            )
          })}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Новый пользователь">
        <div className="flex flex-col gap-3">
          <div>
            <label className="label">E-mail</label>
            <input value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className="input" placeholder="user@example.com" />
          </div>
          <div>
            <label className="label">Имя</label>
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="input" placeholder="Имя оператора" />
          </div>
          <div>
            <label className="label">Пароль (мин. 6 символов)</label>
            <input value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} className="input" placeholder="••••••••" />
          </div>
          <div>
            <label className="label">Роли <span className="font-normal text-white/40">(можно несколько — права суммируются)</span></label>
            <RolePicker roles={roles} value={form.roleIds} onChange={(ids) => setForm((f) => ({ ...f, roleIds: ids }))} />
          </div>
          <div className="mt-1 flex justify-end gap-2">
            <button onClick={() => setOpen(false)} className="btn-ghost h-10">Отмена</button>
            <button onClick={() => void submit()} disabled={saving || !form.email || form.password.length < 6} className="btn-primary h-10 disabled:opacity-40">{saving ? 'Создание…' : 'Создать'}</button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
