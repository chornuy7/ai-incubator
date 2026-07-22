import { useEffect, useMemo, useState } from 'react'
import {
  CalendarClock, Plus, Play, Trash2, Pencil, Power, Clock, Loader2, ArrowLeft } from 'lucide-react'
import { PageHeader, Card, Select, Segmented, Switch, EmptyState, Badge } from '@/shared/ui'
import { fetchCampaigns, type Campaign } from '@/api/campaignsApi'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { confirmDialog } from '@/shared/lib/dialog'
import { AccountPicker } from '@/features/account-picker/AccountPicker'
import { NumberField, FolderPicker } from '@/features/modules/shared'
import { MODULES, isCombatModule, combatConfirmText } from '@/shared/config/modules'
import { useApp } from '@/mocks/store'
import {
  fetchAutomationRules, createAutomationRule, updateAutomationRule, deleteAutomationRule, runAutomationRuleNow,
  type AutomationRule, type AutomationRuleInput,
} from '@/api/automationApi'

// Планировщик умеет запускать любой модуль из реестра (server/modules/registry.js) — включая парсеры.
const AUTOMATABLE = [
  'neuro-commenting', 'neuro-chatting', 'mass-react', 'mass-looking', 'warming', 'neuro-dialogs', 'ggr',
  'mailing', 'autoposting', 'parsing', 'parsing-groups', 'parsing-users', 'parsing-messages', 'parsing-comments',
]
// Модули, которым нужны цели (каналы/группы/номера) — server MODULE_DEFS.requiresTargets.
const NEEDS_TARGETS = new Set([
  'neuro-commenting', 'neuro-chatting', 'mass-react', 'mass-looking',
  'mailing', 'autoposting', 'parsing-users', 'parsing-messages', 'parsing-comments',
])

const SCHEDULE_TYPES = ['Разово', 'Интервал', 'Ежедневно']

function fmt(ts: number | null | undefined) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function scheduleLabel(r: AutomationRule) {
  const s = r.schedule
  if (s.type === 'once') return `Разово · ${fmt(s.at)}`
  if (s.type === 'interval') return `Каждые ${s.intervalMinutes} мин`
  if (s.type === 'daily') return `Ежедневно в ${s.time}`
  return '—'
}

export function AutomationPage() {
  const pushToast = useApp((s) => s.pushToast)
  const [rules, setRules] = useState<AutomationRule[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<AutomationRule | 'new' | null>(null)

  const reload = async () => {
    try { setRules(await fetchAutomationRules()) } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось загрузить правила', desc: e instanceof Error ? e.message : '' })
    } finally { setLoading(false) }
  }
  useEffect(() => { void reload() }, [])

  const toggleEnabled = async (r: AutomationRule) => {
    try { await updateAutomationRule(r.id, { enabled: !r.enabled }); await reload() } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' })
    }
  }

  const remove = async (r: AutomationRule) => {
    if (!(await confirmDialog({ title: 'Удалить правило?', message: `«${r.name}» будет удалено.`, confirmLabel: 'Удалить', tone: 'danger' }))) return
    try { await deleteAutomationRule(r.id); await reload(); pushToast({ type: 'success', title: 'Правило удалено' }) } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' })
    }
  }

  const runNow = async (r: AutomationRule) => {
    // Досрочный запуск правила = те же реальные действия в Telegram, что и запуск из
    // модуля. Там подтверждение спрашивают (LiveModule, TasksPage), а здесь кнопка ▶
    // стреляла сразу (прогон 21–22.07, тест 6.12).
    const mk = r.moduleKey || ''
    if (isCombatModule(mk) && !(await confirmDialog({
      title: 'Реальные действия в Telegram',
      message: combatConfirmText(mk),
      confirmLabel: 'Запустить',
      tone: 'danger',
    }))) return
    try {
      const taskId = await runAutomationRuleNow(r.id)
      await reload()
      pushToast({ type: 'success', title: 'Запущено', desc: `Задача ${taskId}` })
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось запустить', desc: e instanceof Error ? e.message : '' })
    }
  }

  return (
    <div>
      <PageHeader
        title="Автоматизация"
        subtitle="Планирование запусков модулей по времени: выберите аккаунты, модуль и расписание"
        icon={<CalendarClock size={22} />}
        actions={<div className="flex items-center gap-2"><HelpButton topic="automation" className="h-10 w-10" /><button onClick={() => setEditing('new')} className="btn-primary h-10"><Plus size={16} /> Новое правило</button></div>}
      />

      {loading ? (
        <div className="card p-6"><Loader2 className="animate-spin text-muted" /></div>
      ) : rules.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<CalendarClock size={26} />}
            title="Нет правил автоматизации"
            desc="Создайте правило, чтобы запускать модуль по расписанию (разово, по интервалу или ежедневно)."
            action={<button onClick={() => setEditing('new')} className="btn-primary h-10"><Plus size={16} /> Новое правило</button>}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((r) => (
            <div key={r.id} className="card flex flex-wrap items-center gap-4 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-display text-base font-bold text-fg">{r.name}</span>
                  <Badge tone={r.enabled ? 'spark' : 'muted'}>{r.enabled ? 'Активно' : 'Выкл'}</Badge>
                  <Badge tone="iris">{MODULES[r.moduleKey]?.title ?? r.moduleKey}</Badge>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  <span className="flex items-center gap-1"><Clock size={12} /> {scheduleLabel(r)}</span>
                  <span>Аккаунтов: {r.accountIds.length}</span>
                  <span>След. запуск: {fmt(r.nextRun)}</span>
                  <span>Посл. запуск: {fmt(r.lastRun)}{r.lastStatus ? ` (${r.lastStatus})` : ''}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={r.enabled} onChange={() => toggleEnabled(r)} />
                <button onClick={() => runNow(r)} className="btn-icon h-9 w-9" title="Запустить сейчас"><Play size={15} /></button>
                <button onClick={() => setEditing(r)} className="btn-icon h-9 w-9" title="Редактировать"><Pencil size={15} /></button>
                <button onClick={() => remove(r)} className="btn-icon h-9 w-9 text-rose-300" title="Удалить"><Trash2 size={15} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <RuleEditor
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload() }}
        />
      )}
    </div>
  )
}

