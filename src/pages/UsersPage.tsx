import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Users2, Plus, Trash2, ShieldCheck, Check, Users, Wifi, ChevronDown, ChevronRight, Search, Package } from 'lucide-react'
import { PageHeader, Card, EmptyState, Badge, Modal, Switch } from '@/shared/ui'
import { confirmDialog } from '@/shared/lib/dialog'
import {
  fetchUsers, createUser, updateUser, deleteUser, fetchWorktime, fetchUserAccess, saveUserAccess,
  fetchSubLimits, transferTokens,
  type User, type WorkSummary, type SubLimit,
} from '@/api/usersApi'
import { fetchRoles, fetchRbacCatalog, accessFromRole, onRolesChanged, type Role, type Perm, type CatalogModule, type CatalogBlock } from '@/api/rolesApi'
import { RolesPage, Pager, PAGE_SIZE } from '@/pages/RolesPage'
import { fetchAccountGroups, type AccountGroup } from '@/api/accountGroupsApi'
import { fetchAccounts } from '@/api/accountsApi'
import type { TgAccount } from '@/shared/types'
import { useSession } from '@/features/auth/session'
import { ADMIN_BYPASS_ID } from '@/shared/config/rbac'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { cn } from '@/shared/lib/utils'
import { fetchSpendByUser, fetchPricing, fetchBalance, type SpendByUser as SpendByUserRow } from '@/api/balanceApi'

