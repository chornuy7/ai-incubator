import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Rocket, Check, Clock, Power, Trash2, CalendarClock, Plus, Pencil, ArrowLeft, Lock, LockOpen, Target as TargetIcon } from 'lucide-react'
import { activeAccounts, useApp } from '@/mocks/store'
import { PageHeader, Card, Select, Badge } from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { MODULES } from '@/shared/config/modules'
import { fetchGoals, type Goal } from '@/api/goalsApi'
import {
  launchCampaign, fetchSchedules, createSchedule, updateSchedule, deleteSchedule,
  fetchCampaigns, createCampaign, updateCampaign, deleteCampaign, CAMPAIGN_STATUSES,
  type CampaignResult, type CampaignSchedule, type Campaign, type CampaignStatus, type PinnedMap,
} from '@/api/campaignsApi'
import { confirmDialog, promptDialog } from '@/shared/lib/dialog'
import { fetchAccountGroups, createAccountGroup, accountsOfGroupsLocal, type AccountGroup } from '@/api/accountGroupsApi'
import { fetchChannels, type Channel } from '@/api/channelsApi'
import { FolderPicker } from '@/features/modules/shared/FolderPicker'

// Модули, которые осмысленно вести к цели (принимают целевые каналы/группы).
const CAMPAIGN_MODULES = ['neuro-commenting', 'neuro-chatting', 'mass-react', 'mass-looking']

