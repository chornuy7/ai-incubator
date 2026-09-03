import { useEffect, useState } from 'react'
import { Target, Plus, Pencil, Trash2, X, Copy, Rocket } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Badge, Select } from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { confirmDialog } from '@/shared/lib/dialog'
import {
  fetchGoals, createGoal, updateGoal, deleteGoal,
  fetchGoalProgress,
  METRIC_LABELS, LEAD_TARGET_MAX,
  GOAL_STATUSES, GOAL_STATUS_LABELS, GOAL_PRIORITIES, GOAL_PRIORITY_LABELS,
  type Goal, type GoalInput, type MetricKind, type GoalProgress, type GoalStatus, type GoalPriority,
} from '@/api/goalsApi'
import { fetchCampaigns, type Campaign } from '@/api/campaignsApi'

const EMPTY: GoalInput = {
  name: '', description: '', metric: { kind: 'leads', target: 0, unit: '' },
  status: 'active', priority: 'mid', period: { mode: 'all', from: null },
}

/**
 * «Цели» — СЧЁТЧИК результата, и ничего больше.
 *
 * Решения звонков 22.07 и 24.07 (docs/SPEC-2026-07-22, §1):
 *   тон, запреты, характер, язык, аудитория, критерий завершения, база знаний → АГЕНТ
 *   дожим, дедлайн, каналы, модули, этапы                                     → КАМПАНИЯ
 * Прямая цитата заказчика: «Цель нахуй не знает ни про модули, ни про общение,
 * ни про тон. Она и про группы, по сути, ничего знать не должна.»
 *
 * Здесь остаётся: что хотим получить (словами), что считаем и сколько нужно.
 * Счёт цель ведёт сама и отдаёт его кампаниям для статистики.
 */