function RuleEditor({ rule, onClose, onSaved }: {
  rule: AutomationRule | null; onClose: () => void; onSaved: () => Promise<void>
}) {
  const pushToast = useApp((s) => s.pushToast)
  const [name, setName] = useState(rule?.name ?? '')
  const [moduleKey, setModuleKey] = useState(rule?.moduleKey ?? AUTOMATABLE[0])
  // §6: правило крепится к кампании — модуль/аккаунты/пресет берутся из неё.
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [campaignId, setCampaignId] = useState(rule?.campaignId ?? '')
  useEffect(() => {
    void fetchCampaigns().then(({ campaigns: cs }) => setCampaigns(cs.filter((c) => c.status !== 'done'))).catch(() => {})
  }, [])
  const [selected, setSelected] = useState<Set<string>>(new Set(rule?.accountIds ?? []))
  const [targetsText, setTargetsText] = useState((rule?.settings?.targets ?? []).join('\n'))
  const [maxActions, setMaxActions] = useState(rule?.settings?.maxActions ?? 50)
  const [minActions, setMinActions] = useState(rule?.settings?.minActions ?? 0)
  const [maxPerAccount, setMaxPerAccount] = useState(rule?.settings?.maxPerAccount ?? 10)
  const [scheduleType, setScheduleType] = useState(rule?.schedule?.type === 'once' ? 0 : rule?.schedule?.type === 'daily' ? 2 : 1)
  const [intervalMinutes, setIntervalMinutes] = useState(rule?.schedule?.intervalMinutes ?? 60)
  const [dailyTime, setDailyTime] = useState(rule?.schedule?.time ?? '12:00')
  const [onceAt, setOnceAt] = useState(() => {
    const d = rule?.schedule?.at ? new Date(rule.schedule.at) : new Date(Date.now() + 3600_000)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  })
  const [saving, setSaving] = useState(false)

  const needsTargets = useMemo(() => NEEDS_TARGETS.has(moduleKey), [moduleKey])

  const save = async () => {
    // При выбранной кампании аккаунты НЕ обязательны: resolveRuleTarget
    // (automation/store.js) сам возьмёт закреплённые за кампанией, если у правила
    // своих нет. Раньше форма требовала их вручную, хотя подсказка обещала «модуль,
    // аккаунты и пресет — из кампании» — бэкенд это умел, а UI не пускал (тест 6.10).
    if (!campaignId && !selected.size) return pushToast({ type: 'error', title: 'Выберите аккаунты' })
    const targets = targetsText.split(/[\n,\s]+/).map((s) => s.trim().replace(/^@/, '')).filter(Boolean)
    if (needsTargets && !targets.length) return pushToast({ type: 'error', title: 'Добавьте цели' })
    if (minActions && maxActions && minActions > maxActions) return pushToast({ type: 'error', title: 'Минимум больше максимума' })

    const schedule = scheduleType === 0
      ? { type: 'once' as const, at: new Date(onceAt).getTime() }
      : scheduleType === 2
        ? { type: 'daily' as const, time: dailyTime }
        : { type: 'interval' as const, intervalMinutes }

    const input: AutomationRuleInput = {
      name: name.trim() || 'Правило автоматизации',
      moduleKey,
      campaignId: campaignId || null,
      accountIds: [...selected],
      settings: {
        targets,
        channels: targets,
        maxActions,
        maxComments: maxActions,
        minActions,
        minComments: minActions,
        maxPerAccount,
        aiProtection: true,
        protectionLevel: 1,
        delayPreset: 1,
      },
      schedule,
    }

    setSaving(true)
    try {
      if (rule) await updateAutomationRule(rule.id, input)
      else await createAutomationRule(input)
      pushToast({ type: 'success', title: rule ? 'Правило обновлено' : 'Правило создано' })
      await onSaved()
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' })
    } finally { setSaving(false) }
  }

  // §6: правило открывается вьюшкой, а не модалкой поверх списка.
  return (
    <div>
      <button onClick={onClose} className="btn-ghost mb-3 h-9"><ArrowLeft size={15} /> Назад к автоматизации</button>
      <PageHeader
        title={rule ? 'Редактировать правило' : 'Новое правило автоматизации'}
        subtitle="Правило крепится к кампании: модуль, аккаунты и пресет берутся из неё"
        icon={<CalendarClock size={22} />}
      />
      <Card className="p-4">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Название</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="Утренний прогрев" />
          </div>
          <div>
            <label className="label">Кампания <span className="font-normal normal-case text-faint">(§6 — модуль и аккаунты возьмутся из неё)</span></label>
            <Select
              value={campaignId}
              onChange={setCampaignId}
              placeholder="Без кампании (голый модуль)"
              options={[{ value: '', label: 'Без кампании (голый модуль)' }, ...campaigns.map((c) => ({ value: c.id, label: `${c.name} · ${MODULES[c.moduleKey]?.title ?? c.moduleKey}` }))]}
            />
            {campaignId && (() => {
              const c = campaigns.find((x) => x.id === campaignId)
              const n = (c?.accountIds || []).length
              return (
                <p className="mt-1 text-[11px] text-muted">
                  Модуль, аккаунты и пресет — из кампании ({n ? `${n} акк.` : 'аккаунтов пока нет'}).
                  Настройки ниже перекроют пресет кампании; выбирать аккаунты вручную не обязательно —
                  но если выберете, они будут приоритетнее.
                </p>
              )
            })()}
            <label className="label mt-3">Модуль{campaignId ? ' (из кампании)' : ''}</label>
            <Select value={campaignId ? (campaigns.find((c) => c.id === campaignId)?.moduleKey ?? moduleKey) : moduleKey} onChange={setModuleKey} options={AUTOMATABLE.map((k) => ({ value: k, label: MODULES[k]?.title ?? k }))} />
          </div>
        </div>

        <AccountPicker selected={selected} onChange={setSelected} selectedTitle="Аккаунты для правила" />

        {needsTargets && (
          <div>
            <label className="label">Цели (каналы/группы) — из папки или по одному на строку</label>
            <FolderPicker
              targets={targetsText.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean)}
              onLoad={(t) => setTargetsText((prev) => {
                const cur = prev.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean)
                return [...new Set([...t.map((x) => x.replace(/^@/, '')), ...cur])].join('\n')
              })}
            />
            <textarea value={targetsText} onChange={(e) => setTargetsText(e.target.value)} rows={3} className="input resize-none font-mono text-sm" placeholder="@channel или t.me/channel" />
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField label="Мин. действий" value={minActions} onChange={setMinActions} />
          <NumberField label="Макс. действий" value={maxActions} onChange={setMaxActions} />
          <NumberField label="На аккаунт" value={maxPerAccount} onChange={setMaxPerAccount} />
        </div>

        <div className="rounded-2xl border border-line bg-elevated/40 p-4">
          <div className="mb-3 text-sm font-bold text-fg">Расписание</div>
          <Segmented options={SCHEDULE_TYPES} value={scheduleType} onChange={setScheduleType} size="sm" />
          <div className="mt-3">
            {scheduleType === 0 && (
              <div>
                <label className="label">Дата и время запуска</label>
                <input type="datetime-local" value={onceAt} onChange={(e) => setOnceAt(e.target.value)} className="input" />
              </div>
            )}
            {scheduleType === 1 && (
              <NumberField label="Интервал (минуты)" value={intervalMinutes} onChange={setIntervalMinutes} min={1} />
            )}
            {scheduleType === 2 && (
              <div>
                <label className="label">Время (ЧЧ:ММ)</label>
                <input type="time" value={dailyTime} onChange={(e) => setDailyTime(e.target.value)} className="input" />
              </div>
            )}
          </div>
        </div>

        <p className="text-xs text-muted">Планировщик запускает задачу в назначенное время, соблюдая блокировки аккаунтов. Если аккаунты заняты — запуск будет пропущен с записью в статус.</p>
      </div>
      <div className="mt-4 flex justify-end gap-2 border-t border-line pt-4">
        <button onClick={onClose} className="btn-ghost h-10">Отмена</button>
        <button onClick={save} disabled={saving} className="btn-primary h-10 disabled:opacity-50">{saving ? <Loader2 size={16} className="animate-spin" /> : <Power size={16} />} Сохранить</button>
      </div>
      </Card>
    </div>
  )
}
