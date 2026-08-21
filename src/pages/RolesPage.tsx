import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ShieldCheck, Plus, Trash2, ChevronRight, ChevronDown, Save, Lock, Package } from 'lucide-react'
import { PageHeader, Card, EmptyState, Badge, Switch } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import { confirmDialog } from '@/shared/lib/dialog'
import {
  fetchRoles, fetchRbacCatalog, createRole, updateRole, deleteRole, emptyPermissions,
  type Role, type RbacCatalog, type RolePermissions, type Perm,
} from '@/api/rolesApi'
import { ADMIN_BYPASS_ID } from '@/shared/config/rbac'
import { useSession } from '@/features/auth/session'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { WARMING_MODULES } from '@/shared/lib/massAction'

/** Ключ имени роли для сравнения: регистр и лишние пробелы дублем считаться не должны. */
const nameKey = (n: string) => n.trim().toLowerCase()

/**
 * По сколько записей показывать в списках раздела «Пользователи и роли» (просьба владельца
 * 21.08: «максимум по 5 показываем и пагинацию»).
 */
export const PAGE_SIZE = 5

/**
 * Какие номера страниц рисовать. При десятках страниц полный ряд кнопок шире самого списка,
 * поэтому далёкие страницы сворачиваются в «…», а края и соседи текущей остаются кликабельными.
 */
function pageList(page: number, pages: number): (number | '…')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
  const nums = [...new Set([1, page - 1, page, page + 1, pages])]
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b)
  const out: (number | '…')[] = []
  nums.forEach((n, i) => {
    if (i && n - nums[i - 1] > 1) out.push('…')
    out.push(n)
  })
  return out
}

/**
 * Переключатель страниц для обеих вкладок раздела.
 *
 * Живёт здесь, а не в UsersPage: «Пользователи» импортируют эту страницу как вкладку, и
 * обратный импорт замкнул бы модули в цикл.
 *
 * При одной странице не рисуется вовсе (условие владельца): ряд кнопок под списком из трёх
 * человек ничего не переключает и только отвлекает.
 */
export function Pager({ page, total, onPage, label }: {
  page: number
  /** Размер ОТФИЛЬТРОВАННОГО списка — пагинация всегда считается по тому, что видно. */
  total: number
  onPage: (p: number) => void
  /** Родительный падеж для подписи: «пользователей», «шаблонов». */
  label: string
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  if (pages <= 1) return null
  const from = (page - 1) * PAGE_SIZE + 1
  const to = Math.min(page * PAGE_SIZE, total)
  const step = 'rounded-lg border border-line px-2 py-1 text-[11px] text-muted transition-colors hover:border-spark-500/40 hover:text-spark-200 disabled:cursor-default disabled:opacity-30 disabled:hover:border-line disabled:hover:text-muted'
  return (
    <nav className="mt-3 flex flex-wrap items-center gap-1.5" aria-label="Страницы списка">
      <span className="mr-auto text-[11px] text-white/35">{from}–{to} из {total} {label}</span>
      <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1} className={step} aria-label="Предыдущая страница">←</button>
      {pageList(page, pages).map((p, i) => (
        p === '…'
          ? <span key={`gap${i}`} className="px-1 text-[11px] text-white/25">…</span>
          : (
            <button
              key={p}
              type="button"
              onClick={() => onPage(p)}
              aria-current={p === page ? 'page' : undefined}
              className={cn('rounded-lg border px-2 py-1 text-[11px] transition-colors',
                p === page ? 'border-spark-500/50 bg-spark-500/10 text-spark-200' : 'border-line text-muted hover:border-spark-500/40 hover:text-spark-200')}
            >
              {p}
            </button>
          )
      ))}
      <button type="button" onClick={() => onPage(page + 1)} disabled={page >= pages} className={step} aria-label="Следующая страница">→</button>
    </nav>
  )
}

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

