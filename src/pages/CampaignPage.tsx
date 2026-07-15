import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Rocket, Check } from 'lucide-react'
import { activeAccounts, useApp } from '@/mocks/store'
import { PageHeader, Card, Select, Badge } from '@/shared/ui'
import { MODULES } from '@/shared/config/modules'
import { fetchGoals, type Goal } from '@/api/goalsApi'
import { launchCampaign, type CampaignResult } from '@/api/campaignsApi'
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

  useEffect(() => {
    void fetchGoals().then(setGoals).catch(() => {})
    void fetchChannels().then(setChannels).catch(() => {})
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

  return (
    <div>
      <PageHeader
        title="Кампания"
        subtitle="Одна цель → несколько модулей на общем пуле аккаунтов. Аккаунты распределяются между модулями без конфликтов."
        icon={<Rocket size={22} />}
      />

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
        </Card>
      </div>

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