/** Якорь раздела шаблонов — он на этой же странице, ниже списка людей. */
const TEMPLATES_ANCHOR = '#templates'

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
type AccessCatalog = { modules: CatalogModule[]; blocks: CatalogBlock[]; blocksByModule?: Record<string, CatalogBlock[]> }

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
        /*
         * Блоки КОНКРЕТНОГО модуля, а не общий список (правка 27.08). Сервер отдаёт
         * blocksByModule с 26.08, и «Роли доступа» его уже используют, а карточка
         * пользователя продолжала рисовать все пять подряд: у нейрокомментинга висел
         * тумблер «Результаты», которого в модуле нет вовсе, и счётчик показывал «3/5»
         * при четырёх реальных блоках.
         */
        const blocks = catalog.blocksByModule?.[m.key] ?? catalog.blocks
        const allowedBlocks = blocks.filter((b) => blockOn(`${m.key}:${b.key}`)).length
        return (
          <div key={m.key}>
            <div className={cn('flex items-center justify-between gap-3 rounded-lg px-2.5 py-1.5', on ? 'bg-spark-500/8' : 'bg-elevated')}>
              <button type="button" onClick={() => toggleExpand(m.key)} className="flex min-w-0 items-center gap-1.5 text-left text-sm text-fg">
                {open ? <ChevronDown size={14} className="shrink-0 text-white/40" /> : <ChevronRight size={14} className="shrink-0 text-white/40" />}
                <span className="truncate">{m.label}</span>
                {on && <span className="shrink-0 text-[11px] text-white/35">блоков: {allowedBlocks}/{blocks.length}</span>}
              </button>
              <Switch checked={on} onChange={() => toggleModule(m.key)} />
            </div>
            {open && (
              <div className="mt-1 flex flex-col gap-1 pl-6">
                {!on && <div className="text-[11px] text-white/35">Модуль выключен — блоки ни на что не влияют, пока не включите его.</div>}
                {blocks.map((b) => {
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
function ApplyTemplate({ roles, catalog, picked, hint, onPick, className }: {
  roles: Role[]
  catalog: AccessCatalog
  /** Выбранный шаблон — его имя видно в поле, пока набор не тронули. '' = не выбран. */
  picked: string
  /** Что делать дальше: в форме создания — «доправить ниже», в карточке — «сохранить». */
  hint: string
  /** Выбрали шаблон или сняли выбор (null) — тогда набор возвращается к исходному. */
  onPick: (draft: AccessDraft | null, roleName: string) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)

  // Закрытие по клику мимо и по Escape: список рисуем сами, а значит и поведение,
  // которое браузер давал нативному <select>, теперь наше.
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey) }
  }, [open])

  if (!roles.length) {
    return (
      <div className={cn('text-[11px] text-white/40', className)}>
        Ролей пока нет — выставьте доступ тумблерами или{' '}
        <a href={TEMPLATES_ANCHOR} className="font-semibold text-spark-300 hover:text-spark-200">создайте роль</a>,
        чтобы в следующий раз выдать тот же набор одним кликом.
      </div>
    )
  }

  const disabled = !catalog.modules.length
  const choose = (r: Role | null) => {
    setOpen(false)
    onPick(r ? accessFromRole(r, catalog.modules, catalog.blocks) : null, r ? r.name : '')
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {/* Свой список вместо нативного <select>: тот рисуется средствами системы — белое
          меню с синей подсветкой посреди тёмной панели, — и не показывал выбранное,
          потому что значение сбрасывалось после применения (правка 21.08). */}
      <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            'flex h-8 min-w-[190px] items-center justify-between gap-2 rounded-xl border px-3 text-xs transition-colors',
            disabled && 'cursor-not-allowed opacity-40',
            picked ? 'border-spark-500/50 bg-spark-500/10 text-spark-200' : 'border-line bg-elevated text-white/70 hover:border-spark-500/40',
          )}
        >
          <span className="truncate">{picked || 'Выбрать роль'}</span>
          <ChevronDown size={13} className={cn('shrink-0 transition-transform', open && 'rotate-180')} />
        </button>
        {open && (
          <div role="listbox" className="absolute left-0 top-full z-30 mt-1 max-h-56 min-w-full overflow-y-auto rounded-xl border border-line bg-elevated p-1 shadow-xl">
            {/* Первым — снятие выбора: вернуться к тому, что было до подстановки. */}
            <button
              type="button" role="option" aria-selected={!picked}
              onClick={() => choose(null)}
              className={cn('flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
                picked ? 'text-white/45 hover:bg-white/5 hover:text-white/70' : 'bg-white/5 text-white/70')}
            >
              Выбрать роль
            </button>
            {roles.map((r) => {
              const on = picked === r.name
              return (
                <button
                  key={r.id} type="button" role="option" aria-selected={on}
                  onClick={() => choose(r)}
                  className={cn('flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
                    on ? 'bg-spark-500/15 text-spark-200' : 'text-white/75 hover:bg-white/5')}
                >
                  <span className="truncate">{r.name}</span>
                  {on && <Check size={13} className="shrink-0" />}
                </button>
              )
            })}
          </div>
        )}
      </div>
      {picked
        ? <span className="text-[11px] text-spark-300">набор из «{picked}» подставлен — {hint}</span>
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
  /**
   * Доступ, лежащий на сервере. Нужен, чтобы снятие шаблона возвращало карточку ровно
   * туда, где она была до подстановки: «выбрал не тот шаблон» не должно значить «теперь
   * угадывай, что тут стояло». Пока черновик равен этому снимку, сохранять нечего.
   */
  const [base, setBase] = useState<AccessDraft>(EMPTY_ACCESS)
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
      .then((a) => {
        if (!alive) return
        setCatalog(a.catalog)
        setDraft({ modules: a.modules, blocks: a.blocks })
        setBase({ modules: a.modules, blocks: a.blocks })
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : 'Не удалось загрузить доступ') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, catalog, sub.id])

  const allowedCount = useMemo(() => Object.values(draft.modules).filter((p) => p === 'allow').length, [draft])

  const save = async () => {
    setSaving(true); setErr(''); setSaved(false)
    try { await saveUserAccess(sub.id, draft); setBase(draft); setDirty(false); setSaved(true) }
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
                roles={templates} catalog={catalog} picked={applied}
                hint="проверьте тумблеры и сохраните"
                onPick={(next, roleName) => {
                  // Сняли выбор — возвращаем сохранённое и гасим «Сохранить»: подстановки
                  // не было, менять нечего.
                  setDraft(next ?? base)
                  setApplied(roleName)
                  setDirty(!!next)
                  setSaved(false)
                }}
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

/** Верхняя половина раздела: список сотрудников и их доступы. */
function UsersTab() {
  const sessionUser = useSession((s) => s.user)
  /*
   * Свой остаток — ПОТОЛОК для лимита сотрудника (правка 27.08: «если у него общих
   * токенов 400, то он больше 400 не должен иметь возможность вводить»). Обещать
   * сотруднику тысячу, имея четыреста, нечем: он всё равно упрётся в конец общих денег,
   * а число в карточке будет врать про запас, которого нет.
   */
  const [мойОстаток, setМойОстаток] = useState<number | null>(null)
  useEffect(() => { void fetchBalance().then((b) => setМойОстаток(Math.floor(Number(b.coins) || 0))).catch(() => {}) }, [])
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

  // Шаблоны правят в разделе ниже, на этом же экране. Перечитываем список по сигналу
  // оттуда: иначе удалённый шаблон остаётся в выпадающем списке до перезагрузки.
  useEffect(() => onRolesChanged(() => { void fetchRoles().then(setRoles).catch(() => {}) }), [])

  /** Привязать осиротевшего сотрудника к текущему владельцу: наследование пойдёт сразу. */
  async function attachToMe(u: User) {
    if (!sessionUser?.id) return
    try {
      const upd = await updateUser(u.id, { parentId: sessionUser.id })
      setUsers((prev) => prev.map((x) => (x.id === upd.id ? upd : x)))
    } catch (e) { setErr(e instanceof Error ? e.message : 'Не удалось привязать') }
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
        // §4.2 (MR-30): режим баланса.
        balanceMode: form.balanceMode,
        /*
         * Потолок расхода задаётся СРАЗУ (правка 27.08: «почему при создании нет
         * возможности выдать ему токены или использовать общий доступ?»). Поле отсюда
         * убирали, когда лимит нигде не проверялся и был обманкой; теперь он работает —
         * значит, и задавать его при создании можно. Пусто — без ограничения.
         */
        tokenLimit: form.tokenLimit === '' ? null : Math.max(0, Number(form.tokenLimit) || 0),
        /*
         * Владельца проставляем ЯВНО (правка 27.08). Сервер подставляет его сам только
         * тем, кто НЕ админ, — а у админа платформы этот путь пропускался, и сотрудник
         * рождался без родителя: ни подписки владельца, ни его баланса он не наследовал,
         * и первым, что видел, был экран «Баланс закончился · 0.00 ⚡».
         * Эта страница — «мои сотрудники», поэтому владелец здесь всегда я.
         */
        parentId: sessionUser?.id ?? undefined,
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

      {err && <Card className="mb-3 border-rose-500/30 p-3 text-sm text-rose-300">{err}</Card>}

      <SpendByUser />

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
                  {/*
                    Сотрудник без владельца (27.08). Наследование и баланса, и подписки идёт
                    ВВЕРХ по parentId: нет владельца — нет ни денег, ни модулей, и человек
                    видит «Баланс на нуле», хотя у владельца всё есть. Так рождались субы,
                    созданные админом платформы: сервер подставлял владельца только тем, кто
                    создаёт НЕ будучи админом. Создание починено, но записи остались — здесь
                    их видно и можно привязать, а не пересоздавать.
                  */}
                  {!isAdmin && !u.parentId && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5">
                      <span className="text-[11px] leading-snug text-amber-200">
                        Не привязан к владельцу — не наследует ни баланс, ни модули подписки. У него всё по нулям.
                      </span>
                      {/*
                        Привязывать может только админ платформы. Владельцу это дало бы
                        способ «усыновить» чужого пользователя и получить над ним контроль —
                        а своих субов сервер и так заводит под ним автоматически.
                      */}
                      {sessionUser?.isAdmin && (
                        <button
                          type="button"
                          onClick={() => void attachToMe(u)}
                          className="ml-auto h-7 shrink-0 rounded-lg bg-amber-500/20 px-2.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/30"
                        >
                          Привязать ко мне
                        </button>
                      )}
                    </div>
                  )}
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
                {/* Кошелёк — рядом с доступами: это тоже «что сотруднику разрешено», только в монетах. */}
                {!locked && !isAdmin && (
                  <SubWalletEditor sub={u} onMode={(upd) => setUsers((prev) => prev.map((x) => (x.id === upd.id ? upd : x)))} />
                )}
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
              roles={templates} catalog={catalog} picked={appliedTpl}
              hint="можно доправить ниже"
              // В форме создания «до подстановки» — это пустой набор: сотрудника ещё нет,
              // сохранённому доступу взяться неоткуда.
              onPick={(next, roleName) => { setNewAccess(next ?? EMPTY_ACCESS); setAppliedTpl(roleName) }}
              className="mb-2"
            />
            <div className="max-h-64 overflow-y-auto pr-1">
              <ModuleAccessPicker catalog={catalog} value={newAccess} onChange={setNewAccess} />
            </div>
          </div>
          {/*
            §4.2 (MR-30): баланс субпользователя. Выбора здесь больше НЕТ (правка 27.08:
            «только общий баланс, у них нету своего кошелька»). Кошелёк один — владельца;
            сотруднику задаётся лишь потолок расхода, и делается это после создания, в его
            карточке, где рядом видно потраченное. Отдельный кошелёк порождал вторую кассу:
            монеты застревали у сотрудника, а владелец не понимал, почему у него списалось
            меньше, чем потрачено.
          */}
          <div>
            <label className="label">Лимит расхода (токены)</label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                min={0}
                max={мойОстаток ?? undefined}
                value={form.tokenLimit}
                onChange={(e) => setForm((f) => ({ ...f, tokenLimit: capLimit(e.target.value, мойОстаток) }))}
                placeholder={мойОстаток == null ? 'например 500' : `не больше ${мойОстаток}`}
                className="input h-10 w-40 text-sm"
              />
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, tokenLimit: '' }))}
                className={cn('h-10 rounded-xl px-3 text-xs font-semibold',
                  form.tokenLimit === '' ? 'bg-spark-500/20 text-spark-300' : 'border border-line text-muted hover:text-fg')}
              >
                Без ограничения
              </button>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-white/45">
              Сотрудник тратит из <b className="text-white/70">вашего</b> кошелька — своего у него нет.
              Лимит — потолок: сколько всего он может израсходовать. Пусто — без потолка, тратит наравне с вами.
              {мойОстаток != null && <> Больше <b className="text-white/70">{мойОстаток} ⚡</b> задать нельзя — столько у вас на счету.</>}
              {' '}Изменить и посмотреть расход можно в его карточке.
            </p>
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