export function RolesPage({ embedded }: {
  /**
   * Раздел внутри страницы «Пользователи и роли», а не самостоятельная страница.
   * Тогда вместо шапки страницы рисуется заголовок раздела: двух шапок на одном экране
   * быть не должно — вторая читается как «я провалился в другой раздел».
   *
   * Без пропа страница работает как раньше сама по себе — так её открывает sudo-админка
   * (AdminStatsPage).
   */
  embedded?: boolean
} = {}) {
  /**
   * Для владельца это редактор ШАБЛОНОВ доступа, для админа платформы — прежний редактор
   * ролей. Разница не косметическая: уточнение владельца 21.08 — «роль это просто как шаблон
   * и все настроек которые уже были выбраны». Роль ничего не выдаёт сама по себе; её набор
   * КОПИРУЕТСЯ в личные тумблеры сотрудника на странице «Пользователи» и дальше не участвует.
   * Отсюда и разные подписи: говорить владельцу «роль решает, что видит суб» теперь неправда.
   *
   * Каталог модулей приходит владельцу урезанным по его подписке — молчать об этом нельзя,
   * иначе пропавший модуль читается как поломка.
   */
  const sessionUser = useSession((s) => s.user)
  const isPlatformAdmin = !!sessionUser?.isAdmin
  // Переход из «Пользователей»: ?role=<id> сразу открывает роль, которую там назначили,
  // чтобы владелец не искал её глазами в списке (у него их бывает несколько десятков).
  const [searchParams] = useSearchParams()
  const wantRoleId = searchParams.get('role') || ''
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
  /** Страница списка ролей (по PAGE_SIZE штук). Ставится явно там, где выбор уезжает
      на другую страницу: открытие раздела по ?role= и создание нового шаблона. */
  const [rolePage, setRolePage] = useState(1)

  const selected = useMemo(() => roles.find((r) => r.id === selId) || null, [roles, selId])
  const isAdminRole = selected?.builtin && selected.id === ADMIN_BYPASS_ID

  async function load() {
    setLoading(true)
    try {
      const [rs, cat] = await Promise.all([fetchRoles(), fetchRbacCatalog()])
      setRoles(rs)
      setCatalog(cat)
      if (!selId && rs.length) {
        const first = rs.find((r) => r.id === wantRoleId) || rs[0]
        // Роль из ?role= может лежать на второй-третьей странице списка — открываем сразу ту,
        // иначе выбранная роль редактируется, а в списке её не видно.
        setRolePage(Math.floor(rs.indexOf(first) / PAGE_SIZE) + 1)
        selectRole(first)
      }
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

  /**
   * Занято ли имя другой ролью.
   *
   * У владельца в списке накопились «Тимлид», «Уволенный» и «Без чужих задач» по три раза
   * (прогон 21.08): в дропдауне «Пользователей» такие роли не отличить друг от друга, и
   * человеку назначают не ту. Поэтому повтор имени теперь не сохраняется.
   */
  const nameTaken = (n: string, exceptId?: string) =>
    roles.some((r) => r.id !== exceptId && nameKey(r.name) === nameKey(n))

  /** Имена, встречающиеся больше одного раза — помечаем в списке, чтобы мусор было видно. */
  const dupNames = useMemo(() => {
    const count = new Map<string, number>()
    roles.forEach((r) => count.set(nameKey(r.name), (count.get(nameKey(r.name)) ?? 0) + 1))
    return new Set([...count].filter(([, c]) => c > 1).map(([k]) => k))
  }, [roles])

  /** Ошибка имени текущей роли — показываем сразу под полем, а не после отказа сохранения. */
  const nameErr = !name.trim()
    ? 'Название не может быть пустым'
    : nameTaken(name, selId) ? 'Роль с таким именем уже есть' : ''

  async function addRole() {
    try {
      // Номер ищем свободный, а не по длине списка: после удалений длина повторяется и
      // так появились «Новая роль 5» в двух экземплярах.
      const base = isPlatformAdmin ? 'Новая роль' : 'Новый шаблон'
      let n = roles.length + 1
      while (nameTaken(`${base} ${n}`)) n += 1
      const r = await createRole({ name: `${base} ${n}`, permissions: emptyPermissions() })
      setRoles((prev) => [...prev, r])
      // Новый шаблон дописывается в конец — перелистываем на последнюю страницу, иначе
      // кнопка «Создать» открывает редактор, а в списке ничего не появляется.
      setRolePage(Math.ceil((roles.length + 1) / PAGE_SIZE))
      selectRole(r)
    } catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка') }
  }

  async function removeRole(r: Role) {
    if (r.builtin) return
    // Владельцу пугать нечем: его роль — заготовка, её значения давно скопированы в личные
    // настройки сотрудников и удаление шаблона их не трогает. У админа платформы роли
    // по-прежнему живые (в т.ч. персональные роли субов), там предупреждение остаётся.
    const message = isPlatformAdmin
      ? `«${r.name}» будет удалена безвозвратно. Пользователи с этой ролью потеряют её доступы.`
      : `Шаблон «${r.name}» будет удалён безвозвратно. На уже выданные доступы это не влияет — они скопированы в настройки сотрудников.`
    if (!(await confirmDialog({ title: isPlatformAdmin ? 'Удалить роль?' : 'Удалить шаблон?', message, confirmLabel: 'Удалить', tone: 'danger' }))) return
    try {
      await deleteRole(r.id)
      const next = roles.filter((x) => x.id !== r.id)
      setRoles(next)
      if (selId === r.id) { setSelId(''); if (next[0]) selectRole(next[0]) }
    } catch (e) { setErr(e instanceof Error ? e.message : 'Ошибка') }
  }

  async function save() {
    if (!selected) return
    if (nameErr) { setErr(`${nameErr}. Дайте роли имя, по которому её узнают в списке пользователей.`); return }
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

  // Страница списка. Считаем «безопасную» на лету: после удаления последнего шаблона на
  // третьей странице сама страница исчезает, и запомненный номер показал бы пустоту.
  const rolePages = Math.max(1, Math.ceil(roles.length / PAGE_SIZE))
  const rolePageSafe = Math.min(rolePage, rolePages)
  const shownRoles = roles.slice((rolePageSafe - 1) * PAGE_SIZE, rolePageSafe * PAGE_SIZE)

  const title = isPlatformAdmin ? 'Роли и доступы' : 'Шаблоны доступа'
  const subtitle = isPlatformAdmin
    ? 'Роли и доступ к модулям, блокам и ресурсам. Снятый доступ выделен.'
    : 'Шаблон — заготовка доступа: собрали набор модулей один раз и применяете его сотруднику в его карточке выше. Дальше доступ каждого правится отдельно. Выдать можно только оплаченное.'
  const addLabel = isPlatformAdmin ? 'Новая роль' : 'Создать шаблон'

  return (
    <div id="templates">
      {embedded ? (
        // Заголовок РАЗДЕЛА: то же содержание, что в шапке страницы, но тише по весу и с
        // чертой сверху — граница нужна, иначе шаблоны читаются как продолжение списка людей.
        <div className="mt-8 flex flex-wrap items-start justify-between gap-3 border-t border-line pt-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ShieldCheck size={18} className="shrink-0 text-spark-300" />
              <h2 className="text-lg font-semibold">{title}</h2>
              {roles.length ? <Badge>{roles.length}</Badge> : null}
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            <HelpButton topic="rbac-roles" className="h-9 w-9" />
            <button onClick={() => void addRole()} className="btn-primary h-9 text-sm">
              <Plus size={15} /> {addLabel}
            </button>
          </div>
        </div>
      ) : (
        <PageHeader
          title={title}
          subtitle={subtitle}
          icon={<ShieldCheck size={22} />}
          badge={roles.length ? `${roles.length}` : undefined}
          actions={
            <div className="flex items-center gap-2">
              <HelpButton topic="rbac-roles" className="h-10 w-10" />
              <button onClick={() => void addRole()} className="btn-primary h-10">
                <Plus size={16} /> {addLabel}
              </button>
            </div>
          }
        />
      )}

      {err && <Card className="mb-3 border-rose-500/30 p-3 text-sm text-rose-300">{err}</Card>}

      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : roles.length === 0 ? (
        /*
         * Пустой список у владельца — норма, а не сбой: сервер отдаёт ему ТОЛЬКО им же
         * созданные роли (уточнение 21.08 «показывать только созданные роли»), а раньше
         * список начинался с чужих системных «Оператор»/«Sales». Поэтому здесь не голое
         * «ролей нет», а объяснение, зачем шаблон вообще нужен: без него доступ каждому
         * новому сотруднику выставляется тумблерами заново.
         */
        <EmptyState
          icon={<ShieldCheck size={26} />}
          title={isPlatformAdmin ? 'Ролей пока нет' : 'У вас пока нет шаблонов доступа'}
          desc={isPlatformAdmin
            ? 'Создайте первую роль и раздайте ей доступы.'
            : 'Шаблон нужен, чтобы выдавать новым сотрудникам одинаковый набор модулей одним кликом, а не собирать его тумблерами каждый раз.'}
          action={
            <button onClick={() => void addRole()} className="btn-primary h-10">
              <Plus size={16} /> {isPlatformAdmin ? 'Создать роль' : 'Создать шаблон'}
            </button>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          {/* Список ролей — по PAGE_SIZE на страницу */}
          <div>
            <div className="flex flex-col gap-2">
            {shownRoles.map((r) => (
              <button
                key={r.id}
                onClick={() => selectRole(r)}
                className={`group flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left transition ${selId === r.id ? 'border-spark-500/50 bg-spark-500/10' : 'border-line bg-elevated hover:border-spark-500/30'}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-fg">{r.name}</span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {r.builtin && <Badge tone="iris">Встроенная</Badge>}
                    {/* Метку «Шаблон» показываем только админу платформы: у владельца ВСЕ
                        роли в списке — заготовки (уточнение 21.08), и badge на части из них
                        обещал бы разницу, которой больше нет. */}
                    {isPlatformAdmin && r.isTemplate && <Badge tone="amber">Шаблон</Badge>}
                    {/* Одинаковые имена в списке = невозможно выбрать нужную роль на вкладке «Пользователи». */}
                    {dupNames.has(nameKey(r.name)) && <Badge tone="rose">имя-дубль</Badge>}
                  </span>
                </span>
                {!r.builtin && (
                  <span onClick={(e) => { e.stopPropagation(); void removeRole(r) }} className="btn-icon-danger h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100" aria-label="Удалить роль" title="Удалить роль"><Trash2 size={13} /></span>
                )}
              </button>
            ))}
            </div>
            <Pager page={rolePageSafe} total={roles.length} onPage={setRolePage} label={isPlatformAdmin ? 'ролей' : 'шаблонов'} />
          </div>

          {/* Редактор выбранной роли */}
          {selected && (
            <Card className="p-4">
              <div className={`flex flex-wrap items-center gap-3 ${nameErr ? 'mb-1' : 'mb-4'}`}>
                <input
                  value={name}
                  onChange={(e) => { setName(e.target.value); mark() }}
                  className={`h-10 flex-1 rounded-lg border bg-elevated px-3 text-sm text-fg outline-none ${nameErr ? 'border-rose-500/50' : 'border-line focus:border-spark-500/50'}`}
                  placeholder="Название роли"
                />
                {/* Флажок «Шаблон» — про системные заготовки платформы, и владельцу он
                    бессмыслен: его роли и так шаблоны, других он не создаёт. Значение при
                    сохранении уходит нетронутым (оно взято из самой роли). */}
                {isPlatformAdmin && (
                  <label className="flex items-center gap-2 text-sm text-white/70">
                    <input type="checkbox" className="accent-amber-500" checked={isTemplate} onChange={(e) => { setIsTemplate(e.target.checked); mark() }} />
                    Шаблон
                  </label>
                )}
                <button onClick={() => void save()} disabled={!dirty || saving || !!nameErr} className="btn-primary h-10 disabled:opacity-40">
                  <Save size={15} /> {saving ? 'Сохранение…' : 'Сохранить'}
                </button>
              </div>
              {nameErr && <div className="mb-4 text-[11px] text-rose-300">{nameErr} — по имени шаблон выбирают на вкладке «Пользователи».</div>}

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
                    {!isPlatformAdmin && (catalog.modules.length > 0 ? (
                      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-white/40">
                        <Package size={12} className="shrink-0" />
                        Показаны модули из вашей подписки — выдать роли можно только то, что оплачено.
                        <Link to="/panel/user/subscription" className="font-semibold text-spark-300 hover:text-spark-200">Подписки</Link>
                      </div>
                    ) : (
                      // Пустая подписка даёт пустой каталог, и без объяснения раздел выглядит
                      // сломанным: заголовок «Модули и блоки» есть, а под ним ничего.
                      <div className="mb-2 rounded-lg border border-line bg-elevated/40 px-3 py-2.5 text-xs text-white/50">
                        В вашей подписке нет активных модулей — собирать шаблон пока не из чего.{' '}
                        <Link to="/panel/user/subscription" className="font-semibold text-spark-300 hover:text-spark-200">Открыть «Подписки»</Link>
                      </div>
                    ))}
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
                      <div className="mb-2 text-[11px] text-white/35">«Мой аккаунт» и «Поддержка» доступны всем всегда. «Роли и доступы» / «Пользователи» — только владельцу пространства и админу платформы: субпользователю их не выдать ни шаблоном, ни вручную.</div>
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