export function GoalsPage() {
  const pushToast = useApp((s) => s.pushToast)
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<GoalInput | null>(null)
  const [saving, setSaving] = useState(false)
  /** Счётчики целей. Считает сервер: тот же счёт читает статистика кампаний. */
  const [progress, setProgress] = useState<Record<string, GoalProgress>>({})
  /** Кампании цели: счёт отдаётся им для статистики. */
  const [campaignsByGoal, setCampaignsByGoal] = useState<Record<string, Campaign[]>>({})

  const load = async () => {
    setLoading(true)
    try {
      setGoals(await fetchGoals())
      void fetchGoalProgress().then(setProgress).catch(() => {})
      void fetchCampaigns().then(({ campaigns }) => {
        const by: Record<string, Campaign[]> = {}
        for (const c of campaigns) if (c.goalId) (by[c.goalId] ||= []).push(c)
        setCampaignsByGoal(by)
      }).catch(() => {})
    } catch (err) {
      pushToast({ type: 'error', title: 'Не удалось загрузить цели', desc: err instanceof Error ? err.message : '' })
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const set = (patch: Partial<GoalInput>) => setForm((f) => ({ ...(f as GoalInput), ...patch }))
  const setMetric = (patch: Partial<NonNullable<GoalInput['metric']>>) =>
    setForm((f) => ({ ...(f as GoalInput), metric: { ...(f?.metric || {}), ...patch } }))

  const openNew = () => { setEditingId(null); setForm({ ...EMPTY, metric: { ...EMPTY.metric! } }) }
  const openEdit = (g: Goal) => {
    setEditingId(g.id)
    setForm({ name: g.name, description: g.description, metric: { ...g.metric } })
  }

  const save = async () => {
    if (!form?.name.trim()) return pushToast({ type: 'error', title: 'Укажите название цели' })
    setSaving(true)
    try {
      if (editingId) { await updateGoal(editingId, form); pushToast({ type: 'success', title: 'Цель сохранена' }) }
      else { await createGoal(form); pushToast({ type: 'success', title: 'Цель создана' }) }
      setForm(null); setEditingId(null); await load()
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка сохранения', desc: e instanceof Error ? e.message : '' })
    } finally { setSaving(false) }
  }

  const duplicate = async (g: Goal) => {
    try {
      await createGoal({ name: `${g.name} — копия`, description: g.description, metric: g.metric })
      pushToast({ type: 'success', title: 'Цель скопирована' })
      await load()
    } catch (e) { pushToast({ type: 'error', title: 'Не удалось скопировать', desc: e instanceof Error ? e.message : '' }) }
  }

  const remove = async (g: Goal) => {
    const used = campaignsByGoal[g.id]?.length || 0
    if (!(await confirmDialog({
      title: 'Удалить цель?',
      message: used
        ? `«${g.name}» используют ${used} кампани(й) — они останутся без цели.`
        : `«${g.name}» будет удалена.`,
      confirmLabel: 'Удалить',
      tone: 'danger',
    }))) return
    try { await deleteGoal(g.id); pushToast({ type: 'success', title: 'Цель удалена' }); await load() }
    catch (e) { pushToast({ type: 'error', title: 'Ошибка удаления', desc: e instanceof Error ? e.message : '' }) }
  }

  // ── Форма ──
  if (form) {
    const kind = (form.metric?.kind || 'leads') as MetricKind
    return (
      <div>
        <button onClick={() => { setForm(null); setEditingId(null) }} className="btn-ghost mb-3 h-9"><X size={15} /> Назад к целям</button>
        <PageHeader
          title={editingId ? 'Изменить цель' : 'Новая цель'}
          subtitle="Цель — это счётчик: что нужно получить и сколько. Как разговаривать — у агента, сроки и модули — у кампании."
          icon={<Target size={22} />}
        />
        <Card className="space-y-4 p-4">
          <div>
            <label className="mb-1 block text-xs text-white/50">Название *</label>
            <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Напр. Продвижение крипто-канала" />
          </div>

          {/* «Что хочу получить своими словами» убрано: этот текст уходил в ИИ, а цель
              не должна руководить агентом. Как разговаривать и первое сообщение — у Агента. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-white/50">Статус</label>
              <Select
                value={form.status || 'active'}
                onChange={(v) => set({ status: v as GoalStatus })}
                options={GOAL_STATUSES.map((s) => ({ value: s, label: GOAL_STATUS_LABELS[s] }))}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-white/50">Приоритет</label>
              <Select
                value={form.priority || 'mid'}
                onChange={(v) => set({ priority: v as GoalPriority })}
                options={GOAL_PRIORITIES.map((p) => ({ value: p, label: GOAL_PRIORITY_LABELS[p] }))}
              />
            </div>
          </div>

          {/* Измеримый результат — «число + единица» (SPEC §1.1). Без него цель не
              сможет честно сказать «достигнута». */}
          <div className="rounded-lg border border-white/10 p-3">
            <div className="mb-2 text-sm font-semibold text-fg">Измеримый результат</div>
            <div className="grid gap-3 sm:grid-cols-[1fr_140px_1fr]">
              <div>
                <label className="mb-1 block text-xs text-white/50">Что считаем</label>
                <Select
                  value={kind}
                  onChange={(v) => setMetric({ kind: v as MetricKind, unit: '' })}
                  options={(Object.keys(METRIC_LABELS) as MetricKind[]).map((k) => ({ value: k, label: METRIC_LABELS[k] }))}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-white/50">Сколько нужно</label>
                <input
                  type="number" min={0} max={LEAD_TARGET_MAX} className="input"
                  value={form.metric?.target || 0}
                  onChange={(e) => setMetric({ target: Math.min(LEAD_TARGET_MAX, Math.max(0, Number(e.target.value) || 0)) })}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-white/50">Единица <span className="text-white/30">(пусто — как слева)</span></label>
                <input
                  className="input"
                  value={form.metric?.unit || ''}
                  onChange={(e) => setMetric({ unit: e.target.value })}
                  placeholder={METRIC_LABELS[kind]}
                />
              </div>
            </div>
            {kind !== 'leads' && (
              <p className="mt-2 text-xs text-amber-300/80">
                Автоматически система считает пока только горячих лидов (из CRM).
                Остальное нужно подтверждать счётчиком — переходы по ссылке считаются
                через нашу короткую ссылку.
              </p>
            )}
            {/* Период учёта: за какой срок считается счётчик. Раньше всегда «за всё время». */}
            <div className="mt-3 border-t border-white/10 pt-3">
              <label className="mb-1 block text-xs text-white/50">Период учёта <span className="text-white/30">— за какой срок считаем результат</span></label>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={form.period?.mode || 'all'}
                  onChange={(v) => set({ period: { mode: v as 'all' | 'from', from: v === 'from' ? (form.period?.from || '') : null } })}
                  className="w-52"
                  options={[{ value: 'all', label: 'За всё время' }, { value: 'from', label: 'С даты' }]}
                />
                {form.period?.mode === 'from' && (
                  <input
                    type="date"
                    className="input h-9 max-w-[200px]"
                    value={form.period?.from || ''}
                    onChange={(e) => set({ period: { mode: 'from', from: e.target.value } })}
                  />
                )}
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={() => { setForm(null); setEditingId(null) }} className="btn-ghost h-10">Отмена</button>
            <button onClick={() => void save()} disabled={saving} className="btn-primary h-10">{editingId ? 'Сохранить' : 'Создать'}</button>
          </div>
        </Card>
      </div>
    )
  }

  // ── Список ──
  return (
    <div>
      <PageHeader
        title="Цели"
        subtitle="Цель = измеримый результат: что получить и сколько. Счёт ведётся здесь и уходит в кампании для статистики."
        icon={<Target size={22} />}
        actions={<div className="flex items-center gap-2"><HelpButton topic="goals" className="h-10 w-10" /><button onClick={openNew} className="btn-primary h-10"><Plus size={16} /> Новая цель</button></div>}
      />

      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : goals.length === 0 ? (
        <EmptyState
          icon={<Target size={26} />}
          title="Целей пока нет"
          desc="Цель — это счётчик результата: «200 переходов по ссылке», «80 горячих лидов». Кампании работают к ней и отчитываются в неё."
          action={<button onClick={openNew} className="btn-primary h-10"><Plus size={16} /> Создать цель</button>}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {goals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              progress={progress[g.id]}
              campaigns={campaignsByGoal[g.id] || []}
              onEdit={() => openEdit(g)}
              onCopy={() => void duplicate(g)}
              onRemove={() => void remove(g)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** Карточка цели: имя, желание словами и сам счётчик с прогрессом. */
function GoalCard(props: {
  goal: Goal
  progress?: GoalProgress
  campaigns: Campaign[]
  onEdit: () => void
  onCopy: () => void
  onRemove: () => void
}) {
  const { goal: g, progress: p, campaigns } = props
  const target = p?.target ?? g.metric?.target ?? 0
  const unit = p?.unit || g.metric?.unit || METRIC_LABELS[g.metric?.kind || 'leads']
  const done = p?.done ?? 0
  // Считать умеем не всё: для видов без счётчика показываем только план, чтобы не
  // рисовать «0 из 200» там, где нечем мерить, и не выдавать это за факт.
  const counted = p?.counted ?? false
  const pct = p?.pct ?? 0

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 truncate font-semibold text-white">{g.name}</div>
        <div className="flex shrink-0 gap-1">
          <button onClick={props.onEdit} className="btn-icon h-8 w-8" aria-label="Изменить"><Pencil size={14} /></button>
          <button onClick={props.onCopy} className="btn-icon h-8 w-8" aria-label="Дублировать цель" title="Дублировать цель"><Copy size={14} /></button>
          <button onClick={props.onRemove} className="btn-icon-danger h-8 w-8" aria-label="Удалить цель" title="Удалить цель"><Trash2 size={14} /></button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={g.status === 'active' ? 'spark' : g.status === 'achieved' ? 'iris' : 'muted'}>
          {GOAL_STATUS_LABELS[g.status || 'active']}
        </Badge>
        <Badge tone={g.priority === 'high' ? 'amber' : 'muted'}>
          приоритет: {GOAL_PRIORITY_LABELS[g.priority || 'mid'].toLowerCase()}
        </Badge>
        {g.period?.mode === 'from' && g.period.from && (
          <span className="text-xs text-white/40">учёт с {g.period.from}</span>
        )}
      </div>

      {target > 0 ? (
        <div>
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-white/50">{counted ? 'Набрано' : 'Нужно набрать'}</span>
            <span className="font-mono text-white">
              {counted && <span className="text-spark-300">{done}</span>}
              {counted && ' / '}{target} <span className="text-white/40">{unit}</span>
            </span>
          </div>
          {counted && (
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-spark-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      ) : (
        <span className="text-xs text-amber-300/80">Не задано, сколько нужно — цель не сможет завершиться сама</span>
      )}

      {/* Дожатые — отдельная цифра: эти люди прошли другой путь (написали сами
          после закрытия), и складывать их с остальными значит не понимать, что
          сработало. Уходит в статистику кампании. */}
      {(p?.followUpsDone ?? 0) > 0 && (
        <span className="text-xs text-iris-300" title="Люди, которых довели дожимом: диалог был закрыт, но они написали сами">
          дожато: {p!.followUpsDone}
        </span>
      )}

      {campaigns.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-t border-line pt-2">
          <Rocket size={11} className="text-spark-400" />
          <span className="mr-1 text-xs text-white/40">кампании:</span>
          {campaigns.map((c) => <Badge key={c.id} tone="muted">{c.name}</Badge>)}
        </div>
      )}
    </Card>
  )
}