export function CampaignPage() {
  const nav = useNavigate()
  const pushToast = useApp((s) => s.pushToast)
  const accounts = activeAccounts(useApp((s) => s.data))
  const [goals, setGoals] = useState<Goal[]>([])
  const [goalId, setGoalId] = useState('')
  const [mods, setMods] = useState<Set<string>>(new Set(['neuro-commenting']))
  const [targetsText, setTargetsText] = useState('')
  const [channels, setChannels] = useState<Channel[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [launching, setLaunching] = useState(false)
  const [result, setResult] = useState<CampaignResult | null>(null)
  const [schedules, setSchedules] = useState<CampaignSchedule[]>([])
  const [runAt, setRunAt] = useState('')
  const [repeat, setRepeat] = useState<'none' | 'daily'>('none')
  const [scheduling, setScheduling] = useState(false)

  // ── §5: сущность «Кампания» — список + вьюшка создания/редактирования ──
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [pinnedMap, setPinnedMap] = useState<PinnedMap>({})
  const [formOpen, setFormOpen] = useState(false)
  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null)
  const [cName, setCName] = useState('')
  const [cGoalId, setCGoalId] = useState('')
  const [cModule, setCModule] = useState('neuro-commenting')
  const [cAccounts, setCAccounts] = useState<string[]>([])
  const [cPinned, setCPinned] = useState(true)
  const [cStatus, setCStatus] = useState<CampaignStatus>('draft')
  const [cSaving, setCSaving] = useState(false)
  const [pickMode, setPickMode] = useState(0) // 0 — числом из пула, 1 — вручную
  const [takeN, setTakeN] = useState(5)
  // §5: третий режим выбора аккаунтов — папкой (группой). §12: группы — отдельная сущность.
  const [groups, setGroups] = useState<AccountGroup[]>([])
  const [pickedGroups, setPickedGroups] = useState<string[]>([])
  const loadGroups = () => { void fetchAccountGroups().then(({ groups: gs }) => setGroups(gs)).catch(() => {}) }

  const loadCampaigns = () => {
    void fetchCampaigns().then(({ campaigns: cs, pinned }) => { setCampaigns(cs); setPinnedMap(pinned) }).catch(() => {})
  }
  const loadSchedules = () => { void fetchSchedules().then(setSchedules).catch(() => {}) }
  useEffect(() => {
    void fetchGoals().then(setGoals).catch(() => {})
    void fetchChannels().then(setChannels).catch(() => {})
    loadSchedules()
    loadCampaigns()
    loadGroups()
  }, [])

  // Свободные аккаунты (не занятые другой задачей) — их и распределим.
  const freeIds = useMemo(() => accounts.filter((a) => !a.busyIn).map((a) => a.id), [accounts])
  // Цели = вручную введённые + выбранные из базы каналов (без дублей).
  const targets = useMemo(() => {
    const typed = targetsText.split(/[\n,;]+/).map((t) => t.trim()).filter(Boolean)
    return [...new Set([...typed, ...picked])]
  }, [targetsText, picked])

  const pickChan = (u: string) => setPicked((prev) => {
    const n = new Set(prev); n.has(u) ? n.delete(u) : n.add(u); return n
  })

  const toggle = (k: string) => setMods((prev) => {
    const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n
  })

  const perModule = mods.size ? Math.floor(freeIds.length / mods.size) : 0
  const canLaunch = mods.size > 0 && freeIds.length > 0 && targets.length > 0 && !launching

  const launch = async () => {
    setLaunching(true); setResult(null)
    try {
      const r = await launchCampaign({
        goalId: goalId || null,
        accountIds: freeIds,
        targets,
        modules: [...mods].map((moduleKey) => ({ moduleKey })),
      })
      setResult(r)
      pushToast({ type: 'success', title: 'Кампания запущена', desc: `Задач: ${r.tasks.length}${r.skipped.length ? `, пропущено: ${r.skipped.length}` : ''}` })
    } catch (err) {
      pushToast({ type: 'error', title: 'Не удалось запустить кампанию', desc: err instanceof Error ? err.message : '' })
    } finally { setLaunching(false) }
  }

  const campaignBody = () => ({
    goalId: goalId || null,
    accountIds: freeIds,
    targets,
    modules: [...mods].map((moduleKey) => ({ moduleKey })),
  })

  const schedule = async () => {
    const ts = runAt ? new Date(runAt).getTime() : 0
    if (!ts) return pushToast({ type: 'error', title: 'Укажите дату и время запуска' })
    if (mods.size === 0 || targets.length === 0) return pushToast({ type: 'error', title: 'Выберите модули и цели' })
    setScheduling(true)
    try {
      await createSchedule({ name: goals.find((g) => g.id === goalId)?.name || 'Кампания', body: campaignBody(), runAt: ts, repeat })
      pushToast({ type: 'success', title: 'Кампания запланирована', desc: new Date(ts).toLocaleString() })
      setRunAt('')
      loadSchedules()
    } catch (e) { pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' }) }
    finally { setScheduling(false) }
  }

  const toggleSchedule = async (s: CampaignSchedule) => {
    try { const up = await updateSchedule(s.id, { enabled: !s.enabled }); setSchedules((prev) => prev.map((x) => (x.id === up.id ? up : x))) }
    catch (e) { pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' }) }
  }
  const removeSchedule = async (s: CampaignSchedule) => {
    if (!window.confirm('Удалить расписание кампании? Действие необратимо.')) return
    try { await deleteSchedule(s.id); setSchedules((prev) => prev.filter((x) => x.id !== s.id)) }
    catch (e) { pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' }) }
  }

  // §5: свободные аккаунты = активные, не закреплённые ЧУЖОЙ кампанией.
  const freeForCampaign = useMemo(
    () => accounts.filter((a) => {
      const pin = pinnedMap[a.id]
      return !pin || pin.campaignId === editingCampaign?.id
    }),
    [accounts, pinnedMap, editingCampaign],
  )

  const openNewCampaign = () => {
    setEditingCampaign(null)
    setCName(''); setCGoalId(''); setCModule('neuro-commenting'); setCAccounts([])
    setCPinned(true); setCStatus('draft'); setPickMode(0); setTakeN(5)
    setFormOpen(true)
  }
  const openEditCampaign = (c: Campaign) => {
    setEditingCampaign(c)
    setCName(c.name); setCGoalId(c.goalId || ''); setCModule(c.moduleKey); setCAccounts(c.accountIds || [])
    setCPinned(c.pinned); setCStatus(c.status); setPickMode(1); setTakeN(c.accountIds?.length || 5)
    setFormOpen(true)
  }

  const saveCampaign = async () => {
    if (!cName.trim()) return pushToast({ type: 'error', title: 'Укажите название кампании' })
    if (!cModule) return pushToast({ type: 'error', title: 'Кампания должна настраивать модуль' })
    // Режим «числом» — берём N свободных аккаунтов из пула.
    const ids = pickMode === 0
      ? freeForCampaign.slice(0, Math.max(0, takeN)).map((a) => a.id)
      : pickMode === 2
        ? accountsOfGroupsLocal(groups, pickedGroups).filter((id) => freeForCampaign.some((a) => a.id === id))
        : cAccounts
    setCSaving(true)
    try {
      const payload = { name: cName.trim(), goalId: cGoalId || null, moduleKey: cModule, accountIds: ids, pinned: cPinned, status: cStatus }
      if (editingCampaign) {
        await updateCampaign(editingCampaign.id, payload)
        pushToast({ type: 'success', title: 'Кампания обновлена', desc: cName.trim() })
      } else {
        await createCampaign(payload)
        pushToast({ type: 'success', title: 'Кампания создана', desc: cName.trim() })
      }
      setFormOpen(false)
      loadCampaigns()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не сохранено', desc: e instanceof Error ? e.message : '' })
    } finally { setCSaving(false) }
  }

  // §12: создать группу прямо из выбранных аккаунтов — чтобы не заводить их в чужом экране.
  const saveSelectionAsGroup = async () => {
    const name = await promptDialog({ title: 'Новая группа аккаунтов', message: 'Название группы', placeholder: 'Напр. Прогрев RU' })
    if (!name?.trim()) return
    try {
      await createAccountGroup({ name: name.trim(), accountIds: cAccounts })
      loadGroups()
      pushToast({ type: 'success', title: 'Группа создана', desc: `${name.trim()} · ${cAccounts.length} акк.` })
    } catch (e) {
      pushToast({ type: 'error', title: 'Не создано', desc: e instanceof Error ? e.message : '' })
    }
  }

  const removeCampaign = async (c: Campaign) => {
    if (!(await confirmDialog({ title: 'Удалить кампанию?', message: `«${c.name}» будет удалена, её аккаунты освободятся.`, confirmLabel: 'Удалить', tone: 'danger' }))) return
    try { await deleteCampaign(c.id); pushToast({ type: 'success', title: 'Кампания удалена' }); loadCampaigns() }
    catch (e) { pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' }) }
  }

  const goalNameOf = (id?: string | null) => (id ? goals.find((g) => g.id === id)?.name || '—' : null)

  // §5: создание/редактирование кампании — полноэкранная вьюшка, не модалка.
  if (formOpen) {
    return (
      <div>
        <button onClick={() => setFormOpen(false)} className="btn-ghost mb-3 h-9"><ArrowLeft size={15} /> Назад к кампаниям</button>
        <PageHeader
          title={editingCampaign ? 'Изменить кампанию' : 'Новая кампания'}
          subtitle="Кампания принадлежит цели и настраивает ОДИН модуль. Закреплённые аккаунты выходят из общего пула."
          icon={<Rocket size={22} />}
        />
        <Card className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-xs text-white/50">Название *</div>
              <input className="input" value={cName} onChange={(e) => setCName(e.target.value)} placeholder="Напр. Крипто · прогрев" />
            </div>
            <div>
              <div className="mb-1 text-xs text-white/50">Цель кампании</div>
              <Select value={cGoalId} onChange={setCGoalId} placeholder="Без цели" options={[{ value: '', label: 'Без цели' }, ...goals.map((g) => ({ value: g.id, label: g.name }))]} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-xs text-white/50">Модуль * <span className="text-white/30">(кампания обязана настраивать модуль)</span></div>
              <Select value={cModule} onChange={setCModule} options={CAMPAIGN_MODULES.map((k) => ({ value: k, label: MODULES[k]?.title || k }))} />
            </div>
            <div>
              <div className="mb-1 text-xs text-white/50">Статус</div>
              <Select value={cStatus} onChange={(v) => setCStatus(v as CampaignStatus)} options={CAMPAIGN_STATUSES.map((s) => ({ value: s, label: { draft: 'Черновик', active: 'Активна', paused: 'Пауза', done: 'Завершена' }[s] }))} />
            </div>
          </div>

          <div>
            <div className="mb-1 text-xs text-white/50">Аккаунты — {freeForCampaign.length} свободных (не закреплены другой кампанией)</div>
            <div className="mb-2 inline-flex rounded-lg border border-line bg-elevated p-0.5 text-xs">
              {['Числом из пула', 'Выбрать вручную', 'Группой (папкой)'].map((l, i) => (
                <button key={l} type="button" onClick={() => setPickMode(i)} className={`rounded px-3 py-1.5 font-semibold ${pickMode === i ? 'bg-spark-gradient text-[#04150c]' : 'text-muted'}`}>{l}</button>
              ))}
            </div>
            {pickMode === 0 ? (
              <div className="flex items-center gap-2">
                <input type="number" min={0} max={freeForCampaign.length} value={takeN} onChange={(e) => setTakeN(Math.max(0, Number(e.target.value) || 0))} className="input h-9 w-28" />
                <span className="text-xs text-white/50">из {freeForCampaign.length} свободных</span>
              </div>
            ) : (
              <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-line bg-elevated/40 p-2.5">
                {freeForCampaign.length === 0 && <span className="text-xs text-white/40">Свободных аккаунтов нет — все закреплены другими кампаниями</span>}
                {freeForCampaign.map((a) => {
                  const on = cAccounts.includes(a.id)
                  return (
                    <button key={a.id} type="button"
                      onClick={() => setCAccounts((prev) => (on ? prev.filter((x) => x !== a.id) : [...prev, a.id]))}
                      className={`rounded-lg border px-2 py-1 text-xs ${on ? 'border-spark-500/50 bg-spark-500/12 text-spark-300' : 'border-line text-white/60'}`}>
                      {a.name || a.phone || a.id.slice(-6)}
                    </button>
                  )
                })}
              </div>
            )}
            {pickMode === 2 && (
              <div className="rounded-xl border border-line bg-elevated/40 p-2.5">
                {groups.length === 0 ? (
                  <p className="text-xs text-white/40">Групп аккаунтов пока нет. Выберите аккаунты вручную и сохраните их как группу — она появится здесь и в «Ролях и доступах».</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {groups.map((g) => {
                      const on = pickedGroups.includes(g.id)
                      const free = g.accountIds.filter((id) => freeForCampaign.some((a) => a.id === id)).length
                      return (
                        <button key={g.id} type="button"
                          onClick={() => setPickedGroups((prev) => (on ? prev.filter((x) => x !== g.id) : [...prev, g.id]))}
                          className={`rounded-lg border px-2 py-1 text-xs ${on ? 'border-spark-500/50 bg-spark-500/12 text-spark-300' : 'border-line text-white/60'}`}>
                          {g.name} <span className="text-white/40">· {free}/{g.accountIds.length} свободны</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
            {pickMode === 1 && cAccounts.length > 0 && (
              <button type="button" onClick={() => void saveSelectionAsGroup()} className="btn-ghost mt-2 h-8 text-xs">
                + Сохранить выбранные как группу
              </button>
            )}
            <label className="mt-2 flex items-center gap-2 text-xs text-white/60">
              <input type="checkbox" checked={cPinned} onChange={(e) => setCPinned(e.target.checked)} className="h-4 w-4 rounded border-line accent-spark-500" />
              Закрепить аккаунты за кампанией (выйдут из общего пула). Без галочки — «использовать без лока».
            </label>
          </div>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <button onClick={() => setFormOpen(false)} className="btn-ghost h-10">Отмена</button>
            <button onClick={() => void saveCampaign()} disabled={cSaving} className="btn-primary h-10">{cSaving ? 'Сохранение…' : editingCampaign ? 'Сохранить' : 'Создать кампанию'}</button>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title="Кампания"
        subtitle="Одна цель → несколько модулей на общем пуле аккаунтов. Аккаунты распределяются между модулями без конфликтов."
        icon={<Rocket size={22} />}
        actions={<div className="flex items-center gap-2"><HelpButton topic="campaign" className="h-10 w-10" /><button onClick={openNewCampaign} className="btn-primary h-10"><Plus size={16} /> Создать кампанию</button></div>}
      />

      {/* §5: список кампаний — сущность, а не только разовый запуск. */}
      <Card className="mb-4 p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
          <Rocket size={15} className="text-spark-400" /> Кампании ({campaigns.length})
        </div>
        {campaigns.length === 0 ? (
          <p className="text-sm text-white/50">Кампаний пока нет. Кампания = цель + один настроенный модуль + закреплённые аккаунты.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {campaigns.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-elevated/40 p-3">
                <Badge tone={c.status === 'active' ? 'spark' : c.status === 'paused' ? 'amber' : c.status === 'done' ? 'muted' : 'iris'}>
                  {{ draft: 'Черновик', active: 'Активна', paused: 'Пауза', done: 'Завершена' }[c.status]}
                </Badge>
                <span className="font-semibold text-white">{c.name}</span>
                <span className="text-xs text-white/50">{MODULES[c.moduleKey]?.title || c.moduleKey}</span>
                {c.goalId && <span className="text-xs text-iris-300"><TargetIcon size={11} className="mb-0.5 inline" /> {goalNameOf(c.goalId)}</span>}
                <span className="inline-flex items-center gap-1 text-xs text-white/50" title={c.pinned ? 'Аккаунты закреплены — вышли из общего пула' : 'Аккаунты используются без лока'}>
                  {c.pinned ? <Lock size={11} className="text-amber-300" /> : <LockOpen size={11} />} {c.accountIds.length} акк.
                </span>
                <div className="ml-auto flex gap-1">
                  <button onClick={() => openEditCampaign(c)} className="btn-icon h-8 w-8" aria-label="Изменить"><Pencil size={14} /></button>
                  <button onClick={() => void removeCampaign(c)} className="btn-icon-danger h-8 w-8" aria-label="Удалить кампанию" title="Удалить кампанию"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-1 text-xs text-white/50">Цель кампании</div>
          <Select value={goalId} onChange={setGoalId} placeholder="Без цели" options={[{ value: '', label: 'Без цели' }, ...goals.map((g) => ({ value: g.id, label: g.name }))]} />

          <div className="mb-1 mt-4 text-xs text-white/50">Модули (аккаунты поделятся между ними)</div>
          <div className="flex flex-col gap-1.5">
            {CAMPAIGN_MODULES.map((k) => (
              <button key={k} onClick={() => toggle(k)} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm ${mods.has(k) ? 'border-spark-500/40 bg-spark-500/10 text-white' : 'border-white/10 text-white/70'}`}>
                <span className={`flex h-4 w-4 items-center justify-center rounded border ${mods.has(k) ? 'border-spark-500 bg-spark-500 text-black' : 'border-white/30'}`}>{mods.has(k) && <Check size={11} />}</span>
                {MODULES[k]?.title || k}
              </button>
            ))}
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-1 text-xs text-white/50">Целевые каналы/группы (по одному на строку)</div>
          <textarea className="input min-h-[88px]" value={targetsText} onChange={(e) => setTargetsText(e.target.value)} placeholder={'@channel1\nhttps://t.me/group2'} />
          {/* §3.7: объединение источников — цели можно загрузить из сохранённых папок */}
          <div className="mt-2">
            <FolderPicker
              targets={targets}
              onLoad={(t) => setPicked((prev) => {
                const next = new Set(prev)
                t.forEach((x) => { const v = x.trim(); if (v) next.add(v.startsWith('@') || v.includes('t.me') ? v : `@${v}`) })
                return next
              })}
            />
          </div>
          {channels.length > 0 && (
            <div className="mt-2">
              <div className="mb-1 text-xs text-white/50">Или выбрать из базы каналов ({picked.size} выбрано)</div>
              <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto rounded-lg border border-white/10 p-2">
                {channels.filter((c) => c.username).map((c) => {
                  const u = `@${c.username}`
                  const on = picked.has(u)
                  return (
                    <button key={c.id} onClick={() => pickChan(u)} className={`rounded px-2 py-0.5 text-xs ${on ? 'bg-spark-500 text-black' : 'bg-white/5 text-white/70 hover:bg-white/10'}`}>
                      {u}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/50">
            <span>Свободных аккаунтов: <b className="text-white">{freeIds.length}</b></span>
            <span>Модулей: <b className="text-white">{mods.size}</b></span>
            <span>≈ на модуль: <b className="text-white">{perModule}</b></span>
            <span>Целей-каналов: <b className="text-white">{targets.length}</b></span>
          </div>
          <button onClick={() => void launch()} disabled={!canLaunch} className="btn-primary mt-3 h-10 w-full">
            <Rocket size={16} /> {launching ? 'Запуск…' : 'Запустить кампанию'}
          </button>
          {freeIds.length === 0 && <div className="mt-2 text-xs text-amber-300">Нет свободных аккаунтов (все заняты или в прогреве).</div>}

          {/* §3.9: расписание — запустить кампанию по времени + вкл/выкл + повтор */}
          <div className="mt-3 rounded-xl border border-line bg-elevated/40 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg"><CalendarClock size={15} className="text-iris-300" /> Запланировать</div>
            <div className="flex flex-wrap items-center gap-2">
              <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} className="input h-9 flex-1" />
              <Select value={repeat} onChange={(v) => setRepeat(v as 'none' | 'daily')} className="w-36" options={[{ value: 'none', label: 'Один раз' }, { value: 'daily', label: 'Каждый день' }]} />
              <button onClick={() => void schedule()} disabled={scheduling || !runAt || !mods.size || !targets.length} className="btn-iris h-9 text-sm disabled:opacity-40"><Clock size={14} /> {scheduling ? '…' : 'В расписание'}</button>
            </div>
          </div>
        </Card>
      </div>

      {schedules.length > 0 && (
        <Card className="mt-4 p-4">
          <div className="mb-2 text-sm font-semibold text-fg">Запланированные кампании</div>
          <div className="flex flex-col gap-2">
            {schedules.map((s) => (
              <div key={s.id} className={`flex flex-wrap items-center gap-2 rounded-xl border p-2.5 ${s.enabled ? 'border-line bg-elevated/40' : 'border-line/60 bg-elevated/20 opacity-60'}`}>
                <Badge tone={s.enabled ? 'spark' : 'muted'}>{s.enabled ? 'вкл' : 'выкл'}</Badge>
                <span className="truncate text-sm font-medium text-fg">{s.name}</span>
                <Badge tone="iris">{s.repeat === 'daily' ? 'ежедневно' : 'один раз'}</Badge>
                <span className="text-xs text-white/50"><Clock size={11} className="mb-0.5 mr-0.5 inline" />{new Date(s.runAt).toLocaleString()}</span>
                {s.lastRunAt && <span className="text-xs text-white/40">· последний: {new Date(s.lastRunAt).toLocaleString()}{s.lastResult?.error ? ` (${s.lastResult.error})` : s.lastResult ? ` (задач: ${s.lastResult.tasks})` : ''}</span>}
                <div className="ml-auto flex items-center gap-1">
                  <button onClick={() => void toggleSchedule(s)} className="btn-icon h-8 w-8" aria-label="Вкл/выкл"><Power size={14} className={s.enabled ? 'text-spark-400' : 'text-white/40'} /></button>
                  <button onClick={() => void removeSchedule(s)} className="btn-icon-danger h-8 w-8" aria-label="Удалить расписание" title="Удалить расписание"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {result && (
        <Card className="mt-4 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm text-white/70">
            Кампания <span className="font-mono text-xs text-white/40">{result.campaignId}</span>
            <button onClick={() => nav('/panel/tasks')} className="btn-ghost ml-auto h-8 text-xs">Открыть «Задачи» →</button>
          </div>
          <div className="flex flex-col gap-1">
            {result.tasks.map((t) => (
              <div key={t.taskId} className="flex items-center gap-2 rounded bg-white/5 px-3 py-1.5 text-sm">
                <Badge tone="spark">запущено</Badge>
                <span className="text-white">{MODULES[t.moduleKey]?.title || t.moduleKey}</span>
                <span className="text-xs text-white/40">{t.accounts} акк.</span>
              </div>
            ))}
            {result.skipped.map((s, i) => (
              <div key={i} className="flex items-center gap-2 rounded bg-white/5 px-3 py-1.5 text-sm">
                <Badge tone="amber">пропущено</Badge>
                <span className="text-white/70">{MODULES[s.moduleKey]?.title || s.moduleKey}</span>
                <span className="text-xs text-white/40">— {s.reason}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}