/**
 * «Пользователи и роли» — ОДИН экран (просьба владельца 21.08: «объединим… а внутри там
 * просто 2 будет пагинация по пользователям и пагинация по ролям»).
 *
 * Сначала я сделал две вкладки — и это было не то, о чём просили: вкладка прячет половину
 * раздела, а сценарий тут сквозной — собрать шаблон и тут же применить его сотруднику.
 * Поэтому обе половины стоят друг под другом, у каждой свой список и своя пагинация.
 *
 * Старый путь /panel/roles ведёт сюда же (см. App.tsx), а sudo-админка по-прежнему
 * открывает RolesPage отдельной страницей — там это настоящие роли платформы.
 */
/**
 * Расход по сотрудникам (просьба владельца 27.08: «овнер должен видеть, кто сколько
 * потратил»).
 *
 * При общем балансе списания сотрудников уходят в кошелёк владельца, и до 27.08 в журнал
 * попадал только владелец — разложить расход было не из чего. Теперь пишется и тот, кто
 * потратил, а здесь это видно суммой за период. Начисления в расход не считаем: выдача
 * себе же — не трата.
 */
/**
 * Кошелёк сотрудника (решение владельца 27.08: «писать будем, сколько мы токенов ему
 * выдали… чтобы можно было редактировать токены, выдать больше или убрать и изменить на
 * общий баланс»).
 *
 * До этого режим «личный кошелёк» был ловушкой: сотрудник получал пустой кошелёк, поле
 * «лимит токенов» из формы создания нигде не проверялось, пополнить кошелёк мог только
 * админ из админки, а сменить режим было нельзя вовсе — ошибку при создании исправить
 * нечем. Теперь видно, сколько выдано и сколько осталось, монеты ходят в обе стороны, и
 * режим переключается обратно на общий.
 */
