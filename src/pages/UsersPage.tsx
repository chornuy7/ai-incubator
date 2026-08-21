import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Users2, Plus, Trash2, ShieldCheck, Check, Users, Wifi, ChevronDown, ChevronRight, Search, Package } from 'lucide-react'
import { PageHeader, Card, EmptyState, Badge, Modal, Switch } from '@/shared/ui'
import { confirmDialog } from '@/shared/lib/dialog'
import {
  fetchUsers, createUser, updateUser, deleteUser, fetchWorktime, fetchUserAccess, saveUserAccess,
  type User, type WorkSummary,
} from '@/api/usersApi'
import { fetchRoles, fetchRbacCatalog, accessFromRole, type Role, type Perm, type CatalogModule, type CatalogBlock } from '@/api/rolesApi'
import { RolesPage, Pager, PAGE_SIZE } from '@/pages/RolesPage'
import { fetchAccountGroups, type AccountGroup } from '@/api/accountGroupsApi'
import { fetchAccounts } from '@/api/accountsApi'
import type { TgAccount } from '@/shared/types'
import { useSession } from '@/features/auth/session'
import { ADMIN_BYPASS_ID } from '@/shared/config/rbac'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { cn } from '@/shared/lib/utils'

/**
 * Вкладка шаблонов внутри объединённого раздела. Вкладка живёт в АДРЕСЕ, а не только в
 * состоянии: ссылка «создайте шаблон» и кнопка «назад» должны попадать туда, куда обещают.
 */
const ROLES_TAB_HREF = '/panel/users?tab=roles'

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

/** Что владелец правит субу: модули и блоки внутри них. Ключ блока — `${moduleKey}:${blockKey}`. */
type AccessDraft = { modules: Record<string, Perm>; blocks: Record<string, Perm> }
type AccessCatalog = { modules: CatalogModule[]; blocks: CatalogBlock[] }

const EMPTY_ACCESS: AccessDraft = { modules: {}, blocks: {} }
/** Выбрано ли хоть что-то — чтобы не слать пустой PUT после создания пользователя. */
const hasAccessChoice = (a: AccessDraft) => Object.keys(a.modules).length > 0 || Object.keys(a.blocks).length > 0

/**
 * Уточнение владельца от 21.08: доступ субпользователя настраивается ЗДЕСЬ, в его карточке,
 * а не отдельной страницей «Роли и доступы». Владелец мыслит не ролями, а людьми: «вот этому
 * показать нейрокомментинг, а вот этому — нет». Персональную роль под суба заводит сервер сам
 * (PUT /api/users/:id/access), владельцу она не показывается.
 *
 * Список модулей приходит из каталога, УЖЕ урезанного подпиской владельца, — фильтровать его
 * ещё раз на клиенте нельзя: пропавший оплаченный модуль читается как поломка, а не как запрет.
 */
