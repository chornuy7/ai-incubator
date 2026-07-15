import { useEffect, useState } from 'react'
import { Users2, Plus, Trash2, ShieldCheck } from 'lucide-react'
import { PageHeader, Card, EmptyState, Badge, Select, Modal } from '@/shared/ui'
import { fetchUsers, createUser, updateUser, deleteUser, fetchWorktime, type User, type WorkSummary } from '@/api/usersApi'
import { fetchRoles, type Role } from '@/api/rolesApi'
import { ADMIN_BYPASS_ID } from '@/shared/config/rbac'

/** мс → «2ч 15м» / «12м». */
function fmtDur(ms: number): string {
  const min = Math.floor(ms / 60000)
  if (min < 1) return '—'
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? `${h}ч ${m}м` : `${m}м`
}

export function UsersPage() {
  const [users, setUsers] = useState<User[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [worktime, setWorktime] = useState<Record<string, WorkSummary>>({})
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ email: '', name: '', password: '', roleId: 'role_moderator' })
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const [us, rs, wt] = await Promise.all([fetchUsers(), fetchRoles(), fetchWorktime().catch(() => ({}))])
      setUsers(us); setRoles(rs); setWorktime(wt)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка загрузки') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  async function setRole(u: User, roleId: string) {
    try {
      const upd = await updateUser(u.id, { roleId })
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
    if (!confirm(`Удалить пользователя ${u.email}?`)) return
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
      setForm({ email: '', name: '', password: '', roleId: 'role_moderator' })
    } catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка') }
    finally { setSaving(false) }
  }

  const roleOptions = roles.map((r) => ({ value: r.id, label: r.name }))

  return (
    <div>
      <PageHeader
        title="Пользователи"
        subtitle="Операторы панели и их роли. Главный админ назначает роль и включает/отключает доступ."
        icon={<Users2 size={22} />}
        badge={users.length ? `${users.length}` : undefined}
        actions={<button onClick={() => setOpen(true)} className="btn-primary h-10"><Plus size={16} /> Новый пользователь</button>}
      />

      {err && <Card className="mb-3 border-rose-500/30 p-3 text-sm text-rose-300">{err}</Card>}

      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : users.length === 0 ? (
        <EmptyState title="Пользователей нет" desc="Создайте первого оператора и назначьте роль." />
      ) : (
        <div className="flex flex-col gap-2">
          {users.map((u) => {
            const isAdmin = u.roleId === ADMIN_BYPASS_ID
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
                  {isAdmin ? (
                    <span className="flex items-center gap-1.5 rounded-lg bg-iris-500/10 px-3 py-2 text-xs text-iris-200"><ShieldCheck size={14} /> Полный доступ</span>
                  ) : (
                    <Select value={u.roleId} onChange={(v) => void setRole(u, v)} className="w-48" options={roleOptions} />
                  )}
                  <button onClick={() => void toggleActive(u)} className="btn-ghost h-9 text-xs">{u.active ? 'Отключить' : 'Включить'}</button>
                  {u.id !== 'usr_admin' && (
                    <button onClick={() => void remove(u)} className="btn-icon h-9 w-9" aria-label="Удалить"><Trash2 size={14} /></button>
                  )}
                </div>
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
            <label className="label">Роль</label>
            <Select value={form.roleId} onChange={(v) => setForm((f) => ({ ...f, roleId: v }))} options={roleOptions} />
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