/**
 * Потолок лимита — остаток владельца (правка 27.08: «больше 400 не должен иметь
 * возможность вводить»). Обрезаем прямо при вводе, а не ругаемся после: число, которое
 * нельзя выдать, не должно даже появляться в поле. Остаток ещё не пришёл — не мешаем.
 */
function capLimit(raw: string, max: number | null): string {
  if (raw === '') return ''
  const n = Math.max(0, Math.floor(Number(raw) || 0))
  return String(max == null ? n : Math.min(n, max))
}

/**
 * Кошелёк сотрудника: владелец ВЫДАЁТ токены и может изъять их обратно (MR-225).
 *
 * Было — «лимит расхода»: сотрудник тратил из кошелька владельца, а лимит показывался ему
 * как баланс. Заказчик 30.08: «у меня есть пять таких Маш, каждой поставил лимит по 100.
 * Это же 500 влезает, а у меня как у владельца может быть всего 100 токенов». Лимит ничего
 * не выделял, и сумма лимитов ничем не ограничивалась.
 *
 * Стало — перевод: у владельца стало меньше, у сотрудника появилось. Отсюда и надписи:
 * «Выдать» вместо «Задать лимит», «У сотрудника» вместо «Осталось лимита». Рядом с
 * токенами — деньги: «токены это не просто цифра, это деньги, которые я передаю».
 */