function ModuleAccessPicker({ catalog, value, onChange }: {
  catalog: AccessCatalog; value: AccessDraft; onChange: (next: AccessDraft) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const modOn = (k: string) => value.modules[k] === 'allow'
  const blockOn = (k: string) => value.blocks[k] === 'allow'

  /**
   * Переключение модуля тянет за собой ВСЕ его блоки. Иначе включённый модуль открывается
   * субу с закрытыми кнопками внутри (запуск, настройки, логи) — человек видит раздел, но
   * ничего в нём не может, и это выглядит поломкой, а не настройкой. Точечно блоки правятся
   * ниже, после раскрытия модуля.
   */
  const toggleModule = (key: string) => {
    const next: Perm = modOn(key) ? 'deny' : 'allow'
    const blocks = { ...value.blocks }
    catalog.blocks.forEach((b) => { blocks[`${key}:${b.key}`] = next })
    onChange({ modules: { ...value.modules, [key]: next }, blocks })
  }
  const toggleBlock = (key: string) =>
    onChange({ ...value, blocks: { ...value.blocks, [key]: blockOn(key) ? 'deny' : 'allow' } })
  const toggleExpand = (key: string) =>
    setExpanded((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })

  // Пустая подписка — не пустой список: без объяснения владелец решает, что раздел сломан.
  if (!catalog.modules.length) {
    return (
      <div className="rounded-lg border border-line bg-elevated/40 px-3 py-2.5 text-xs text-white/50">
        В вашей подписке нет модулей — выдавать субпользователю пока нечего.{' '}
        <Link to="/panel/user/subscription" className="font-semibold text-spark-300 hover:text-spark-200">Открыть «Подписки»</Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-[11px] text-white/40">
        <Package size={12} className="shrink-0" />
        Показаны модули из вашей подписки — выдать можно только оплаченное.
      </div>
      {catalog.modules.map((m) => {
        const open = expanded.has(m.key)
        const on = modOn(m.key)
        const allowedBlocks = catalog.blocks.filter((b) => blockOn(`${m.key}:${b.key}`)).length
        return (
          <div key={m.key}>
            <div className={cn('flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5', on ? 'bg-spark-500/8' : 'bg-elevated')}>
              <button type="button" onClick={() => toggleExpand(m.key)} className="flex min-w-0 items-center gap-1.5 text-left text-sm text-fg">
                {open ? <ChevronDown size={14} className="shrink-0 text-white/40" /> : <ChevronRight size={14} className="shrink-0 text-white/40" />}
                <span className="truncate">{m.label}</span>
                {on && <span className="shrink-0 text-[11px] text-white/35">блоков: {allowedBlocks}/{catalog.blocks.length}</span>}
              </button>
              <Switch checked={on} onChange={() => toggleModule(m.key)} />
            </div>
            {open && (
              <div className="mt-1 flex flex-col gap-1 pl-6">
                {!on && <div className="text-[11px] text-white/35">Модуль выключен — блоки ни на что не влияют, пока не включите его.</div>}
                {catalog.blocks.map((b) => {
                  const bk = `${m.key}:${b.key}`
                  return (
                    <div key={bk} className="flex items-center justify-between gap-3 rounded-lg bg-elevated px-2.5 py-1.5">
                      <span className="truncate text-xs text-white/75">{b.label}</span>
                      <Switch checked={blockOn(bk)} onChange={() => toggleBlock(bk)} />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * «Применить шаблон» — единственная роль шаблона в жизни пользователя (уточнение владельца
 * 21.08: «роль это просто как шаблон и все настроек которые уже были выбраны»).
 *
 * Выбор шаблона КОПИРУЕТ его модули и блоки в тумблеры и на этом заканчивается: постоянной
 * связи «роль → доступ» нет. Именно её убрали днём 21.08 — она давала неразрешимое: владелец
 * гасит модуль тумблером, а роль возвращает его обратно, и выключатель выглядит сломанным.
 *
 * Шаблон НЕОБЯЗАТЕЛЕН: если их нет, вместо селекта стоит ссылка на соседнюю вкладку, но
 * доступ прекрасно выставляется тумблерами и пользователь создаётся без всякого шаблона.
 */
function ApplyTemplate({ roles, catalog, applied, hint, onApply, className }: {
  roles: Role[]
  catalog: AccessCatalog
  /** Имя последнего применённого шаблона — подтверждение, что подстановка произошла. */
  applied: string
  /** Что делать дальше: в форме создания — «доправить ниже», в карточке — «сохранить». */
  hint: string
  onApply: (draft: AccessDraft, roleName: string) => void
  className?: string
}) {
  if (!roles.length) {
    return (
      <div className={cn('text-[11px] text-white/40', className)}>
        Шаблонов пока нет — выставьте доступ тумблерами или{' '}
        <Link to={ROLES_TAB_HREF} className="font-semibold text-spark-300 hover:text-spark-200">создайте шаблон</Link>,
        чтобы в следующий раз выдать тот же набор одним кликом.
      </div>
    )
  }
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <select
        // Значение всегда пустое: это не «выбранная роль» (её больше не существует как связи),
        // а разовое действие — поэтому после применения список возвращается к заголовку и
        // тот же шаблон можно применить ещё раз, если тумблеры увели не туда.
        value=""
        onChange={(e) => {
          const r = roles.find((x) => x.id === e.target.value)
          if (r) onApply(accessFromRole(r, catalog.modules, catalog.blocks), r.name)
        }}
        disabled={!catalog.modules.length}
        className="input h-8 min-w-[170px] text-xs disabled:opacity-40"
        aria-label="Применить шаблон доступа"
      >
        <option value="">Применить шаблон…</option>
        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      {applied
        ? <span className="text-[11px] text-spark-300">применён шаблон «{applied}» — {hint}</span>
        : <span className="text-[11px] text-white/35">заполнит тумблеры готовым набором</span>}
    </div>
  )
}

/**
 * «Доступ к модулям» в карточке существующего суба — пара к «Доступу к аккаунтам» выше:
 * аккаунты отвечают на «с чем работать», модули — на «что вообще видно».
 */
function SubModuleAccessEditor({ sub, templates }: { sub: User; templates: Role[] }) {
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<AccessCatalog | null>(null)
  const [draft, setDraft] = useState<AccessDraft>(EMPTY_ACCESS)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [applied, setApplied] = useState('')
  const [err, setErr] = useState('')

  // Грузим по РАСКРЫТИЮ, а не вместе со списком: у владельца бывает несколько десятков субов,
  // и запрос доступа на каждого превратил бы открытие страницы в десятки запросов ради данных,
  // в которые чаще всего не заглядывают.
  useEffect(() => {
    if (!open || catalog) return
    let alive = true
    setLoading(true); setErr('')
    fetchUserAccess(sub.id)
      .then((a) => { if (!alive) return; setCatalog(a.catalog); setDraft({ modules: a.modules, blocks: a.blocks }) })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : 'Не удалось загрузить доступ') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, catalog, sub.id])

  const allowedCount = useMemo(() => Object.values(draft.modules).filter((p) => p === 'allow').length, [draft])

  const save = async () => {
    setSaving(true); setErr(''); setSaved(false)
    try { await saveUserAccess(sub.id, draft); setDirty(false); setSaved(true) }
    catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка') }
    finally { setSaving(false) }
  }

  return (
    <div className="w-full">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-xs text-white/55 hover:text-white/85">
        <ChevronDown size={13} className={cn('transition-transform', open && 'rotate-180')} />
        Доступ к модулям{catalog ? `: ${allowedCount} из ${catalog.modules.length}` : ''}
      </button>
      {open && (
        <div className="mt-2 space-y-3 rounded-xl border border-line bg-elevated/40 p-3">
          {loading ? (
            <div className="text-xs text-white/40">Загрузка доступа…</div>
          ) : catalog ? (
            <ModuleAccessPicker catalog={catalog} value={draft} onChange={(v) => { setDraft(v); setDirty(true); setSaved(false) }} />
          ) : null}
          {err && <div className="text-xs text-rose-300">{err}</div>}
          {catalog?.modules.length ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {/* Шаблон только ПОДСТАВЛЯЕТ значения — сохраняет по-прежнему владелец кнопкой
                  рядом. Иначе выбор в списке молча менял бы права живому сотруднику, а
                  посмотреть, что именно подставилось, было бы уже поздно. */}
              <ApplyTemplate
                roles={templates} catalog={catalog} applied={applied}
                hint="проверьте тумблеры и сохраните"
                onApply={(next, roleName) => { setDraft(next); setApplied(roleName); setDirty(true); setSaved(false) }}
                className="mr-auto"
              />
              {saved && !dirty && <span className="text-[11px] text-spark-300">Сохранено</span>}
              <button onClick={() => void save()} disabled={saving || !dirty} className="btn-primary h-8 text-xs disabled:opacity-40">
                {saving ? 'Сохранение…' : 'Сохранить доступ'}
              </button>
            </div>
          ) : null}
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

/** Вкладка «Пользователи» объединённого раздела (полосу вкладок рисует UsersAndRolesPage). */
function UsersTab({ tabs }: { tabs?: ReactNode }) {
  const sessionUser = useSession((s) => s.user)
  const [users, setUsers] = useState<User[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [worktime, setWorktime] = useState<Record<string, WorkSummary>>({})
  const [groups, setGroups] = useState<AccountGroup[]>([])
  const [accounts, setAccounts] = useState<TgAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState(false)
  // Роли в форме больше нет: новый суб создаётся БЕЗ ролей, а его доступ приходит вторым
  // запросом (PUT .../access), который заводит ему персональную роль. Раньше здесь по
  // умолчанию стоял системный «role_moderator» — он выдавал модули, которых владелец не
  // выбирал, и после уточнения 21.08 («роль — шаблон») превратился бы в тихую раздачу прав.
  const [form, setForm] = useState<{ email: string; name: string; password: string; roleIds: string[]; balanceMode: 'shared' | 'individual'; tokenLimit: string }>({ email: '', name: '', password: '', roleIds: [], balanceMode: 'shared', tokenLimit: '' })
  // Доступ будущего суба: id появится только после создания, поэтому выбор копится в форме,
  // а PUT /api/users/:id/access уходит сразу следом (см. submit).
  const [newAccess, setNewAccess] = useState<AccessDraft>(EMPTY_ACCESS)
  /** Имя шаблона, применённого в форме создания, — только подпись, в запрос не уходит. */
  const [appliedTpl, setAppliedTpl] = useState('')
  // Каталог для формы создания берём из RBAC-каталога — он тоже урезан подпиской владельца.
  // У /api/users/:id/access каталог тот же, но его нельзя спросить без id пользователя.
  const [catalog, setCatalog] = useState<AccessCatalog>({ modules: [], blocks: [] })
  const [saving, setSaving] = useState(false)
  // Правка 18.08: страница «Пользователи» — про СВОЮ команду. Раньше админу сюда
  // валился весь список платформы (65 юзеров, из них 59 чужих регистраций).
  // Управление всеми осталось, но включается явно и только у админа.
  const [scopeAll, setScopeAll] = useState(false)
  /** Страница списка (по PAGE_SIZE человек). */
  const [page, setPage] = useState(1)
  // Смена области («моя команда» ↔ «вся платформа») — это смена ФИЛЬТРА: остаться на
  // седьмой странице после переключения значит открыть раздел где-то посередине чужого
  // списка. Возвращаемся в начало.
  useEffect(() => { setPage(1) }, [scopeAll])

  async function load() {
    setLoading(true)
    try {
      // §5.4 (MR-37): группы и аккаунты пула — чтобы владелец мог выдавать их субам.
      const [us, rs, wt, gr, accs, cat] = await Promise.all([
        fetchUsers(scopeAll ? 'all' : 'mine'), fetchRoles(), fetchWorktime().catch(() => ({})),
        fetchAccountGroups().then((r) => r.groups).catch(() => []),
        fetchAccounts().catch(() => []),
        // Каталог не должен ронять страницу: без него форма создания просто скажет, что
        // модулей в подписке нет, а список пользователей останется рабочим.
        fetchRbacCatalog().catch(() => null),
      ])
      setUsers(us); setRoles(rs); setWorktime(wt); setGroups(gr); setAccounts(accs.filter((a) => !a.inTrash))
      if (cat) setCatalog({ modules: cat.modules, blocks: cat.blocks })
    } catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка загрузки') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [scopeAll])

  // §5.4 (MR-37): владелец раздаёт субам СВОИ группы (созданные им) + «общие» без владельца.
  const myGroups = useMemo(
    () => groups.filter((g) => !g.userId || g.userId === sessionUser?.id || !!sessionUser?.isAdmin),
    [groups, sessionUser],
  )

  /**
   * Шаблоны доступа для кнопки «Применить шаблон». Владельцу сервер и так отдаёт только его
   * созданные роли, но админ платформы видит ВСЕ — включая персональные роли субов
   * («Доступ · Иван») и админ-роль. Первое к чужому сотруднику применять бессмысленно,
   * второе раздало бы полный доступ одним кликом по выпадающему списку.
   */
  const templates = useMemo(
    () => roles.filter((r) => !r.personalFor && r.id !== ADMIN_BYPASS_ID),
    [roles],
  )

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
  function resetForm() {
    setForm({ email: '', name: '', password: '', roleIds: [], balanceMode: 'shared', tokenLimit: '' })
    setNewAccess(EMPTY_ACCESS)
    setAppliedTpl('')
  }

  async function submit() {
    setSaving(true); setErr('')
    let created: User
    try {
      created = await createUser({
        email: form.email, name: form.name, password: form.password, roleIds: form.roleIds,
        // §4.2 (MR-30): режим баланса и лимит токенов для индивидуального.
        balanceMode: form.balanceMode,
        tokenLimit: form.balanceMode === 'individual' && form.tokenLimit ? Number(form.tokenLimit) : null,
      })
    } catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка'); setSaving(false); return }
    setUsers((prev) => [...prev, created])
    // Новый сотрудник дописывается в конец списка — перелистываем на последнюю страницу.
    // Иначе создание заканчивается закрытой модалкой и внешне ничем: карточка появилась,
    // но на другой странице, и владелец жмёт «Создать» второй раз.
    setPage(Math.ceil((users.length + 1) / PAGE_SIZE))
    // Доступ пишем ВТОРЫМ запросом: раньше создания у суба нет id, а привязывать модули не к
    // кому. Падение этого шага не откатывает создание — поэтому о нём говорим прямо, иначе
    // владелец увидит суба без модулей и решит, что переключатели просто не сработали.
    try {
      if (hasAccessChoice(newAccess)) await saveUserAccess(created.id, newAccess)
    } catch (e) {
      setErr(`Пользователь создан, но доступ к модулям не сохранился (${e instanceof Error ? e.message : 'ошибка'}). Настройте его в карточке пользователя.`)
    }
    setOpen(false)
    resetForm()
    setSaving(false)
  }

  // «Безопасная» страница считается на лету: удалили последнего на третьей странице —
  // страницы больше нет, и запомненный номер показал бы пустой список.
  const pages = Math.max(1, Math.ceil(users.length / PAGE_SIZE))
  const pageSafe = Math.min(page, pages)
  const shownUsers = users.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE)

  return (
    <div>
      <PageHeader
        title="Пользователи"
        subtitle={scopeAll
          ? 'Все пользователи платформы — режим администратора.'
          : 'Ваша команда: субпользователи и их роли. Роль назначает и доступ включает владелец пространства.'}
        icon={<Users2 size={22} />}
        badge={users.length ? `${users.length}` : undefined}
        actions={
          <div className="flex items-center gap-2">
            {sessionUser?.isAdmin && (
              <button
                type="button"
                onClick={() => setScopeAll((v) => !v)}
                title={scopeAll ? 'Показывать только свою команду' : 'Показать всех пользователей платформы (доступно администратору)'}
                className={cn('h-10 rounded-xl border px-3 text-sm font-medium transition-colors',
                  scopeAll ? 'border-iris-500/50 bg-iris-500/15 text-iris-200' : 'border-line text-white/60 hover:text-white')}
              >
                {scopeAll ? 'Вся платформа' : 'Только моя команда'}
              </button>
            )}
            <HelpButton topic="rbac-roles" className="h-10 w-10" />
            <button onClick={() => setOpen(true)} className="btn-primary h-10"><Plus size={16} /> Новый пользователь</button>
          </div>
        }
      />

      {tabs}

      {err && <Card className="mb-3 border-rose-500/30 p-3 text-sm text-rose-300">{err}</Card>}

      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : users.length === 0 ? (
        <EmptyState title="Пользователей нет" desc="Создайте первого оператора и назначьте роль." />
      ) : (
        <div>
          <div className="flex flex-col gap-2">
          {shownUsers.map((u) => {
            const roleIds = u.roleIds?.length ? u.roleIds : (u.roleId ? [u.roleId] : [])
            const isAdmin = roleIds.includes(ADMIN_BYPASS_ID)
            // Своя карточка — не объект управления (правка 18.08): роли ограничивают
            // СОТРУДНИКА, а владелец и так работает без ограничений. Раньше здесь стояли
            // кликабельные чипы, и попытка выдать роль себе упиралась в отказ сервера
            // «Можно управлять только своими субпользователями» — выглядело как поломка.
            const isMe = u.id === sessionUser?.id
            const locked = u.id === 'usr_admin' || isMe // встроенного главного админа и себя не трогаем
            return (
              <Card key={u.id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-fg">{u.name}</span>
                    {isAdmin && <Badge tone="iris">Админ</Badge>}
                    {isMe && !isAdmin && <Badge tone="spark">Вы</Badge>}
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
                    <span className="flex items-center gap-1.5 rounded-lg bg-iris-500/10 px-3 py-2 text-xs text-iris-200">
                      <ShieldCheck size={14} /> {isMe && !isAdmin ? 'Вы · владелец пространства' : 'Полный доступ'}
                    </span>
                  ) : (
                    <div className="flex flex-col items-end gap-1">
                      {/*
                        Дропдаун роли отсюда убран (уточнение владельца 21.08). Роль и
                        персональный доступ СУММИРУЮТСЯ на сервере, поэтому вместе они дают
                        неразрешимое: владелец гасит модуль тумблером ниже, а роль «Тимлид»
                        его возвращает — выключатель выглядит сломанным. Плюс назначение роли
                        перезаписывало бы `roleIds`, стирая персональный доступ целиком.
                        Роль осталась в интерфейсе, но уже как ЗАГОТОВКА: «Применить шаблон» в
                        блоке «Доступ к модулям» ниже подставляет её значения в тумблеры и на
                        этом отпускает — дальше доступ живёт сам по себе.
                      */}
                      <span className="text-[11px] text-white/35">
                        {isAdmin
                          ? 'Полный доступ (админ-роль)'
                          : roleIds.length > 1
                            // Наследие мультивыбора: пока доступ не пересохранён, права
                            // считаются по ВСЕМ старым ролям — молчать об этом нельзя.
                            ? `${roleIds.length} роли от прежних настроек — сохраните доступ ниже, он их заменит`
                            : 'Доступ настраивается ниже'}
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
                {/* Уточнение владельца 21.08: что субу ПОКАЗЫВАТЬ — тоже решается здесь, рядом
                    с выдачей аккаунтов, а не на отдельной странице ролей. */}
                {!locked && !isAdmin && <SubModuleAccessEditor sub={u} templates={templates} />}
              </Card>
            )
          })}
          </div>
          <Pager page={pageSafe} total={users.length} onPage={setPage} label="пользователей" />
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
          {/* Уточнение владельца 21.08: набор модулей выбирается ПРИ СОЗДАНИИ, а не потом
              отдельным заходом — иначе первый вход суба показывает ему пустую панель.
              Дропдаун роли отсюда убран: роль стала шаблоном, а не назначением, поэтому её
              место — кнопка «Применить шаблон» ниже, которая заполняет эти же тумблеры. */}
          <div>
            <label className="label">Доступ к модулям <span className="font-normal text-white/40">(из вашей подписки)</span></label>
            <ApplyTemplate
              roles={templates} catalog={catalog} applied={appliedTpl}
              hint="можно доправить ниже"
              onApply={(draft, roleName) => { setNewAccess(draft); setAppliedTpl(roleName) }}
              className="mb-2"
            />
            <div className="max-h-64 overflow-y-auto pr-1">
              <ModuleAccessPicker catalog={catalog} value={newAccess} onChange={setNewAccess} />
            </div>
          </div>
          {/* §4.2 (MR-30): баланс суба — общий с владельцем или индивидуальный лимит токенов. */}
          <div>
            <label className="label">Баланс субпользователя</label>
            <div className="flex flex-col gap-1.5">
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line p-2 text-sm">
                <input type="radio" name="balmode" checked={form.balanceMode === 'shared'} onChange={() => setForm((f) => ({ ...f, balanceMode: 'shared' }))} className="mt-0.5 accent-spark-500" />
                <span><span className="font-medium text-fg">Общий баланс владельца</span><span className="block text-xs text-white/45">Суб тратит из вашего кошелька (по умолчанию).</span></span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line p-2 text-sm">
                <input type="radio" name="balmode" checked={form.balanceMode === 'individual'} onChange={() => setForm((f) => ({ ...f, balanceMode: 'individual' }))} className="mt-0.5 accent-spark-500" />
                <span><span className="font-medium text-fg">Индивидуальный лимит токенов</span><span className="block text-xs text-white/45">Отдельный кошелёк суба с ограничением.</span></span>
              </label>
              {form.balanceMode === 'individual' && (
                <div className="flex flex-wrap items-center gap-2 pl-2">
                  <input type="number" min={0} value={form.tokenLimit} onChange={(e) => setForm((f) => ({ ...f, tokenLimit: e.target.value }))} placeholder="Лимит токенов" className="input h-9 w-40 text-sm" />
                  <span className="text-xs text-white/50">{form.tokenLimit ? `≈ ${Math.floor(Number(form.tokenLimit) / 1000).toLocaleString('ru-RU')} действий (ориентировочно)` : 'укажите лимит токенов'}</span>
                </div>
              )}
            </div>
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

/** Вкладки объединённого раздела. Значение живёт в query-параметре `?tab=`. */
type TeamTab = 'users' | 'roles'

/**
 * Полоса вкладок. Рисуется здесь, а внутрь вкладки уезжает пропом `tabs`, чтобы стоять
 * ПОД шапкой страницы: у каждой вкладки своя шапка со своими кнопками («Новый пользователь»
 * / «Создать шаблон»), и вкладки над заголовком читались бы как навигация всей панели.
 */
function TeamTabs({ tab, onTab, rolesLabel }: { tab: TeamTab; onTab: (t: TeamTab) => void; rolesLabel: string }) {
  const items: { key: TeamTab; label: string; icon: typeof Users2 }[] = [
    { key: 'users', label: 'Пользователи', icon: Users2 },
    { key: 'roles', label: rolesLabel, icon: ShieldCheck },
  ]
  return (
    <div className="mb-4 flex w-fit items-center gap-1 rounded-xl border border-line bg-elevated/60 p-1">
      {items.map((it) => {
        const on = it.key === tab
        const Icon = it.icon
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onTab(it.key)}
            aria-current={on ? 'page' : undefined}
            className={cn('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              on ? 'bg-spark-500/12 text-spark-300' : 'text-muted hover:bg-white/5 hover:text-fg')}
          >
            <Icon size={15} className="shrink-0" />
            {it.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * «Пользователи» и «Роли и доступы» — один раздел с двумя вкладками (просьба владельца
 * 21.08: «давай объединим… а внутри там просто 2 будет пагинация по пользователям и
 * пагинация по ролям»). Это не только экономия строки в меню: шаблон доступа собирают и
 * применяют в одном сценарии, а два соседних пункта заставляли ходить туда-сюда.
 *
 * Вкладка хранится в АДРЕСЕ (`?tab=roles`), а не в состоянии компонента: ссылка на вкладку
 * шаблонов должна открывать именно её, а «назад» — возвращать на предыдущую вкладку, а не
 * выбрасывать из раздела. Старый путь /panel/roles ведёт сюда же (см. App.tsx).
 */
export function UsersAndRolesPage() {
  const [params, setParams] = useSearchParams()
  const isPlatformAdmin = !!useSession((s) => s.user?.isAdmin)
  const tab: TeamTab = params.get('tab') === 'roles' ? 'roles' : 'users'
  const go = (next: TeamTab) => {
    const p = new URLSearchParams(params)
    if (next === 'roles') p.set('tab', 'roles')
    // Вкладка по умолчанию — без параметра в адресе (чистый /panel/users). `role=<id>`
    // адресует конкретный шаблон и на вкладке пользователей значит ровно ничего.
    else { p.delete('tab'); p.delete('role') }
    setParams(p)
  }
  // Владельцу роль — заготовка, админу платформы — настоящая роль. Подпись вкладки
  // повторяет заголовок соответствующей страницы, чтобы переход не выглядел прыжком.
  const tabs = <TeamTabs tab={tab} onTab={go} rolesLabel={isPlatformAdmin ? 'Роли и доступы' : 'Шаблоны доступа'} />
  return tab === 'roles' ? <RolesPage tabs={tabs} /> : <UsersTab tabs={tabs} />
}