function SubWalletEditor({ sub, onMode }: { sub: User; onMode: (next: User) => void }) {
  const [limit, setLimit] = useState<SubLimit | null>(null)
  const [сумма, setСумма] = useState('')
  const [prices, setPrices] = useState<Record<string, number>>({})
  const [мойОстаток, setМойОстаток] = useState<number | null>(null)
  const [курс, setКурс] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const l = (await fetchSubLimits()).find((x) => x.userId === sub.id) ?? { userId: sub.id, limit: null, spent: 0, left: null }
      setLimit(l)
    } catch { /* кошелёк не должен ломать карточку */ }
    try { setМойОстаток(Number((await fetchBalance()).coins) || 0) } catch { /* offline */ }
  }, [sub.id])

  useEffect(() => { void load() }, [load])
  // Цены и курс нужны только раскрытой карточке: свёрнутых на экране может быть десяток.
  useEffect(() => {
    if (!open) return
    void fetchPricing().then((r) => {
      setPrices(r.actionsFull && Object.keys(r.actionsFull).length ? r.actionsFull : r.actions)
      /*
       * Курс токена в долларах берём из ПАКЕТОВ пополнения — по ним человек и покупает
       * токены, значит это его же цена, а не выдуманная. Себестоимость сервер клиенту не
       * отдаёт принципиально (MR-149), и правильно: владельцу нужно «сколько это денег
       * для меня», а не наша маржа.
       */
      const пакет = (r.packs || []).filter((p) => p.coins > 0 && p.price > 0)
        .sort((a, b) => (a.price / a.coins) - (b.price / b.coins))[0]
      if (пакет) setКурс(пакет.price / пакет.coins)
    }).catch(() => {})
  }, [open])

  const свои = limit?.own ?? null
  const наОбщем = свои === null

  const перевод = async (знак: 1 | -1) => {
    const n = Number(сумма)
    if (!Number.isFinite(n) || n <= 0) { setNote('Укажите количество токенов'); return }
    setBusy(true); setNote('')
    try {
      const r = await transferTokens(sub.id, знак * n)
      setСумма('')
      setNote(знак > 0
        ? `Выдано ${r.moved} ⚡ · у вас осталось ${r.ownerLeft} ⚡`
        : r.partial
          ? `Забрали ${r.moved} ⚡ — больше у сотрудника не было, остальное он уже потратил`
          : `Изъято ${r.moved} ⚡ · у вас ${r.ownerLeft} ⚡`)
      // Первая выдача переводит сотрудника на свой кошелёк — карточка обязана это показать.
      if (наОбщем && знак > 0) onMode({ ...sub, balanceMode: 'individual' })
      await load()
    } catch (e) { setNote(e instanceof Error ? e.message : 'Не вышло') }
    finally { setBusy(false) }
  }

  const деньги = (t: number) => (курс && курс > 0 ? ` ≈ $${(t * курс).toFixed(2)}` : '')
  const цена = (k: string, запас: number) => prices[k] ?? запас
  /*
   * Считаем по ВВЕДЁННОЙ сумме, пока в поле что-то есть (правка по приёмке 31.08:
   * «при выдаче должно сразу указывать математику за 100 токенов, и при вводе мы
   * математику пересчитываем с указанными токенами»).
   *
   * Решение принимают ДО нажатия: «сто токенов — это много или мало?» Отвечать на него
   * остатком, который уже у сотрудника, — значит отвечать на другой вопрос. Поле пустое —
   * возвращаемся к его остатку: тогда вопрос снова про «сколько у него есть».
   */
  const введено = Math.max(0, Number(сумма) || 0)
  const считаемПо = введено > 0 ? введено : (свои ?? 0)
  const действий = считаемПо > 0 ? [
    { n: Math.floor(считаемПо / цена('neuro-commenting', 0.05)), what: 'комментариев или сообщений' },
    { n: Math.floor(считаемПо / цена('mass-react', 0.01)), what: 'реакций, просмотров, действий прогрева' },
    { n: Math.floor(считаемПо / цена('parsing', 0.005)), what: 'строк парсинга' },
  ] : []
  const нф = (n: number) => n.toLocaleString('ru-RU')

  /*
   * Заголовок — просто «Токены сотрудника» (правка по приёмке 31.08). Прежний хвост
   * «общий с вашим — токены не выданы» объяснял внутреннее устройство там, где человек
   * ищет одно: сколько у сотрудника токенов. Числа он увидит, раскрыв строку.
   */

  return (
    <div className="mt-1 w-full">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-xs text-white/55 hover:text-white/85">
        <ChevronDown size={13} className={cn('transition-transform', open && 'rotate-180')} />
        Токены сотрудника
      </button>
      {!open ? null : (
      <div className="mt-2 rounded-xl border border-line bg-elevated/40 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-4 text-xs">
          <span className="text-white/45">У сотрудника: <b className="text-fg tabular-nums">{наОбщем ? '—' : `${свои} ⚡`}</b>
            {!наОбщем && <span className="text-white/35">{деньги(свои as number)}</span>}
          </span>
          {/* «Выдано всего» стоит ЛЕВЕЕ «Потрачено» и видно всегда, в том числе нулём:
              это ответ на вопрос «сколько я в него вложил», а он есть и до первой выдачи. */}
          <span className="text-white/45">Выдано всего: <b className="text-fg tabular-nums">{limit?.granted ?? 0} ⚡</b></span>
          <span className="text-white/45">Потрачено: <b className="text-fg tabular-nums">{limit?.spent ?? 0} ⚡</b></span>
          <span className="ml-auto text-white/45">У вас: <b className="text-fg tabular-nums">{мойОстаток ?? '—'} ⚡</b></span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={0}
            max={мойОстаток ?? undefined}
            value={сумма}
            onChange={(e) => setСумма(e.target.value)}
            placeholder="токенов"
            className="input h-8 w-28 text-sm"
          />
          {/* Выдать нельзя больше своего остатка — это и была главная беда старой модели. */}
          <button type="button" disabled={busy || !мойОстаток} onClick={() => void перевод(1)}
            className="btn-primary h-8 px-3 text-xs disabled:opacity-40">Выдать</button>
          <button type="button" disabled={busy || наОбщем || !свои} onClick={() => void перевод(-1)}
            className="btn-ghost h-8 px-3 text-xs disabled:opacity-40">Изъять</button>
          {note && <span className="text-[11px] text-muted">{note}</span>}
        </div>

        <div className="mt-2 text-[11px] leading-relaxed text-white/35">
          Выдача списывается с вашего баланса и появляется у сотрудника — это не потолок, а перевод.
          Больше {мойОстаток ?? 0} ⚡ выдать нельзя: столько у вас есть.
          {' '}Изъятие возвращает токены вам; если часть он уже потратил, вернётся остаток.
        </div>

        {действий.length > 0 && (
          <div className="mt-2 rounded-lg border border-spark-500/20 bg-spark-500/8 px-2.5 py-2 text-[11px] leading-relaxed text-white/60">
            <b className="text-fg">{считаемПо} ⚡{деньги(считаемПо)} — это примерно:</b>
            {/* Говорим, о каком именно числе речь: о вводимой выдаче или об остатке. */}
            <span className="text-white/35">{введено > 0 ? ' (столько собираетесь выдать)' : ' (сейчас у сотрудника)'}</span>
            {действий.map((d) => (
              <span key={d.what} className="block">· до <b className="tabular-nums text-white/80">{нф(d.n)}</b> {d.what}</span>
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  )
}

function SpendByUser() {
  const [rows, setRows] = useState<SpendByUserRow[]>([])
  const [days, setDays] = useState(30)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    void fetchSpendByUser(days)
      .then((r) => { if (alive) { setRows(r.rows); setErr('') } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : 'не загрузилось') })
    return () => { alive = false }
  }, [days])

  if (err) return null
  const total = rows.reduce((sum, r) => sum + r.spent, 0)

  return (
    <Card className="mb-3 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold text-fg">Кто сколько потратил</span>
        <span className="text-[11px] text-white/40">монет за период · всего {Math.round(total * 100) / 100} ⚡</span>
        <div className="ml-auto flex gap-1">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={cn('h-7 rounded-lg px-2.5 text-[11px] font-semibold',
                days === d ? 'bg-spark-500/20 text-spark-300' : 'border border-line text-muted hover:text-fg')}
            >
              {d} дн.
            </button>
          ))}
        </div>
      </div>
      {!rows.length ? (
        <div className="text-xs text-white/40">За этот период списаний не было.</div>
      ) : (
        <div className="space-y-1">
          {rows.map((r) => (
            <div key={r.actorId} className="flex items-center gap-3 rounded-lg bg-elevated px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate text-sm text-fg">
                {r.name}
                {r.isOwner && <span className="ml-2 text-[11px] text-white/35">вы</span>}
              </span>
              {/* Полоска доли: сравнивать числа в столбик глазами тяжелее, чем длины. */}
              <span className="hidden h-1.5 w-28 overflow-hidden rounded-full bg-line sm:block">
                <span className="block h-full rounded-full bg-spark-500" style={{ width: `${total ? (r.spent / total) * 100 : 0}%` }} />
              </span>
              <span className="w-24 shrink-0 text-right text-sm font-semibold tabular-nums text-fg">{Math.round(r.spent * 100) / 100} ⚡</span>
              <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-white/35">{r.ops} оп.</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

export function UsersAndRolesPage() {
  return (
    <div>
      <UsersTab />
      <RolesPage embedded />
    </div>
  )
}
