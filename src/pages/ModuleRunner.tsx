import { useMemo, useState } from 'react'
import { useParams, Navigate } from 'react-router-dom'
import {
  Play, Save, Square, Sparkles, Plus, Trash2, FileText, Clock, Globe, Copy, Download,
  ArrowUp, ListChecks, ShoppingCart, History as HistoryIcon, ChevronRight, X, ChevronDown,
  Shield, Settings2, Hash, Eye, Megaphone, Mail, Bookmark, Users, Timer,
  MessageSquareText, AlertTriangle, Check, Star, UploadCloud, Bolt, MessageCircle, Filter, Heart, Smile,
  BarChart3 as BarChartIcon, Ban, Calendar, Cpu, MapPin, SlidersHorizontal, CheckSquare,
  Volume2, ArrowDown, Search, LayoutGrid, List, Send, ExternalLink, MessagesSquare, Trophy,
  Tag, Activity, Database, ArrowUpDown, Pencil, RefreshCw, Radio, HelpCircle,
} from 'lucide-react'
import { DIALOGS, type Dialog } from '@/mocks/dialogs'
import { MODULES, LANGUAGES, type ModuleConfig } from '@/shared/config/modules'
import { ROUTES } from '@/shared/config/routes'
import { useApp, activeAccounts } from '@/mocks/store'
import { useUi } from '@/shared/lib/uiStore'
import { seedLogs } from '@/mocks/logs'
import { makeResults } from '@/mocks/parseResults'
import { useMockLoading } from '@/shared/lib/hooks'
import {
  PageHeader, Card, ToggleGroup, Segmented, Select, EmptyState, Modal, Avatar, StatusBadge, Skeleton, Badge, Switch,
} from '@/shared/ui'
import { LogsPanel } from '@/widgets/LogsPanel'
import { AccountPicker } from '@/features/account-picker/AccountPicker'
import { PaywallLock } from '@/features/paywall/Paywall'
import { ModuleLiveRouter, isLiveModule } from '@/features/modules'
import { cn, compact, uid } from '@/shared/lib/utils'
import type { ParseResult } from '@/shared/types'

const SYSTEM_PROMPTS_FALLBACK = [
  'Дружелюбный эксперт', 'Краткий и по делу', 'Продающий копирайтер',
  'Нейтральный комментатор', 'Вовлекающий вопрос', 'Поддерживающий тон',
]

const TARGET_POOL = [
  'crypto1_ua', 'crafty_jew', 'tikitons', 'CryptoMriya', 'cryptohokage7', 'cryptogemchik1', 'mon_trending',
  'VasyaBTC', 'crypto_hom4ikk', 'cryptooseek', 'cryptouk19', 'HOT_DROP_S', 'yaskocrypto', 'cryshara',
  'DROPHunters88', 'drop_guide_official', 'cryptodogin', 'cryptogeedd', 'frupi_diary', 'crypto_temper',
  'Formula_capitalu', 'incrypted_events', 'k_cryptt', 'dredocrypto', 'ludoman_incrypto', 'maddencrypto',
  'cryptanuaa', 'spiva4ok_crypto', 'cryptomavpik', 'Chow_Trade', 'crypti_news', 'provider_public3',
  'kaluna_crypto', 'Incrypted_Education', 'nft_mint_ua', 'defi_insiders', 'web3_digest', 'growth_hacks_tg',
]

/** Детерминированный список целей-юзернеймов для чипов. */
function genTargets(count: number): string[] {
  return Array.from({ length: count }, (_, i) => (i < TARGET_POOL.length ? TARGET_POOL[i] : `${TARGET_POOL[i % TARGET_POOL.length]}${Math.floor(i / TARGET_POOL.length) + 1}`))
}

export function ModuleRunner() {
  const { moduleKey = '' } = useParams()
  const cfg = MODULES[moduleKey]
  const route = ROUTES.find((r) => r.path === `/panel/modules/${moduleKey}`)
  const isNoSub = useApp((s) => s.userState === 'no-sub')
  const loading = useMockLoading(450, [moduleKey])

  if (!cfg || !route) return <Navigate to="/panel" replace />

  const inner = isLiveModule(moduleKey)
    ? <ModuleLiveRouter moduleKey={moduleKey} />
    : cfg.participantsLayout ? <ParticipantsModule cfg={cfg} /> : cfg.parserLayout ? <ParsingModule cfg={cfg} /> : cfg.ggrLayout ? <GgrModule cfg={cfg} /> : cfg.dialogsLayout ? <DialogsModule cfg={cfg} /> : cfg.warmingLayout ? <WarmingModule cfg={cfg} /> : cfg.lookingLayout ? <LookingModule cfg={cfg} /> : cfg.richLayout ? <RichModule cfg={cfg} /> : <GenericModule cfg={cfg} />

  return (
    <div>
      <PageHeader
        title={cfg.title}
        subtitle={cfg.subtitle}
        badge={cfg.badge}
        icon={<route.icon size={22} />}
        actions={<HeaderActions cfg={cfg} />}
      />
      {isNoSub ? (
        <PaywallLock>{inner}</PaywallLock>
      ) : loading ? (
        <div className="space-y-4"><Skeleton className="h-40 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" /></div>
      ) : inner}
    </div>
  )
}

/* ── Header actions ── */
function HeaderActions({ cfg }: { cfg: ModuleConfig }) {
  const pushToast = useApp((s) => s.pushToast)
  const setTasksOpen = useUi((s) => s.setTasksOpen)
  const setCoinsOpen = useUi((s) => s.setCoinsOpen)

  if (cfg.ggrLayout) {
    const coins = useApp.getState().data.coins
    return (
      <>
        <div className="hidden items-center gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 sm:flex"><span className="text-[10px] font-bold uppercase text-muted">Баланс</span><span className="text-sm font-bold text-amber-300">{coins.toFixed(2)}</span><Bolt size={13} className="text-amber-400" /></div>
        <div className="hidden items-center gap-1.5 rounded-xl border border-line bg-elevated px-3 py-1.5 sm:flex"><span className="text-[10px] font-bold uppercase text-muted">Проверка</span><span className="text-sm font-bold text-fg">0.20</span><Bolt size={13} className="text-amber-400" /></div>
        <button onClick={() => setCoinsOpen(true)} className="btn-ghost h-10">КУПИТЬ</button>
        <div className="hidden flex-col items-center px-2 leading-tight md:flex"><span className="text-[10px] font-bold uppercase text-muted">Шкала</span><span className="text-xs font-bold text-fg">1.0 — 10.0</span></div>
        <div className="hidden flex-col items-center px-2 leading-tight md:flex"><span className="text-[10px] font-bold uppercase text-muted">Обновление</span><span className="text-xs font-bold text-fg">≤ 6ч</span></div>
      </>
    )
  }

  if (cfg.dialogsLayout) {
    return (
      <>
        <button onClick={() => pushToast({ type: 'info', title: 'Очистить', desc: 'Очистка диалогов (демо).' })} className="btn-ghost h-10"><Trash2 size={15} /> Очистить</button>
        <button onClick={() => pushToast({ type: 'info', title: 'К диалогам', desc: 'Прокрутка к списку диалогов.' })} className="btn-ghost h-10"><ArrowDown size={15} /> К диалогам</button>
        <button onClick={() => pushToast({ type: 'info', title: 'Звук уведомлений', desc: 'Переключено (демо).' })} className="btn-icon h-10 w-10"><Volume2 size={16} /></button>
        <button onClick={() => pushToast({ type: 'info', title: 'Загрузить ЛС (демо)', desc: 'Импорт истории переписок.' })} className="btn-iris h-10"><UploadCloud size={16} /> Загрузить ЛС</button>
      </>
    )
  }

  return (
    <>
      {(cfg.richLayout || cfg.lookingLayout || cfg.warmingLayout || cfg.parserLayout || cfg.participantsLayout) && <>
        <button onClick={() => pushToast({ type: 'info', title: 'О модуле', desc: `${cfg.title} — справка (демо).` })} className="btn-ghost h-10">О модуле</button>
        <button onClick={() => pushToast({ type: 'info', title: 'Статьи', desc: 'База знаний (демо).' })} className="btn-ghost h-10">Статьи</button>
      </>}
      {cfg.templateButtons?.map((b) => (
        <button key={b} onClick={() => pushToast({ type: 'info', title: b, desc: 'Шаблоны настроек (демо).' })} className="btn-ghost h-10">{b === 'Новый шаблон' && <Plus size={15} />}{b}</button>
      ))}
      {cfg.extraButtons?.includes('Прошлые проверки') && (
        <button onClick={() => pushToast({ type: 'info', title: 'Прошлые проверки', desc: 'История GGR (демо).' })} className="btn-ghost h-10"><HistoryIcon size={15} /> Прошлые проверки</button>
      )}
      {cfg.extraButtons?.includes('КУПИТЬ') && (
        <button onClick={() => setCoinsOpen(true)} className="btn-iris h-10"><ShoppingCart size={15} /> КУПИТЬ</button>
      )}
      <button onClick={() => setTasksOpen(true)} className="btn-ghost h-10"><ListChecks size={15} /> <span className="hidden sm:inline">Задачи</span></button>
    </>
  )
}

/* ══════════════════════ RICH LAYOUT (Нейрокомментинг) ══════════════════════ */
function RichModule({ cfg }: { cfg: ModuleConfig }) {
  const addTask = useApp((s) => s.addTask)
  const pushToast = useApp((s) => s.pushToast)
  const guardNet = useApp((s) => s.guardNet)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [toggles, setToggles] = useState<Record<number, number>>({})
  const [aiProtect, setAiProtect] = useState(false)
  const [probability, setProbability] = useState(cfg.reactionSettings?.probability.value ?? cfg.probabilitySlider?.value ?? 30)
  const [perAccountProb, setPerAccountProb] = useState(false)
  const [maxComments, setMaxComments] = useState(cfg.reactionSettings?.max.value ?? cfg.workModeFields?.maxValue ?? 100)
  const [maxPerAcc, setMaxPerAcc] = useState(0)
  const [minWords, setMinWords] = useState(0)
  const [useSubs, setUseSubs] = useState(false)
  const [srcTab, setSrcTab] = useState(0)
  const [channels, setChannels] = useState('')
  const [aiPrompt, setAiPrompt] = useState(true)
  const [activePrompt, setActivePrompt] = useState(0)
  const [sendAsChannel, setSendAsChannel] = useState(false)
  const [deletionTrack, setDeletionTrack] = useState(false)
  const [langMode, setLangMode] = useState(0)
  const [alwaysOn, setAlwaysOn] = useState(false)
  const [autoResp, setAutoResp] = useState(0)
  const [delayPreset, setDelayPreset] = useState(1)
  const [running, setRunning] = useState(false)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [protLevel, setProtLevel] = useState(1)
  const [targets, setTargets] = useState<string[]>(() => genTargets(cfg.seedTargetCount ?? 0))
  const [ctxDepth, setCtxDepth] = useState(cfg.conversationContext?.value ?? 10)
  const [organicPromo, setOrganicPromo] = useState(false)
  const [progress, setProgress] = useState(0)
  // mass-react
  const [duration, setDuration] = useState(cfg.reactionSettings?.duration.value ?? 60)
  const [reactRules, setReactRules] = useState<Set<number>>(new Set())
  const [palette, setPalette] = useState<Set<string>>(new Set(['👍', '❤️', '🔥']))
  const [emojiModeIdx, setEmojiModeIdx] = useState(0)
  const [channelReact, setChannelReact] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [blacklistOpen, setBlacklistOpen] = useState(false)

  const logs = useMemo(() => seedLogs(cfg.key, cfg.logSeedCount), [cfg])
  const unit = cfg.unit ?? { gen: 'каналов', title: 'Каналы', maxLabel: 'Макс.' }
  const channelCount = cfg.targetChips ? targets.length : (cfg.channelHeaderCount ?? 0)
  const intervalStat = cfg.counters?.[1]?.value ?? '120с'

  const addTargets = () => {
    const parsed = channels.split(/[\n,\s]+/).map((s) => s.trim().replace(/^@/, '')).filter(Boolean)
    if (parsed.length === 0) return
    setTargets((t) => [...new Set([...parsed, ...t])])
    setChannels('')
    pushToast({ type: 'success', title: 'Добавлено', desc: `${parsed.length} шт.` })
  }

  const run = () => {
    if (!guardNet(cfg.primaryAction)) return
    if (selected.size === 0) return pushToast({ type: 'error', title: 'Аккаунты не выбраны', desc: 'Выберите хотя бы один аккаунт.' })
    setRunning(true); setProgress(0)
    addTask({ module: cfg.key, title: `${cfg.title} · ${selected.size} акк.`, status: 'running', progress: 8, accountsCount: selected.size, logCount: cfg.logSeedCount })
    pushToast({ type: 'success', title: 'Задача запущена', desc: `${cfg.title} · ${selected.size} акк.` })
    let p = 0
    const timer = setInterval(() => { p += 4; setProgress(Math.min(p, 100)); if (p >= 100) clearInterval(timer) }, 260)
  }
  const stop = () => { setRunning(false); setProgress(0); pushToast({ type: 'info', title: 'Остановлено' }) }

  const setTg = (i: number, v: number) => setToggles((t) => ({ ...t, [i]: v }))
  const g = (i: number) => toggles[i] ?? 0
  const showProb = cfg.probabilitySlider && (cfg.probabilityAlways || g(0) === 0)

  return (
    <div className="space-y-4">
      {/* 1. Select accounts */}
      <AccountPicker selected={selected} onChange={setSelected} actions={cfg.accountActions} withFilters={!!cfg.accountFilters} selectedTitle={cfg.selectedTitle ?? 'Выбрано'} />

      {/* 2. Settings */}
      <SectionCard icon={<Settings2 size={18} />} title={cfg.settingsTitle ?? 'Настройки'} badge={`${channelCount} ${unit.gen}`}>
        {cfg.aiProtection && (
          <div className="mb-4 rounded-2xl border border-spark-500/40 bg-spark-500/8 p-4">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-spark-500/15 text-spark-400"><Shield size={20} /></div>
              <div className="flex-1">
                <div className="flex items-center gap-2"><span className="font-bold text-fg">Защита аккаунтов ИИ</span><Badge tone="spark">NEW</Badge></div>
                <div className="text-xs text-muted">Умная защита от блокировок, заморозок и банов с помощью ИИ. Снижает риск бана на 97%.</div>
              </div>
              <Switch checked={aiProtect} onChange={setAiProtect} />
            </div>
            {cfg.protectionLevels && aiProtect && (
              <div className="mt-4 grid gap-2 border-t border-spark-500/20 pt-4 sm:grid-cols-3">
                {cfg.protectionLevels.map((lvl, i) => (
                  <button key={lvl.label} onClick={() => setProtLevel(i)} className={cn('flex items-center gap-2.5 rounded-xl border p-3 text-left transition-all', i === protLevel ? 'border-spark-500/60 bg-spark-500/10' : 'border-line bg-elevated hover:border-spark-500/30')}>
                    <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', i === protLevel ? 'bg-spark-500/20 text-spark-300' : 'text-muted')}>{i === 0 ? <Shield size={16} /> : i === 1 ? <Settings2 size={16} /> : <Bolt size={16} />}</span>
                    <div><div className={cn('text-sm font-bold', i === protLevel ? 'text-fg' : 'text-muted')}>{lvl.label}</div><div className="text-[11px] text-muted">{lvl.desc}</div></div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {cfg.reactionSettings ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Left: work mode + fields + probability */}
            <div className="space-y-4 rounded-2xl border border-line bg-elevated/40 p-4">
              <div className="flex items-center gap-2 text-sm font-bold text-fg"><Settings2 size={15} className="text-spark-400" /> Режим работы</div>
              <ToggleGroup label="" options={cfg.reactionSettings.modes} value={g(1)} onChange={(v) => setTg(1, v)} />
              <div>
                <NumberField label={cfg.reactionSettings.duration.label} value={duration} onChange={setDuration} suffix={`${duration}m`} />
                <div className="mt-1 text-xs text-muted">{cfg.reactionSettings.duration.hint}</div>
              </div>
              <NumberField label={cfg.reactionSettings.max.label} value={maxComments} onChange={setMaxComments} />
              <NumberField label={cfg.reactionSettings.perAccount.label} value={maxPerAcc} onChange={setMaxPerAcc} suffix="∞" />
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-sm text-muted">{cfg.reactionSettings.probability.label}</span>
                  <span className="rounded-md bg-spark-500/12 px-2 py-0.5 text-xs font-bold text-spark-300">{probability}%</span>
                </div>
                <input type="range" min={0} max={100} value={probability} onChange={(e) => setProbability(Number(e.target.value))} className="w-full accent-spark-500" />
              </div>
            </div>
            {/* Right: reacting rules */}
            <div className="space-y-3 rounded-2xl border border-line bg-elevated/40 p-4">
              <div className="flex items-center gap-2 text-sm font-bold text-fg"><Filter size={15} className="text-spark-400" /> Настройки реагирования</div>
              {cfg.reactionSettings.rules.map((r, i) => {
                const on = reactRules.has(i)
                return (
                  <button key={r} onClick={() => { const n = new Set(reactRules); n.has(i) ? n.delete(i) : n.add(i); setReactRules(n) }} className="flex w-full items-center gap-3 rounded-xl border border-line bg-elevated p-3 text-left transition-colors hover:border-spark-500/30">
                    <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-md border', on ? 'border-spark-500 bg-spark-500 text-[#04150c]' : 'border-line')}>{on && <Check size={13} />}</span>
                    <span className="text-sm text-fg">{r}</span>
                  </button>
                )
              })}
            </div>
          </div>
        ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Left: mode + probability + which posts */}
          <div className="space-y-4 rounded-2xl border border-line bg-elevated/40 p-4">
            <div className="flex items-center gap-2 text-sm font-bold text-fg"><Bolt size={15} className="text-spark-400" /> {cfg.toggleGroups![0].label}</div>
            <ToggleGroup label="" options={cfg.toggleGroups![0].options} value={g(0)} onChange={(v) => setTg(0, v)} />
            {showProb && (
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-sm text-muted">{cfg.probabilitySlider!.label}</span>
                  <span className="rounded-md bg-spark-500/12 px-2 py-0.5 text-xs font-bold text-spark-300">{probability}%</span>
                </div>
                <input type="range" min={0} max={100} value={probability} onChange={(e) => setProbability(Number(e.target.value))} className="w-full accent-spark-500" />
                {cfg.workModeFields?.perAccount && <div className="mt-2"><Switch checked={perAccountProb} onChange={setPerAccountProb} label="Задавать вероятность на аккаунт" /></div>}
              </div>
            )}
            {cfg.toggleGroups![2] && (
              <div className="border-t border-line pt-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-bold text-fg"><HistoryIcon size={15} className="text-spark-400" /> {cfg.toggleGroups![2].label}</div>
                <ToggleGroup label="" options={cfg.toggleGroups![2].options} value={g(2)} onChange={(v) => setTg(2, v)} />
              </div>
            )}
          </div>

          {/* Right: work mode + fields */}
          <div className="space-y-4 rounded-2xl border border-line bg-elevated/40 p-4">
            <div className="flex items-center gap-2 text-sm font-bold text-fg"><Clock size={15} className="text-spark-400" /> {cfg.toggleGroups![1].label}</div>
            <ToggleGroup label="" options={cfg.toggleGroups![1].options} value={g(1)} onChange={(v) => setTg(1, v)} />
            {cfg.workModeFields && (cfg.workModeFields.slider ? (
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-sm text-muted">{cfg.workModeFields.maxLabel}</span>
                  <span className="rounded-md bg-spark-500/12 px-2 py-0.5 text-xs font-bold text-spark-300">{maxComments}</span>
                </div>
                <input type="range" min={0} max={500} value={maxComments} onChange={(e) => setMaxComments(Number(e.target.value))} className="w-full accent-spark-500" />
              </div>
            ) : (
              <div className="space-y-3">
                <NumberField label={cfg.workModeFields.maxLabel} value={maxComments} onChange={setMaxComments} />
                {cfg.workModeFields.perAccount && <NumberField label="Макс. комментариев на аккаунт" value={maxPerAcc} onChange={setMaxPerAcc} suffix="∞" />}
                {cfg.workModeFields.minWords && <NumberField label="Мин. слов в посте" value={minWords} onChange={setMinWords} />}
              </div>
            ))}
          </div>
        </div>
        )}

        {cfg.importScheme && (
          <div className="mt-4 flex flex-col items-start justify-between gap-3 rounded-2xl border border-line bg-elevated/40 p-4 sm:flex-row sm:items-center">
            <div>
              <div className="flex items-center gap-2 text-sm font-bold text-spark-300"><Hash size={15} /> Импорт схемы перед выбором аккаунтов</div>
              <div className="mt-0.5 text-xs text-muted">Загрузите JSON-схему — модуль попробует выбрать аккаунты автоматически. Если их нет в системе, покажем предупреждение.</div>
            </div>
            <button onClick={() => pushToast({ type: 'info', title: 'Импорт JSON (демо)' })} className="btn-iris h-10 shrink-0"><UploadCloud size={16} /> Импорт JSON</button>
          </div>
        )}
      </SectionCard>

      {/* 3. Target channels/groups */}
      <SectionCard icon={<Hash size={18} />} title={cfg.sourceTabs?.label ?? 'Цели'} badge={String(channelCount)}
        right={cfg.subscriptionsToggle && <label className="flex items-center gap-2 text-sm text-muted"><span className="hidden sm:inline">Использовать подписки аккаунтов</span><Switch checked={useSubs} onChange={setUseSubs} /></label>}>
        {cfg.sourceTabs && cfg.sourceTabs.tabs.length > 1 && (
          <Segmented className="mb-3" size="sm" options={cfg.sourceTabs.tabs} value={srcTab} onChange={setSrcTab} />
        )}
        <div className="flex gap-2">
          <textarea value={channels} onChange={(e) => setChannels(e.target.value)} rows={3} className="input resize-none font-mono text-sm" placeholder={cfg.sourceTabs?.placeholder} />
          <button onClick={addTargets} className="btn-ghost h-auto shrink-0 flex-col px-4"><Plus size={16} /> Добавить</button>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted"><ListChecks size={13} /> Строк: {channels.split('\n').filter((l) => l.trim()).length}</div>

        {cfg.targetChips && targets.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-bold text-fg">{channelCount} {unit.gen}</span>
              <button onClick={() => setTargets([])} className="flex items-center gap-1 text-xs font-semibold text-rose-300 hover:underline"><Trash2 size={13} /> Очистить всё</button>
            </div>
            <div className="flex max-h-52 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-line bg-elevated/40 p-3">
              {targets.slice(0, 60).map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-xs font-medium text-fg">
                  @{t}
                  <button onClick={() => setTargets((arr) => arr.filter((x) => x !== t))} className="text-faint hover:text-rose-300"><X size={12} /></button>
                </span>
              ))}
              {targets.length > 60 && <span className="inline-flex items-center rounded-lg bg-elevated px-2 py-1 text-xs font-semibold text-muted">+{targets.length - 60} ещё</span>}
            </div>
          </div>
        )}
      </SectionCard>

      {/* 3b. Emoji palette (mass-react) */}
      {cfg.reactionPalette && (
        <SectionCard icon={<Smile size={18} />} title="Эмодзи для реакций">
          <div className="flex flex-wrap gap-2">
            {cfg.reactionPalette.map((e) => {
              const on = palette.has(e)
              return <button key={e} onClick={() => { const n = new Set(palette); n.has(e) ? n.delete(e) : n.add(e); setPalette(n) }} className={cn('grid h-11 w-11 place-items-center rounded-xl border text-xl transition-all', on ? 'scale-105 border-spark-500/50 bg-spark-500/12' : 'border-line bg-elevated hover:scale-105')}>{e}</button>
            })}
          </div>
          {cfg.emojiMode && (
            <div className="mt-4"><span className="label">Режим эмодзи</span><Segmented options={cfg.emojiMode} value={emojiModeIdx} onChange={setEmojiModeIdx} size="sm" /></div>
          )}
          <div className="mt-2 text-xs text-muted">Выбрано: {palette.size}</div>
        </SectionCard>
      )}

      {/* 3c. Channel reactions (mass-react) */}
      {cfg.channelReactions && (
        <SectionCard icon={<Megaphone size={18} />} title="Реакции от канала" right={<Switch checked={channelReact} onChange={setChannelReact} />}>
          <p className="text-sm text-muted">Ставить реакции от личного аккаунта или от имени канала — для более естественного поведения.</p>
        </SectionCard>
      )}

      {/* 4. Message settings */}
      {(cfg.aiPromptToggle || cfg.languageDetection) && (
      <SectionCard icon={<Sparkles size={18} />} title="Настройки сообщений"
        right={cfg.aiPromptToggle && <label className="flex items-center gap-2 text-sm text-muted">Использовать AI-промпт <Switch checked={aiPrompt} onChange={setAiPrompt} /></label>}>
        {aiPrompt && cfg.messagePrompts && (
          <div className="mb-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-bold text-fg"><FileText size={15} className="text-spark-400" /> Системные промпты <span className="text-muted">({cfg.messagePrompts.length})</span></div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {cfg.messagePrompts.map((p, i) => (
                <button key={p} onClick={() => setActivePrompt(i)} className={cn('relative rounded-xl border p-3 text-left text-sm font-semibold transition-all', i === activePrompt ? 'border-spark-500/60 bg-spark-500/8 text-fg' : 'border-line bg-elevated text-muted hover:border-spark-500/30 hover:text-fg')}>
                  {i === activePrompt && <span className="absolute right-2 top-2 flex items-center gap-0.5 text-amber-400"><Star size={12} fill="currentColor" /><Check size={12} className="text-spark-400" /></span>}
                  {p}
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2 text-sm font-bold text-fg"><Users size={15} className="text-iris-400" /> Мои промпты <span className="text-muted">(0)</span></div>
            <button onClick={() => pushToast({ type: 'info', title: 'Создание промпта (демо)' })} className="mt-2 flex h-16 w-40 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line text-sm font-semibold text-muted hover:border-spark-500/40 hover:text-fg"><Plus size={16} /> Создать</button>
          </div>
        )}

        {cfg.channelToggles && (
          <div className="grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
            <ToggleRow icon={<Megaphone size={16} />} label={cfg.channelToggles[0]} checked={sendAsChannel} onChange={setSendAsChannel} />
            <ToggleRow icon={<Eye size={16} />} label={cfg.channelToggles[1]} checked={deletionTrack} onChange={setDeletionTrack} />
          </div>
        )}

        {(cfg.languageDetection || cfg.activeHours) && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {cfg.languageDetection && (
              <div className="flex items-center justify-between rounded-xl border border-line bg-elevated/40 p-3">
                <span className="flex items-center gap-2 text-sm font-semibold text-fg"><Globe size={16} className="text-spark-400" /> Определение языка</span>
                <Segmented size="sm" options={['Авто', 'Ручной']} value={langMode} onChange={setLangMode} />
              </div>
            )}
            {cfg.activeHours && (
              <div className="flex items-center justify-between rounded-xl border border-line bg-elevated/40 p-3">
                <span className="flex items-center gap-2 text-sm font-semibold text-fg"><Clock size={16} className="text-spark-400" /> Часы активности</span>
                <label className="flex items-center gap-2 text-sm text-muted"><Switch checked={alwaysOn} onChange={setAlwaysOn} /> Всегда вкл.</label>
              </div>
            )}
          </div>
        )}
      </SectionCard>
      )}

      {/* 5. Auto-responder + conversation context */}
      {(cfg.autoResponder || cfg.conversationContext) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {cfg.autoResponder && (
            <SectionCard icon={<Mail size={18} />} title="Автоответчик">
              <Segmented options={cfg.autoResponder} value={autoResp} onChange={setAutoResp} />
            </SectionCard>
          )}
          {cfg.conversationContext && (
            <SectionCard icon={<MessageCircle size={18} />} title="Контекст диалога">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-sm text-muted">{cfg.conversationContext.label}</span>
                <span className="rounded-md bg-spark-500/12 px-2 py-0.5 text-xs font-bold text-spark-300">{ctxDepth} сообщ.</span>
              </div>
              <input type="range" min={0} max={cfg.conversationContext.max} value={ctxDepth} onChange={(e) => setCtxDepth(Number(e.target.value))} className="w-full accent-spark-500" />
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-iris-500/30 bg-iris-500/8 p-3 text-xs text-muted">
                <MessageCircle size={14} className="mt-0.5 shrink-0 text-iris-300" /> {cfg.conversationContext.hint}
              </div>
            </SectionCard>
          )}
        </div>
      )}

      {/* 5b. Organic promotion */}
      {cfg.organicPromotion && (
        <SectionCard icon={<Megaphone size={18} />} title="Органическое продвижение"
          right={<Switch checked={organicPromo} onChange={setOrganicPromo} />}>
          <p className="text-sm text-muted">Плавное наращивание активности аккаунтов для более естественного поведения и снижения риска блокировок.</p>
        </SectionCard>
      )}

      {/* 6. Additional settings / delays */}
      {cfg.delays && (
        <SectionCard icon={<Timer size={18} />} title={cfg.reactionSettings ? 'Настройка задержек' : 'Дополнительные настройки'}
          right={cfg.delayPresets && <Segmented size="sm" options={cfg.delayPresets} value={delayPreset} onChange={setDelayPreset} />}>
          <div className="space-y-3">
            {cfg.delays.map((d) => <DelayRow key={d.label} delay={d} preset={delayPreset} />)}
          </div>
        </SectionCard>
      )}

      {/* 7. Settings presets */}
      {cfg.settingsPresets && (
        <div className="card p-0">
          <button onClick={() => setPresetsOpen((v) => !v)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-iris-500/12 text-iris-400"><Bookmark size={18} /></span>
            <span className="font-display text-base font-bold text-fg">Пресеты настроек</span>
            <ChevronDown size={18} className={cn('ml-auto text-muted transition-transform', !presetsOpen && '-rotate-90')} />
          </button>
          {presetsOpen && (
            <div className="border-t border-line p-4">
              <EmptyState icon={<Bookmark size={22} />} title="Сохранённых пресетов нет" desc="Сохраните текущие настройки, чтобы быстро применять их позже." />
            </div>
          )}
        </div>
      )}

      {/* 8. Launch & logs */}
      <SectionCard icon={<Play size={18} />} title={running ? 'Выполнение' : 'Запуск и логи'} badge={running ? 'LIVE' : undefined}>
        <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <LaunchStat icon={<Users size={18} />} color="#7145ff" label="Аккаунты" value={String(selected.size)} warn={selected.size === 0} />
          <LaunchStat icon={<Hash size={18} />} color="#06b6d4" label={unit.title} value={String(channelCount)} />
          <LaunchStat icon={<Clock size={18} />} color="#0ec464" label="Макс. интервал" value={intervalStat} />
          <LaunchStat icon={cfg.reactionSettings ? <Heart size={18} /> : <MessageSquareText size={18} />} color="#f59e0b" label={unit.maxLabel} value={String(maxComments)} />
        </div>

        {!running && selected.size === 0 && (
          <div className="mb-4 flex items-center gap-2.5 rounded-2xl border border-rose-500/30 bg-rose-500/8 p-4">
            <AlertTriangle size={18} className="text-rose-400" />
            <div><div className="text-sm font-bold text-rose-300">Проблемы с конфигурацией</div><div className="text-xs text-muted">Выберите хотя бы один аккаунт</div></div>
          </div>
        )}

        <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-elevated/40 p-4 sm:flex-row">
          <div className="flex items-center gap-2 text-sm font-semibold text-muted">
            <span className={cn('h-2.5 w-2.5 rounded-full', running ? 'bg-spark-400 animate-pulse' : 'bg-faint')} /> {running ? 'Выполняется' : 'Остановлено'}
          </div>
          <div className="flex flex-1 justify-center gap-2">
            {running ? (
              <button onClick={stop} className="btn-danger h-11 min-w-[180px]"><Square size={16} /> {cfg.stopAction ?? 'Остановить'}</button>
            ) : (
              <button onClick={run} disabled={selected.size === 0} className="btn-primary h-11 min-w-[180px]"><Play size={17} /> {cfg.primaryAction}</button>
            )}
          </div>
          <div className="flex gap-2">
            {cfg.secondaryAction && <button onClick={() => pushToast({ type: 'success', title: 'Настройки сохранены' })} className="btn-ghost h-11 text-sm"><Save size={15} /> {cfg.secondaryAction}</button>}
          </div>
        </div>

        {cfg.progressBar && running && (
          <div className="mt-4 rounded-2xl border border-line bg-elevated/40 p-4">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 font-semibold text-spark-300"><Play size={14} /> Прогресс</span>
              <span className="font-mono font-bold text-fg">{Math.round(progress / 100 * maxComments)} / {maxComments}</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-spark-gradient transition-all" style={{ width: `${progress}%` }} /></div>
          </div>
        )}

        <div className="mt-4"><LogsPanel logs={logs} emptyText={cfg.logEmpty} title="Логи выполнения" live={running} /></div>

        {cfg.blacklistEmpty && !cfg.blacklistSection && (
          <div className="mt-4 rounded-2xl border border-line bg-elevated/40 p-4">
            <div className="mb-1 text-sm font-bold text-fg">Чёрный список</div>
            <p className="text-xs text-muted">{cfg.blacklistEmpty}</p>
          </div>
        )}
      </SectionCard>

      {/* 9. Reactions history (mass-react) */}
      {cfg.historySection && (
        <div className="card p-0">
          <div className="flex w-full items-center gap-3 px-4 py-3.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-spark-500/12 text-spark-400"><BarChartIcon size={18} /></span>
            <span className="font-display text-base font-bold text-fg">{cfg.historySection}</span>
            <button onClick={() => pushToast({ type: 'info', title: cfg.historySection!, desc: 'Открываю историю (демо).' })} className="btn-ghost ml-auto h-8 text-xs">{cfg.historySection}</button>
            <button onClick={() => setHistoryOpen((v) => !v)} className="btn-icon h-8 w-8"><ChevronDown size={16} className={cn('transition-transform', !historyOpen && '-rotate-90')} /></button>
          </div>
          {historyOpen && (
            <div className="border-t border-line p-4">
              <EmptyState icon={<BarChartIcon size={22} />} title="История пуста" desc="Здесь появятся прошлые запуски реакций." />
            </div>
          )}
        </div>
      )}

      {/* 10. Blacklist section (mass-react) */}
      {cfg.blacklistSection && (
        <div className="card p-0">
          <button onClick={() => setBlacklistOpen((v) => !v)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-rose-500/12 text-rose-400"><Ban size={18} /></span>
            <span className="font-display text-base font-bold text-fg">{cfg.blacklistSection}</span>
            <ChevronDown size={18} className={cn('ml-auto text-muted transition-transform', !blacklistOpen && '-rotate-90')} />
          </button>
          {blacklistOpen && (
            <div className="border-t border-line p-4">
              <p className="text-sm text-muted">{cfg.blacklistEmpty}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ══════════════════════ PARTICIPANTS PARSER (пользователи / сообщения / комментарии) ═════════════ */
interface PUser { name: string; u?: string; id?: string; premium?: boolean }
const PARSE_USERS: Record<string, PUser[]> = {
  'parsing-users': [
    { name: 'Raphael', u: 'raphaeldev2019' }, { name: 'Avy', u: 'AVY_D3AL', premium: true },
    { name: 'Ivan Hryhorovych', u: 'ivan_hryhorovych' }, { name: 'Maxim Velichko', u: 'maxxvelich', premium: true },
    { name: 'Konstantin', u: 'Gold106', premium: true },
  ],
  'parsing-messages': [{ name: 'Pavel', u: 'PavelKorzh' }],
  'parsing-comments': [
    { name: '.', id: '1198865242' }, { name: 'Vlad', id: '8938589096' }, { name: 'Klaim', u: 'DarknessAE' },
    { name: 'Юлія 🦒 Ярковенко', u: 'JuliaYarko' }, { name: 'Sebastiano', id: '1695224801' },
    { name: 'Марина Шумська', u: 'maryna_mmmm' }, { name: 'Julia Denysenko', u: 'julia_den' },
  ],
}

function Checkbox({ label, checked, onChange, star, info }: { label: string; checked: boolean; onChange: (v: boolean) => void; star?: boolean; info?: boolean }) {
  return (
    <button onClick={() => onChange(!checked)} className="flex w-full items-center gap-2.5 py-1.5 text-left">
      <span className={cn('grid h-4.5 w-4.5 shrink-0 place-items-center rounded border', checked ? 'border-spark-500 bg-spark-500 text-[#04150c]' : 'border-line')} style={{ height: 18, width: 18 }}>{checked && <Check size={12} />}</span>
      <span className="text-sm text-fg">{label}</span>
      {star && <Star size={12} className="text-amber-400" fill="currentColor" />}
      {info && <span className="grid h-3.5 w-3.5 place-items-center rounded-full border border-line text-[9px] text-muted">i</span>}
    </button>
  )
}

function ParticipantsModule({ cfg }: { cfg: ModuleConfig }) {
  const p = cfg.participants!
  const addTask = useApp((s) => s.addTask)
  const pushToast = useApp((s) => s.pushToast)
  const guardNet = useApp((s) => s.guardNet)

  const seedUrls = useMemo(() => genTargets(40).map((n) => `https://t.me/${n}`).join('\n'), [])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [aiProtect, setAiProtect] = useState(false)
  const [source, setSource] = useState(seedUrls)
  const [keywords, setKeywords] = useState<string[]>([])
  const [kwInput, setKwInput] = useState('')
  const [fastWork, setFastWork] = useState(false)
  const [limits, setLimits] = useState<number[]>(() => (p.limits ?? []).map((l) => l.value))
  const [base, setBase] = useState<Set<number>>(() => new Set((p.baseFilters).map((f, i) => (f.on ? i : -1)).filter((i) => i >= 0)))
  const [profile, setProfile] = useState<Set<number>>(new Set())
  const [activity, setActivity] = useState(false)
  const [extra, setExtra] = useState<Set<number>>(() => new Set((p.extraOptions ?? []).map((f, i) => (f.on ? i : -1)).filter((i) => i >= 0)))
  const [activeStories, setActiveStories] = useState(false)
  const [delays, setDelays] = useState<number[]>(() => p.delays.map((d) => d.value))
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<PUser[]>([])
  const [resView, setResView] = useState<'list' | 'grid'>('list')
  const [resSearch, setResSearch] = useState('')
  const [page] = useState(1)

  const addKw = () => { if (!kwInput.trim()) return; setKeywords((k) => [...new Set([...k, kwInput.trim()])]); setKwInput('') }
  const filteredRes = results.filter((r) => !resSearch || `${r.name} ${r.u ?? ''} ${r.id ?? ''}`.toLowerCase().includes(resSearch.toLowerCase()))

  const run = () => {
    if (!guardNet(cfg.primaryAction)) return
    if (selected.size === 0) return pushToast({ type: 'error', title: 'Аккаунты не выбраны', desc: 'Выберите хотя бы один аккаунт.' })
    setRunning(true)
    addTask({ module: cfg.key, title: `${cfg.title}`, status: 'running', progress: 15, accountsCount: selected.size, logCount: cfg.logSeedCount })
    setTimeout(() => { setResults(PARSE_USERS[cfg.key] ?? []); setRunning(false); pushToast({ type: 'success', title: 'Парсинг завершён', desc: `Найдено ${p.resultCount} пользователей.` }) }, 1400)
  }

  return (
    <div className="space-y-4">
      {/* 1. Accounts */}
      <AccountPicker selected={selected} onChange={setSelected} actions={cfg.accountActions} withFilters={!!cfg.accountFilters} selectedTitle={cfg.selectedTitle ?? 'Выбрано'} />

      {/* 2. Settings */}
      <SectionCard icon={<Settings2 size={18} />} title="Настройки парсинга" badge={p.keywords ? undefined : `${p.unit.count} целей`}>
        {cfg.aiProtection && (
          <div className="mb-4 flex items-center gap-3 rounded-2xl border border-spark-500/40 bg-spark-500/8 p-4">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-spark-500/15 text-spark-400"><Shield size={20} /></div>
            <div className="flex-1"><div className="flex items-center gap-2"><span className="font-bold text-fg">Защита аккаунтов ИИ</span><Badge tone="spark">NEW</Badge></div><div className="text-xs text-muted">Умная защита от блокировок, заморозок и банов с помощью ИИ. Снижает риск бана на 97%.</div></div>
            <Switch checked={aiProtect} onChange={setAiProtect} />
          </div>
        )}
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Left: source + keywords */}
          <div className="space-y-4">
            <div className="rounded-2xl border border-line bg-elevated/40 p-4">
              <div className="mb-2 flex items-start gap-2.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sky-500/15 text-sky-400"><Send size={16} /></span>
                <div><div className="text-sm font-bold text-fg">{p.sourceTitle}</div><div className="text-xs text-muted">{p.sourceHint}</div></div>
              </div>
              <textarea value={source} onChange={(e) => setSource(e.target.value)} rows={10} className="input resize-none font-mono text-xs" />
              {p.formatHint && <div className="mt-2 flex items-center justify-between gap-2"><span className="text-[11px] text-muted">ℹ {p.formatHint}</span>{p.historyBtn && <button onClick={() => { setSource((s) => `https://t.me/history_import\n${s}`); pushToast({ type: 'success', title: p.historyBtn!, desc: 'Импортировано (демо).' }) }} className="btn-iris h-8 shrink-0 text-xs"><HistoryIcon size={13} /> {p.historyBtn}</button>}</div>}
              {!p.formatHint && p.historyBtn && <button onClick={() => pushToast({ type: 'success', title: p.historyBtn!, desc: 'Импортировано (демо).' })} className="btn-iris mt-2 h-9 text-sm"><HistoryIcon size={14} /> {p.historyBtn}</button>}
            </div>
            {p.keywords && (
              <div className="rounded-2xl border border-line bg-elevated/40 p-4">
                <div className="mb-1 flex items-center gap-2 text-sm font-bold text-fg"><Search size={15} className="text-iris-400" /> {p.keywords.label} <span className="rounded bg-elevated px-1.5 py-0.5 text-[10px] font-bold uppercase text-muted">необязательно</span></div>
                <div className="mb-2 text-xs text-muted">{p.keywords.hint}</div>
                <div className="flex gap-2">
                  <input value={kwInput} onChange={(e) => setKwInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addKw()} className="input" placeholder="Введите ключевое слово" />
                  <button onClick={addKw} className="btn-iris h-[42px] w-11 shrink-0 px-0"><Plus size={18} /></button>
                </div>
                {keywords.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{keywords.map((k) => <span key={k} className="inline-flex items-center gap-1 rounded-lg border border-iris-500/30 bg-iris-500/8 px-2 py-1 text-xs text-fg">{k}<button onClick={() => setKeywords((a) => a.filter((x) => x !== k))} className="text-faint hover:text-rose-300"><X size={12} /></button></span>)}</div>}
              </div>
            )}
          </div>

          {/* Right: filters */}
          <div className="space-y-3">
            <ToggleRow icon={<Bolt size={16} />} label="Быстрая работа" checked={fastWork} onChange={setFastWork} />
            {p.limits && (
              <div className="rounded-2xl border border-line bg-elevated/40 p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-bold text-fg"><SlidersHorizontal size={15} className="text-amber-400" /> Лимиты</div>
                <div className="space-y-3">
                  {p.limits.map((l, i) => (
                    <div key={l.label}>
                      <div className="mb-1 text-sm font-semibold text-fg">{l.label}</div>
                      <input type="number" value={limits[i]} onChange={(e) => setLimits((arr) => arr.map((v, j) => (j === i ? Number(e.target.value) : v)))} className="input h-10" />
                      <div className="mt-0.5 text-[11px] text-muted">{l.hint}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-line bg-elevated/40 p-3">
                <div className="mb-1 flex items-center gap-2 text-sm font-bold text-fg"><Filter size={14} className="text-spark-400" /> Базовые фильтры</div>
                {p.baseFilters.map((f, i) => <Checkbox key={f.label} label={f.label} checked={base.has(i)} onChange={() => { const n = new Set(base); n.has(i) ? n.delete(i) : n.add(i); setBase(n) }} />)}
              </div>
              <div className="rounded-2xl border border-line bg-elevated/40 p-3">
                <div className="mb-1 flex items-center gap-2 text-sm font-bold text-fg"><Users size={14} className="text-pink-400" /> Фильтры профиля</div>
                {p.profileFilters.map((f, i) => <Checkbox key={f.label} label={f.label} checked={profile.has(i)} onChange={() => { const n = new Set(profile); n.has(i) ? n.delete(i) : n.add(i); setProfile(n) }} star={f.premium} info={f.admin} />)}
              </div>
            </div>
            {(p.activityFilter || p.extraOptions) && (
              <div className="grid gap-3 sm:grid-cols-2">
                {p.activityFilter && <div className="rounded-2xl border border-line bg-elevated/40 p-3"><div className="mb-1 flex items-center gap-2 text-sm font-bold text-fg"><Activity size={14} className="text-spark-400" /> Фильтры активности</div><Checkbox label="Только активные пользователи" checked={activity} onChange={setActivity} /></div>}
                {p.extraOptions && <div className="rounded-2xl border border-line bg-elevated/40 p-3"><div className="mb-1 flex items-center gap-2 text-sm font-bold text-fg"><Settings2 size={14} className="text-spark-400" /> Дополнительные опции</div>{p.extraOptions.map((f, i) => <Checkbox key={f.label} label={f.label} checked={extra.has(i)} onChange={() => { const n = new Set(extra); n.has(i) ? n.delete(i) : n.add(i); setExtra(n) }} />)}</div>}
              </div>
            )}
            {p.activeStories && (
              <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-elevated/40 p-3">
                <span className="flex items-center gap-2.5"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-spark-500/12 text-spark-400"><Eye size={16} /></span><span><span className="block text-sm font-semibold text-fg">Только с активной историей</span><span className="block text-xs text-muted">Оставить только пользователей, у которых сейчас есть активная сторис</span></span></span>
                <Switch checked={activeStories} onChange={setActiveStories} />
              </div>
            )}
            <div className="rounded-2xl border border-line bg-elevated/40 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-bold text-fg"><Timer size={15} className="text-amber-400" /> Настройки задержек</div>
              {p.delays.map((d, i) => (
                <div key={d.label} className="mb-2 last:mb-0">
                  <div className="mb-1 flex items-center justify-between"><span className="text-sm text-muted">{d.label}</span><span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-bold text-amber-400">{delays[i]}s</span></div>
                  <input type="range" min={0} max={10} step={0.5} value={delays[i]} onChange={(e) => setDelays((arr) => arr.map((v, j) => (j === i ? Number(e.target.value) : v)))} className="w-full accent-spark-500" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </SectionCard>

      {/* 3. Launch */}
      <SectionCard icon={<Play size={18} />} title="Запуск & Логи">
        <div className="mb-4 grid grid-cols-3 gap-2.5">
          <LaunchStat icon={<Users size={18} />} color="#7145ff" label="Аккаунты" value={String(selected.size)} warn={selected.size === 0} />
          <LaunchStat icon={<Send size={18} />} color="#06b6d4" label={p.unit.title} value={String(p.unit.count)} />
          <LaunchStat icon={<Database size={18} />} color="#0ec464" label={p.unit.limitLabel} value={String(p.unit.limitValue)} />
        </div>
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-elevated/40 p-4 sm:flex-row">
          <div className="flex items-center gap-2 text-sm font-semibold text-muted"><span className={cn('h-2.5 w-2.5 rounded-full', running ? 'bg-spark-400 animate-pulse' : 'bg-faint')} /> {running ? 'Выполняется' : 'Остановлено'}</div>
          <div className="flex flex-1 justify-center">{running ? <button className="btn-danger h-11 min-w-[160px]"><Square size={16} /> Остановить</button> : <button onClick={run} disabled={selected.size === 0} className="btn-iris h-11 min-w-[160px]"><Play size={17} /> {cfg.primaryAction}</button>}</div>
        </div>
      </SectionCard>

      {/* 4. Results */}
      <SectionCard icon={<Database size={18} />} title={cfg.resultsTitle ?? 'Результаты парсинга'} badge={results.length ? String(p.resultCount) : '0'}
        right={<div className="inline-flex rounded-lg border border-line bg-elevated p-0.5"><button onClick={() => setResView('list')} className={cn('rounded p-1.5', resView === 'list' ? 'bg-surface text-fg' : 'text-muted')}><List size={15} /></button><button onClick={() => setResView('grid')} className={cn('rounded p-1.5', resView === 'grid' ? 'bg-surface text-fg' : 'text-muted')}><LayoutGrid size={15} /></button></div>}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-xs"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input value={resSearch} onChange={(e) => setResSearch(e.target.value)} className="input h-9 pl-9 text-sm" placeholder="Поиск результатов…" /></div>
          <Select className="w-44" value="" onChange={() => {}} placeholder="Сортировать по..." options={['Имя', 'Username', 'Активность'].map((s) => ({ value: s, label: s }))} />
          <button className="btn-icon h-9 w-9"><ArrowUpDown size={15} /></button>
          <button onClick={() => { setResults([]); pushToast({ type: 'info', title: 'Результаты очищены' }) }} className="btn-danger h-9 text-sm"><Trash2 size={14} /> Очистить</button>
          <button onClick={() => pushToast({ type: 'success', title: 'Ссылки скопированы' })} className="btn-iris h-9 text-sm"><Copy size={14} /> Скопировать ссылки</button>
          <button onClick={() => pushToast({ type: 'success', title: 'ID скопированы' })} className="btn-iris h-9 text-sm"><Hash size={14} /> Скопировать ID</button>
          <button onClick={() => pushToast({ type: 'success', title: 'Экспорт (демо)' })} className="btn-primary h-9 text-sm"><Download size={14} /> Экспорт</button>
        </div>
        {filteredRes.length === 0 ? (
          <EmptyState icon={<Database size={26} />} title="Результатов пока нет" desc="Запустите парсинг, чтобы увидеть результаты." />
        ) : (
          <>
            <div className={cn(resView === 'grid' ? 'grid gap-2 sm:grid-cols-2' : 'space-y-2')}>
              {filteredRes.map((r, i) => (
                <div key={i} className="flex items-center gap-3 rounded-xl border border-line bg-elevated/40 p-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-spark-500/12 text-spark-400"><Users size={18} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5"><span className="truncate text-sm font-bold text-fg">{r.name}</span>{r.premium && <Star size={12} className="text-amber-400" fill="currentColor" />}<span className="shrink-0 rounded bg-spark-500/12 px-1.5 py-0.5 text-[10px] font-bold text-spark-300">ПОЛЬЗОВАТЕЛЬ</span></div>
                    <div className="truncate text-xs text-muted">{r.u ? <span className="text-iris-300/80">@{r.u}</span> : `ID: ${r.id}`}</div>
                  </div>
                  {r.u && <button className="btn-icon h-8 w-8"><ExternalLink size={14} /></button>}
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-sm text-muted">
              <span>Показано 1-{filteredRes.length} из {p.resultCount}</span>
              <div className="flex items-center gap-1"><button className="btn-icon h-8 w-8">«</button><button className="btn-icon h-8 w-8">‹</button><span className="px-2 font-semibold text-fg">{page} / 1</span><button className="btn-icon h-8 w-8">›</button><button className="btn-icon h-8 w-8">»</button></div>
              <div className="flex items-center gap-2">На странице: <Select className="w-20" value="10" onChange={() => {}} options={[10, 25, 50].map((n) => ({ value: String(n), label: String(n) }))} /></div>
            </div>
          </>
        )}
      </SectionCard>
    </div>
  )
}

/* ══════════════════════ PARSER LAYOUT (Парсинг каналов) ══════════════════════ */
const PARSE_CHANNELS = [
  { name: 'Остеопрактика - остеопатия, биодинамика, массаж', u: 'osteopractika_school', m: 12700 },
  { name: 'Body_lab_Nazarenko', u: 'massage_nazarenko', m: 327 },
  { name: 'Лапченко | Wellness Massage', u: 'lapchenko_massage', m: 156 },
  { name: 'Lay Back', u: 'layback_massage', m: 2100 },
  { name: 'СТО Мастер', u: 'sto_master_ua', m: 5400 },
  { name: 'Авторемонт Днепр', u: 'autorepair_dp', m: 890 },
  { name: 'Dev Hunters', u: 'dev_hunters', m: 3200 },
  { name: 'Bot Factory', u: 'bot_factory_ua', m: 1450 },
  { name: 'Massage Space', u: 'massage_space', m: 640 },
]
const PARSE_GROUPS = [
  { name: 'Машинариум: чат для бизнеса', u: 'mashinariumchat', m: 142 },
  { name: 'Канал "МАШИНА" (обсуждение)', u: 'kanal_mashina_chat', m: 167 },
  { name: 'КОНТЕНТ МАШИНА - Chat', u: 'content_machine_chat', m: 16 },
  { name: 'Иномарка бозор чат', u: 'inomarka_mashina_bozor', m: 264 },
  { name: 'СТО Профи · Чат', u: 'sto_profi_chat', m: 512 },
  { name: 'Барбершоп Комьюнити', u: 'barber_community', m: 1230 },
  { name: 'ЖК Новостройки · Обсуждение', u: 'jk_novostroyki', m: 3400 },
  { name: 'Фуд-корт Днепр', u: 'foodcourt_dp', m: 780 },
  { name: 'Авто P2P Чат', u: 'auto_p2p_chat', m: 950 },
]
const AI_KW = [
  { w: 'car service', p: 88 }, { w: 'auto repair', p: 85 }, { w: 'hire developer', p: 87 },
  { w: 'create bot', p: 82 }, { w: 'wellness', p: 79 }, { w: 'spa massage', p: 84 },
]

function ParsingModule({ cfg }: { cfg: ModuleConfig }) {
  const addTask = useApp((s) => s.addTask)
  const pushToast = useApp((s) => s.pushToast)
  const guardNet = useApp((s) => s.guardNet)

  const AI_SUGGEST = cfg.aiKeywords ?? AI_KW
  const RESULT_DATA = cfg.key === 'parsing-groups' ? PARSE_GROUPS : PARSE_CHANNELS
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [tmplOpen, setTmplOpen] = useState(!cfg.templatesCollapsed)
  const [tmplSearch, setTmplSearch] = useState('')
  const [hideSystem, setHideSystem] = useState(false)
  const [aiProtect, setAiProtect] = useState(false)
  const [method, setMethod] = useState(0)
  const [kwMode, setKwMode] = useState(0)
  const [keywords, setKeywords] = useState<string[]>(cfg.defaultKeywords ?? [])
  const [kwInput, setKwInput] = useState('')
  const [endMode, setEndMode] = useState(1)
  const [endLang, setEndLang] = useState(cfg.endLangDefault ?? 'en')
  const [endCount, setEndCount] = useState(10)
  const [fastWork, setFastWork] = useState(false)
  const [skipParsed, setSkipParsed] = useState(cfg.commentFilter ?? false)
  const [limitChip, setLimitChip] = useState<number | '∞'>(cfg.defaultLimit ?? '∞')
  const [activityF, setActivityF] = useState(cfg.defaultActivity ?? 1)
  const [commentF, setCommentF] = useState(0)
  const [minComments, setMinComments] = useState(0)
  const [delayReq, setDelayReq] = useState(2.0)
  const [delayCh, setDelayCh] = useState(1.0)
  const [minMembers, setMinMembers] = useState(cfg.defaultMinMembers ?? 100)
  const [maxMembers, setMaxMembers] = useState(100000)
  const [mailRating, setMailRating] = useState(1)
  const [langDetect, setLangDetect] = useState(false)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<{ name: string; u: string; m: number }[]>([])
  const [resView, setResView] = useState<'list' | 'grid'>('list')
  const [resSearch, setResSearch] = useState('')
  const [resSort, setResSort] = useState('')

  const templates = (cfg.templates ?? []).filter((t) => !tmplSearch || t.name.toLowerCase().includes(tmplSearch.toLowerCase()))
  const queries = Math.max(1, keywords.length) * 11
  const addKw = () => { const p = kwInput.split(',').map((s) => s.trim()).filter(Boolean); if (!p.length) return; setKeywords((k) => [...new Set([...k, ...p])]); setKwInput('') }
  const filteredResults = results.filter((r) => !resSearch || `${r.name} ${r.u}`.toLowerCase().includes(resSearch.toLowerCase()))
    .sort((a, b) => resSort === 'Участники' ? b.m - a.m : resSort === 'Название' ? a.name.localeCompare(b.name) : 0)

  const run = () => {
    if (!guardNet(cfg.primaryAction)) return
    if (selected.size === 0) return pushToast({ type: 'error', title: 'Аккаунты не выбраны', desc: 'Выберите хотя бы один аккаунт.' })
    if (keywords.length === 0) return pushToast({ type: 'error', title: 'Нет ключевых слов' })
    setRunning(true)
    addTask({ module: cfg.key, title: `${cfg.title} · ${keywords.length} кл. слов`, status: 'running', progress: 15, accountsCount: selected.size, logCount: 0 })
    setTimeout(() => { setResults(RESULT_DATA); setRunning(false); pushToast({ type: 'success', title: 'Парсинг завершён', desc: `Найдено ${RESULT_DATA.length} ${cfg.key === 'parsing-groups' ? 'групп' : 'каналов'}.` }) }, 1400)
  }

  return (
    <div className="space-y-4">
      {/* 1. Accounts */}
      <AccountPicker selected={selected} onChange={setSelected} actions={cfg.accountActions} withFilters={!!cfg.accountFilters} selectedTitle={cfg.selectedTitle ?? 'Выбрано'} />

      {/* 2. Templates */}
      {cfg.templates && (
        <div className="card p-0">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber-500/12 text-amber-400"><Bookmark size={18} /></span>
            <span className="font-display text-base font-bold text-fg">{cfg.templatesTitle ?? 'Шаблоны'}</span>
            {cfg.templatesBadge && <span className="rounded-md bg-elevated px-2 py-0.5 text-[10px] font-bold uppercase text-muted">{cfg.templatesBadge}</span>}
            <span className="hidden text-xs text-muted sm:inline">Используйте шаблоны для быстрой настройки параметров поиска</span>
            <button onClick={() => setTmplOpen((v) => !v)} className="btn-icon ml-auto h-8 w-8"><ChevronDown size={16} className={cn('transition-transform', !tmplOpen && '-rotate-90')} /></button>
          </div>
          {tmplOpen && (
            <div className="border-t border-line p-4">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <div className="relative min-w-0 flex-1">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                  <input value={tmplSearch} onChange={(e) => setTmplSearch(e.target.value)} className="input pl-9" placeholder="Поиск шаблонов…" />
                </div>
                <Switch checked={hideSystem} onChange={setHideSystem} label="Скрыть системные" />
                <button onClick={() => pushToast({ type: 'info', title: 'Новый шаблон (демо)' })} className="btn-iris h-10"><Plus size={16} /> Новый шаблон</button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((t) => (
                  <div key={t.name} className="flex flex-col rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="grid h-8 w-8 place-items-center rounded-lg bg-amber-500/15 text-amber-400"><Bookmark size={15} /></span>
                      <span className="text-sm font-bold text-fg">{t.name}</span>
                    </div>
                    <span className="mb-1 inline-flex w-max items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-400"><Star size={10} fill="currentColor" /> СИСТЕМНЫЙ</span>
                    <p className="mb-3 text-xs text-muted">{t.desc}</p>
                    <div className="mb-2 flex items-center gap-3 text-xs text-muted"><span className="flex items-center gap-1"><Tag size={12} /> {t.kw} ключевых слов</span><span className="flex items-center gap-1"><Users size={12} /> 10-</span></div>
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      {t.chips.map((c) => <span key={c} className="rounded-lg border border-iris-500/30 bg-iris-500/8 px-2 py-0.5 text-xs text-iris-300">{c}</span>)}
                      <span className="rounded-lg bg-elevated px-2 py-0.5 text-xs text-muted">+{t.extra}</span>
                    </div>
                    <button onClick={() => { pushToast({ type: 'success', title: 'Шаблон применён', desc: t.name }); setKeywords(t.chips) }} className="btn-ghost mt-auto h-9 w-full border-spark-500/40 text-sm text-spark-300"><Check size={15} /> Применить</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 3. Search settings */}
      <SectionCard icon={<Search size={18} />} title="Настройки поиска" badge={`${keywords.length} Ключевые слова`}>
        {cfg.aiProtection && (
          <div className="mb-4 flex items-center gap-3 rounded-2xl border border-spark-500/40 bg-spark-500/8 p-4">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-spark-500/15 text-spark-400"><Shield size={20} /></div>
            <div className="flex-1"><div className="flex items-center gap-2"><span className="font-bold text-fg">Защита аккаунтов ИИ</span><Badge tone="spark">NEW</Badge></div><div className="text-xs text-muted">Умная защита от блокировок, заморозок и банов с помощью ИИ. Снижает риск бана на 97%.</div></div>
            <Switch checked={aiProtect} onChange={setAiProtect} />
          </div>
        )}
        {cfg.methodTabs && <Segmented className="mb-4" options={cfg.methodTabs} value={method} onChange={setMethod} size="sm" />}

        <div className="grid gap-5 lg:grid-cols-2">
          {/* Left: keywords */}
          <div className="space-y-4">
            <div>
              <div className="text-sm font-bold text-fg">Ключевые слова <span className="text-rose-400">*</span></div>
              <div className="text-xs text-muted">Слова через запятую…</div>
            </div>
            <Segmented options={['Теги', 'Промпт']} value={kwMode} onChange={setKwMode} size="sm" />
            <div className="flex gap-2">
              <input value={kwInput} onChange={(e) => setKwInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addKw()} className="input" placeholder="Слова через запятую…" />
              <button onClick={addKw} className="btn-primary h-[42px] shrink-0 px-4"><Plus size={16} /> Добавить</button>
            </div>
            {keywords.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {keywords.map((k) => (
                  <span key={k} className="inline-flex items-center gap-1 rounded-lg border border-spark-500/30 bg-spark-500/8 px-2 py-1 text-xs text-fg">{k}<button onClick={() => setKeywords((a) => a.filter((x) => x !== k))} className="text-faint hover:text-rose-300"><X size={12} /></button></span>
                ))}
                <button onClick={() => setKeywords([])} className="rounded-lg border border-rose-500/30 px-2 py-1 text-xs font-semibold text-rose-300"><Trash2 size={11} className="mr-1 inline" />Очистить всё</button>
              </div>
            )}
            <div className="rounded-2xl border border-line bg-elevated/40 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-bold text-fg"><Sparkles size={15} className="text-iris-400" /> ИИ-предложенные ключевые слова <button className="ml-auto btn-icon h-6 w-6"><RefreshCw size={12} /></button></div>
              <div className="flex gap-2 overflow-x-auto no-scrollbar">
                {AI_SUGGEST.map((k) => (
                  <button key={k.w} onClick={() => setKeywords((a) => [...new Set([...a, k.w])])} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 text-xs">
                    {k.w} <span className="rounded bg-amber-500/15 px-1 text-[10px] font-bold text-amber-400">{k.p}%</span> <Plus size={12} className="text-iris-400" />
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 flex items-center gap-2 text-sm font-bold text-amber-400"><Bookmark size={15} /> Окончания</div>
              <div className="mb-2 text-xs text-muted">Добавьте окончания для комбинации с ключевыми словами</div>
              <Segmented className="mb-3" options={['Вручную', 'Авто']} value={endMode} onChange={setEndMode} size="sm" />
              <span className="label">Язык окончаний</span>
              <Select className="mb-3" value={endLang} onChange={setEndLang} options={[{ value: 'en', label: '🇬🇧 English' }, { value: 'ru', label: '🇷🇺 Русский' }, { value: 'ua', label: '🇺🇦 Українська' }]} />
              <div className="mb-1 flex items-center justify-between"><span className="text-sm text-muted">Количество окончаний</span><span className="rounded-md bg-spark-500/12 px-2 py-0.5 text-xs font-bold text-spark-300">{endCount}</span></div>
              <input type="range" min={5} max={30} value={endCount} onChange={(e) => setEndCount(Number(e.target.value))} className="w-full accent-spark-500" />
              <div className="flex justify-between text-[11px] text-muted"><span>Быстро (5)</span><span>Тщательно (30)</span></div>
              <div className="mt-2 rounded-lg border border-line bg-elevated/40 p-2 text-xs text-muted">ℹ {endCount} окончаний × {queries} поисковых запросов</div>
            </div>
          </div>

          {/* Right: filters */}
          <div className="space-y-3">
            <ToggleRow icon={<Bolt size={16} />} label="Быстрая работа" checked={fastWork} onChange={setFastWork} />
            <div className="rounded-xl border border-line bg-elevated/40 p-3">
              <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-sm font-semibold text-fg"><Filter size={16} className="text-spark-400" /> Не собирать уже спарсенные</span><Switch checked={skipParsed} onChange={setSkipParsed} /></div>
              {skipParsed && <div className="mt-2 rounded-lg border border-iris-500/20 bg-iris-500/8 p-2 text-xs text-muted">ℹ Из результатов вырежем каналы/группы из вашей истории парсинга — только свежие.</div>}
            </div>
            <div>
              <div className="mb-1.5 flex items-center gap-2 text-sm font-bold text-fg"><Database size={15} className="text-spark-400" /> Лимит результатов</div>
              <div className="flex flex-wrap gap-1.5">
                {[10, 25, 50, 100, 200, 500].map((n) => <button key={n} onClick={() => setLimitChip(n)} className={cn('min-w-[46px] rounded-lg border px-3 py-1.5 text-sm font-semibold', limitChip === n ? 'border-spark-500/50 bg-spark-500/12 text-spark-300' : 'border-line bg-elevated text-muted hover:text-fg')}>{n}</button>)}
                <button onClick={() => pushToast({ type: 'info', title: 'Свой лимит (демо)' })} className="rounded-lg border border-line bg-elevated px-3 py-1.5 text-muted"><Pencil size={14} /></button>
                <button onClick={() => setLimitChip('∞')} className={cn('rounded-lg border px-3 py-1.5 text-sm font-bold', limitChip === '∞' ? 'border-spark-500/50 bg-spark-500 text-[#04150c]' : 'border-line bg-elevated text-muted')}>∞</button>
              </div>
            </div>
            <div>
              <div className="mb-1.5 flex items-center gap-2 text-sm font-bold text-fg"><Activity size={15} className="text-spark-400" /> Фильтр активности</div>
              <Segmented options={['Любая активность', 'Только активные', 'Неактивные']} value={activityF} onChange={setActivityF} size="sm" />
            </div>
            {cfg.commentFilter && (
              <div>
                <div className="mb-1.5 flex items-center gap-2 text-sm font-bold text-fg"><MessageCircle size={15} className="text-spark-400" /> Фильтр комментариев</div>
                <Segmented className="mb-2" options={['Любые', 'Только открытые комментарии', 'Только закрытые комментарии']} value={commentF} onChange={setCommentF} size="sm" />
                <div className="flex items-center justify-between rounded-xl border border-line bg-elevated/40 p-2.5"><span className="text-sm text-muted">Мин. комментариев на пост</span><input type="number" value={minComments} onChange={(e) => setMinComments(Number(e.target.value))} className="input h-9 w-20 text-center" /></div>
              </div>
            )}
            <div className="rounded-2xl border border-line bg-elevated/40 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-bold text-fg"><Timer size={15} className="text-spark-400" /> Настройки задержек</div>
              <div className="mb-2 flex items-center justify-between"><span className="text-sm text-muted">Задержка между запросами (сек):</span><span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-bold text-amber-400">{delayReq.toFixed(1)}s</span></div>
              <input type="range" min={0} max={10} step={0.5} value={delayReq} onChange={(e) => setDelayReq(Number(e.target.value))} className="mb-3 w-full accent-spark-500" />
              <div className="mb-2 flex items-center justify-between"><span className="text-sm text-muted">Задержка между каналами</span><span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-bold text-amber-400">{delayCh.toFixed(1)}s</span></div>
              <input type="range" min={0} max={10} step={0.5} value={delayCh} onChange={(e) => setDelayCh(Number(e.target.value))} className="w-full accent-spark-500" />
            </div>
          </div>
        </div>

        {/* Members range + rating + lang */}
        <div className="mt-5 space-y-4 border-t border-line pt-4">
          <div>
            <span className="label">Диапазон участников</span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted">Минимум</span><input type="number" value={minMembers} onChange={(e) => setMinMembers(Number(e.target.value))} className="input h-10 w-28" />
              <span className="text-muted">—</span>
              <span className="text-sm text-muted">Максимум</span><input type="number" value={maxMembers} onChange={(e) => setMaxMembers(Number(e.target.value))} className="input h-10 w-32" />
            </div>
          </div>
          <div>
            <div className="mb-1 flex items-center gap-2"><span className="text-sm font-semibold text-fg">Рейтинг для рассылки</span><input type="number" value={mailRating} onChange={(e) => setMailRating(Number(e.target.value))} className="input h-9 w-16 text-center" /><span className="rounded-md bg-iris-500/15 px-2 py-0.5 text-xs font-bold text-iris-300">{mailRating}/10</span></div>
            <input type="range" min={1} max={10} value={mailRating} onChange={(e) => setMailRating(Number(e.target.value))} className="w-full max-w-md accent-iris-500" />
          </div>
          <ToggleRow icon={<Globe size={16} />} label="Определение языка" checked={langDetect} onChange={setLangDetect} />
        </div>
      </SectionCard>

      {/* 4. Launch */}
      <SectionCard icon={<Play size={18} />} title={running ? 'Выполнение & Логи' : 'Запуск & Логи'} badge={running ? 'LIVE' : undefined}>
        <div className="mb-4 grid grid-cols-3 gap-2.5">
          <LaunchStat icon={<Users size={18} />} color="#7145ff" label="Аккаунты" value={String(selected.size)} warn={selected.size === 0} />
          <LaunchStat icon={<Search size={18} />} color="#06b6d4" label="Ключевые слова" value={String(keywords.length)} />
          <LaunchStat icon={<Database size={18} />} color="#0ec464" label="Макс. результатов" value={limitChip === '∞' ? '∞' : String(limitChip)} />
        </div>
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-elevated/40 p-4 sm:flex-row">
          <div className="flex items-center gap-2 text-sm font-semibold text-muted"><span className={cn('h-2.5 w-2.5 rounded-full', running ? 'bg-spark-400 animate-pulse' : 'bg-faint')} /> {running ? 'Выполняется' : 'Остановлено'}</div>
          <div className="flex flex-1 justify-center">
            {running ? <button className="btn-danger h-11 min-w-[180px]"><Square size={16} /> Остановить</button> : <button onClick={run} disabled={selected.size === 0} className="btn-iris h-11 min-w-[180px]"><Play size={17} /> {cfg.primaryAction}</button>}
          </div>
        </div>
      </SectionCard>

      {/* 5. Results */}
      <SectionCard icon={<Database size={18} />} title={cfg.resultsTitle ?? 'Результаты поиска'} badge={`${filteredResults.length}`}
        right={<div className="inline-flex rounded-lg border border-line bg-elevated p-0.5"><button onClick={() => setResView('list')} className={cn('rounded p-1.5', resView === 'list' ? 'bg-surface text-fg' : 'text-muted')}><List size={15} /></button><button onClick={() => setResView('grid')} className={cn('rounded p-1.5', resView === 'grid' ? 'bg-surface text-fg' : 'text-muted')}><LayoutGrid size={15} /></button></div>}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-xs"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><input value={resSearch} onChange={(e) => setResSearch(e.target.value)} className="input h-9 pl-9 text-sm" placeholder="Поиск результатов…" /></div>
          <Select className="w-44" value={resSort} onChange={setResSort} placeholder="Сортировать по..." options={['Участники', 'Название', 'Username'].map((s) => ({ value: s, label: s }))} />
          <button className="btn-icon h-9 w-9"><ArrowUpDown size={15} /></button>
          <button onClick={() => { setResults([]); pushToast({ type: 'info', title: 'Результаты очищены' }) }} className="btn-danger h-9 text-sm"><Trash2 size={14} /> Очистить</button>
          <button onClick={() => pushToast({ type: 'success', title: 'Ссылки скопированы' })} className="btn-iris h-9 text-sm"><Copy size={14} /> Скопировать ссылки</button>
          <button onClick={() => pushToast({ type: 'success', title: 'ID скопированы' })} className="btn-iris h-9 text-sm"><Hash size={14} /> Скопировать ID</button>
          <button onClick={() => pushToast({ type: 'success', title: 'Экспорт (демо)' })} className="btn-primary h-9 text-sm"><Download size={14} /> Экспорт</button>
        </div>
        {filteredResults.length === 0 ? (
          <EmptyState icon={<Database size={26} />} title="Результатов пока нет" desc="Запустите парсинг, чтобы увидеть результаты." />
        ) : (
          <div className={cn(resView === 'grid' ? 'grid gap-2 sm:grid-cols-2' : 'space-y-2')}>
            {filteredResults.map((r) => (
              <div key={r.u} className="flex items-center gap-3 rounded-xl border border-line bg-elevated/40 p-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-iris-500/12 text-iris-400">{cfg.resultLabel === 'ГРУППА' ? <Users size={18} /> : <Radio size={18} />}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className="truncate text-sm font-bold text-fg">{r.name}</span><span className="shrink-0 rounded bg-iris-500/12 px-1.5 py-0.5 text-[10px] font-bold text-iris-300">{cfg.resultLabel ?? 'КАНАЛ'}</span></div>
                  <div className="truncate text-xs text-muted"><span className="text-iris-300/80">@{r.u}</span> · <Users size={11} className="inline" /> {compact(r.m)}</div>
                </div>
                <button className="btn-icon h-8 w-8"><ExternalLink size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  )
}

/* ══════════════════════ GGR LAYOUT (GramGPT Рейтинг) ══════════════════════ */
const GEO_BEST = [
  { c: 'AR', f: '🇦🇷', p: 68.4, d: 26 }, { c: 'UA', f: '🇺🇦', p: 56.5, d: 51 }, { c: 'PL', f: '🇵🇱', p: 52.1, d: 53 },
  { c: 'TH', f: '🇹🇭', p: 51.6, d: 27 }, { c: 'NG', f: '🇳🇬', p: 51.6, d: 36 }, { c: 'UZ', f: '🇺🇿', p: 51.5, d: 50 },
  { c: 'BR', f: '🇧🇷', p: 46.5, d: 46 }, { c: 'RU', f: '🇷🇺', p: 44.5, d: 64 }, { c: 'CA', f: '🇨🇦', p: 43.3, d: 44 },
  { c: 'KZ', f: '🇰🇿', p: 43.0, d: 52 },
]
const GEO_WORST = [
  { c: 'BD', f: '🇧🇩', p: 19.5, d: 52 }, { c: 'ES', f: '🇪🇸', p: 21.0, d: 76 }, { c: 'IN', f: '🇮🇳', p: 25.8, d: 70 },
  { c: 'DE', f: '🇩🇪', p: 26.4, d: 65 }, { c: 'ID', f: '🇮🇩', p: 26.5, d: 60 }, { c: 'MM', f: '🇲🇲', p: 29.1, d: 60 },
  { c: 'CO', f: '🇨🇴', p: 33.6, d: 63 }, { c: 'US', f: '🇺🇸', p: 34.7, d: 67 }, { c: 'CL', f: '🇨🇱', p: 41.9, d: 53 },
  { c: 'GB', f: '🇬🇧', p: 42.9, d: 58 },
]
const GGR_STATUS: Record<string, string> = { active: 'ВАЛИДНЫЙ', working: 'ВАЛИДНЫЙ', quarantine: 'ВАЛИДНЫЙ', frozen: 'ЗАМОРОЖЕН', reauth: 'РАЗАВТОРИЗ.', invalid: 'НЕВАЛИДНЫЙ', spamblock: 'СПАМБЛОК' }

function GgrModule({ cfg }: { cfg: ModuleConfig }) {
  const accounts = activeAccounts(useApp((s) => s.data))
  const pushToast = useApp((s) => s.pushToast)
  const guardNet = useApp((s) => s.guardNet)

  const [sourceTab, setSourceTab] = useState(0)
  const [statusFilter, setStatusFilter] = useState('Все статусы')
  const [sort, setSort] = useState('По умолчанию')
  const [filter, setFilter] = useState('')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [scores, setScores] = useState<Record<string, number>>(() => (accounts[0] ? { [accounts[0].id]: accounts[0].ggr ?? 60 } : {}))
  const [activeId, setActiveId] = useState<string | null>(null)

  const filtered = accounts.filter((a) => {
    if (statusFilter === 'Валидный' && a.status !== 'active') return false
    if (statusFilter === 'Заморожен' && a.status !== 'frozen') return false
    if (statusFilter === 'Разавторизирован' && a.status !== 'reauth') return false
    if (statusFilter === 'Невалидный' && a.status !== 'invalid') return false
    if (filter && !`${a.name} ${a.username} ${a.phone}`.toLowerCase().includes(filter.toLowerCase())) return false
    return true
  })
  const sorted = [...filtered].sort((a, b) => sort === 'Сначала с высоким рейтингом' ? (b.ggr ?? 0) - (a.ggr ?? 0) : sort === 'Сначала с низким рейтингом' ? (a.ggr ?? 0) - (b.ggr ?? 0) : 0)
  const active = accounts.find((a) => a.id === activeId) ?? null
  const allChecked = sorted.length > 0 && sorted.every((a) => checked.has(a.id))

  const toggleAll = () => { const n = new Set(checked); allChecked ? sorted.forEach((a) => n.delete(a.id)) : sorted.forEach((a) => n.add(a.id)); setChecked(n) }
  const toggle = (id: string) => { const n = new Set(checked); n.has(id) ? n.delete(id) : n.add(id); setChecked(n) }
  const checkAll = () => {
    if (!guardNet(cfg.primaryAction)) return
    const next: Record<string, number> = {}
    accounts.forEach((a) => { next[a.id] = a.ggr ?? 60 })
    setScores(next)
    pushToast({ type: 'success', title: 'Проверка запущена', desc: `Оценивается ${accounts.length} аккаунтов (демо).` })
  }

  return (
    <div className="space-y-4">
      {/* Info banner */}
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/8 p-4">
        <div className="flex items-center gap-2 text-sm font-bold text-amber-300"><AlertTriangle size={16} /> Технология в режиме обучения</div>
        <p className="mt-1.5 text-sm text-muted">Балл ранжирует возрастные группы по долгосрочной выживаемости (бан/заморозка), а не предсказывает моментальный spamblock. Score — ориентир, не гарантия. Для свежих аккаунтов (7–30 дней) с активной нагрузкой риск всегда выше.</p>
        <p className="mt-2 text-xs text-faint">GGR — это аналитика, а не запрет на запуск. У свежего аккаунта (1–3 дня) оценка предварительная: он в самой молодой возрастной группе, а она живёт хуже зрелых. Через несколько дней отлёжки аккаунт переходит в более живую группу и балл уточняется.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Left: rating card */}
        <div className="card p-0">
          <div className="flex items-center gap-2.5 border-b border-line px-4 py-3.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-iris-gradient font-display text-sm font-bold text-white">G</span>
            <span className="font-display text-base font-bold text-fg">GramGPT Рейтинг</span>
          </div>
          {active ? (
            <div className="p-5">
              <div className="flex items-center gap-4">
                <div className="grid h-20 w-20 place-items-center rounded-2xl border border-iris-500/40 bg-iris-500/8">
                  <span className="font-display text-3xl font-bold text-iris-300">{((scores[active.id] ?? active.ggr ?? 60) / 10).toFixed(1)}</span>
                </div>
                <div>
                  <div className="flex items-center gap-2"><Avatar name={active.name} color={active.avatarColor} size={28} /><span className="font-bold text-fg">{active.name}</span></div>
                  <div className="mt-0.5 text-xs text-muted">@{active.username} · {active.phone}</div>
                  <div className="mt-1.5"><StatusBadge status={active.status} /></div>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2.5">
                {[['Гео', `${({ ua: '🇺🇦', ru: '🇷🇺', kz: '🇰🇿', pl: '🇵🇱', de: '🇩🇪' } as Record<string, string>)[active.country] ?? ''} ${active.country.toUpperCase()}`], ['Возраст группы', active.lastSeen], ['Прошлый балл', `${((active.ggr ?? 60) / 10).toFixed(1)}`], ['Активность', 'нет активности']].map(([k, v]) => (
                  <div key={k} className="rounded-xl border border-line bg-elevated p-3"><div className="text-xs text-muted">{k}</div><div className="mt-0.5 font-semibold text-fg">{v}</div></div>
                ))}
              </div>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-line"><div className={cn('h-full rounded-full', (scores[active.id] ?? 0) > 80 ? 'bg-spark-500' : (scores[active.id] ?? 0) > 55 ? 'bg-amber-500' : 'bg-rose-500')} style={{ width: `${scores[active.id] ?? active.ggr ?? 60}%` }} /></div>
            </div>
          ) : (
            <EmptyState icon={<Trophy size={26} />} title="Выберите аккаунт" desc="Кликните по аккаунту слева — карточка появится здесь." />
          )}
        </div>

        {/* Right: evaluate */}
        <div className="card p-0">
          <div className="border-b border-line px-4 py-3"><span className="text-xs font-bold uppercase tracking-wide text-muted">Оценить аккаунт</span></div>
          <div className="p-4">
            <Segmented className="mb-3 w-full" options={cfg.ggrSources!} value={sourceTab} onChange={setSourceTab} size="sm" />
            <div className="mb-3 flex gap-2">
              <input value={filter} onChange={(e) => setFilter(e.target.value)} className="input" placeholder="Фильтр: телефон, @username или ID" />
              <button onClick={checkAll} className="btn-iris h-[42px] shrink-0 px-4"><SlidersHorizontal size={16} /> {cfg.primaryAction}</button>
            </div>
            <div className="mb-3 flex gap-2">
              <Select className="flex-1" value={statusFilter} onChange={setStatusFilter} options={cfg.ggrStatuses!.map((s) => ({ value: s, label: s }))} />
              <Select className="flex-1" value={sort} onChange={setSort} options={['По умолчанию', 'Сначала с высоким рейтингом', 'Сначала с низким рейтингом'].map((s) => ({ value: s, label: s }))} />
            </div>
            <button onClick={toggleAll} className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted hover:text-fg">
              <span className={cn('grid h-4 w-4 place-items-center rounded border', allChecked ? 'border-iris-500 bg-iris-500 text-white' : 'border-line')}>{allChecked && <Check size={11} />}</span> Выделить всё
            </button>
            <div className="max-h-80 space-y-1 overflow-y-auto">
              {sorted.length === 0 ? (
                <EmptyState icon={<Trophy size={22} />} title="Нет аккаунтов" desc="Добавьте аккаунты или импортируйте .session / tdata." />
              ) : sorted.map((a) => {
                const sc = scores[a.id]
                return (
                  <div key={a.id} onClick={() => setActiveId(a.id)} className={cn('flex cursor-pointer items-center gap-2.5 rounded-xl border p-2.5 transition-colors', activeId === a.id ? 'border-iris-500/40 bg-iris-500/8' : 'border-transparent hover:bg-elevated')}>
                    <button onClick={(e) => { e.stopPropagation(); toggle(a.id) }} className={cn('grid h-4 w-4 shrink-0 place-items-center rounded border', checked.has(a.id) ? 'border-iris-500 bg-iris-500 text-white' : 'border-line')}>{checked.has(a.id) && <Check size={11} />}</button>
                    <Avatar name={a.name} color={a.avatarColor} size={32} />
                    <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-fg">{a.name}</div><div className="truncate text-xs text-muted">@{a.username} · {a.phone.replace('+', '')}</div></div>
                    {sc !== undefined && (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="rounded-full border border-amber-500/40 px-1.5 py-0.5 text-[11px] font-bold text-amber-300">{(sc / 10).toFixed(1)}</span>
                        <span className="hidden text-[11px] font-bold text-muted sm:inline">П {((sc - 2) / 10 + 1).toFixed(1)}</span>
                        <button onClick={(e) => { e.stopPropagation(); pushToast({ type: 'info', title: 'Прошлые проверки', desc: a.name }) }} className="hidden rounded-lg border border-line px-2 py-0.5 text-[11px] font-semibold text-muted hover:text-fg md:inline">Прошлые проверки</button>
                      </div>
                    )}
                    <span className="shrink-0 rounded-md bg-spark-500/12 px-1.5 py-0.5 text-[10px] font-bold text-spark-300">{GGR_STATUS[a.status]}</span>
                  </div>
                )
              })}
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-xs text-muted"><span>Аккаунтов: <span className="font-bold text-fg">{sorted.length}</span></span><span>без лимита</span></div>
          </div>
        </div>
      </div>

      {/* Geo benchmark */}
      <div className="card">
        <div className="mb-1 flex items-center gap-1.5"><span className="font-display text-base font-bold text-fg">Бенчмарк по гео</span><span className="grid h-4 w-4 place-items-center rounded-full border border-line text-[10px] text-muted">?</span></div>
        <p className="mb-4 text-sm text-muted">Доля живых по гео — усреднение по пользователям, чтобы один supplier-fraud клиент не искажал картину</p>
        <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-spark-300"><span className="h-2 w-2 rounded-full bg-spark-400" /> Лучшие гео</div>
            <div className="space-y-1">{GEO_BEST.map((g) => <GeoRow key={g.c} {...g} good />)}</div>
          </div>
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-rose-300"><span className="h-2 w-2 rounded-full bg-rose-400" /> Худшие гео</div>
            <div className="space-y-1">{GEO_WORST.map((g) => <GeoRow key={g.c} {...g} />)}</div>
          </div>
        </div>
      </div>

      <div className="pb-2 text-center text-xs text-faint">GramGPT Рейтинг · v1.0 · одна цифра вместо длинного описания качества аккаунта</div>
    </div>
  )
}

function GeoRow({ c, f, p, d, good }: { c: string; f: string; p: number; d: number; good?: boolean }) {
  return (
    <div className="flex items-center gap-3 border-b border-line/40 py-1.5 last:border-0">
      <span className="text-lg">{f}</span>
      <span className="w-8 text-sm font-bold text-fg">{c}</span>
      <span className="ml-auto font-mono text-sm font-bold" style={{ color: good ? '#34de83' : p < 30 ? '#f59e0b' : '#77efab' }}>{p.toFixed(1)}%</span>
      <span className="w-10 text-right text-xs text-muted">{d}д</span>
    </div>
  )
}

/* ══════════════════════ NEURO-DIALOGS LAYOUT (НейроДиалоги) ══════════════════════ */
function DialogsModule({ cfg }: { cfg: ModuleConfig }) {
  const accounts = activeAccounts(useApp((s) => s.data))
  const addTask = useApp((s) => s.addTask)
  const pushToast = useApp((s) => s.pushToast)
  const guardNet = useApp((s) => s.guardNet)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [aiOpen, setAiOpen] = useState(false)
  const [aiEnabled, setAiEnabled] = useState(true)
  const [promptIdx, setPromptIdx] = useState(0)
  const [running, setRunning] = useState(false)
  const [view, setView] = useState<'visual' | 'logs'>('visual')
  const [grid, setGrid] = useState(false)
  const [search, setSearch] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [convos, setConvos] = useState<Dialog[]>(() => DIALOGS.map((d) => ({ ...d, messages: [...d.messages] })))

  const logs = useMemo(() => seedLogs(cfg.key, cfg.logSeedCount), [cfg])
  const filtered = convos.filter((d) => !search || `${d.name} ${d.last}`.toLowerCase().includes(search.toLowerCase()))
  const active = convos.find((d) => d.id === activeId) ?? null
  const selectedAccounts = accounts.filter((a) => selected.has(a.id))
  const totalDialogs = 49 + convos.length
  const totalUnread = 50 + convos.reduce((s, d) => s + d.unread, 0)

  const openDialog = (id: string) => { setActiveId(id); setConvos((cs) => cs.map((d) => (d.id === id ? { ...d, unread: 0 } : d))) }
  const send = () => {
    if (!reply.trim() || !active) return
    const text = reply.trim()
    setConvos((cs) => cs.map((d) => (d.id === active.id ? { ...d, last: text, messages: [...d.messages, { id: uid('msg'), from: 'me', text, time: 'сейчас' }] } : d)))
    setReply('')
    if (aiEnabled) setTimeout(() => setConvos((cs) => cs.map((d) => (d.id === active.id ? { ...d, messages: [...d.messages, { id: uid('msg'), from: 'me', text: 'Спасибо за сообщение! Отвечу подробнее чуть позже 🙂', time: 'сейчас', ai: true }] } : d))), 900)
  }
  const start = () => {
    if (!guardNet(cfg.primaryAction)) return
    if (!running) { addTask({ module: cfg.key, title: `${cfg.title} · ${selected.size} акк.`, status: 'running', progress: 20, accountsCount: selected.size, logCount: cfg.logSeedCount }); pushToast({ type: 'success', title: 'Мониторинг ЛС запущен' }) }
    else pushToast({ type: 'info', title: 'Остановлено' })
    setRunning((r) => !r)
  }

  return (
    <div className="space-y-4">
      {/* Accounts */}
      <AccountPicker selected={selected} onChange={setSelected} actions={cfg.accountActions} withFilters={!!cfg.accountFilters} selectedTitle={cfg.selectedTitle ?? 'Выбрано'} />

      {/* AI auto-replies */}
      <div className="card p-0">
        <div className="flex items-center gap-3 px-4 py-3.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-iris-500/12 text-iris-400"><Sparkles size={18} /></span>
          <span className="font-display text-base font-bold text-fg">ИИ Авто-ответы</span>
          <Badge tone={aiEnabled ? 'spark' : 'muted'}>{aiEnabled ? 'включено' : 'выключено'}</Badge>
          <button onClick={() => setAiOpen((v) => !v)} className="btn-icon ml-auto h-8 w-8"><ChevronDown size={16} className={cn('transition-transform', !aiOpen && '-rotate-90')} /></button>
        </div>
        {aiOpen && (
          <div className="space-y-4 border-t border-line p-4">
            <Switch checked={aiEnabled} onChange={setAiEnabled} label="Отвечать на входящие автоматически" desc="ИИ генерирует ответы на новые сообщения в ЛС" />
            {cfg.messagePrompts && (
              <div>
                <span className="label">Стиль ответов</span>
                <div className="flex flex-wrap gap-2">
                  {cfg.messagePrompts.map((p, i) => (
                    <button key={p} onClick={() => setPromptIdx(i)} className={cn('rounded-xl border px-3.5 py-2 text-sm font-semibold transition-all', i === promptIdx ? 'border-iris-500/50 bg-iris-500/12 text-iris-300' : 'border-line bg-elevated text-muted hover:text-fg')}>{p}</button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center justify-between rounded-xl border border-line bg-elevated/40 p-3">
              <span className="text-sm font-semibold text-fg">Задержка ответа</span>
              <span className="font-mono text-sm text-muted">5–30 сек</span>
            </div>
          </div>
        )}
      </div>

      {/* Launch & logs controls */}
      <SectionCard icon={<Play size={18} />} title="Запуск и логи">
        <div className="mb-4 flex flex-col items-center gap-3 rounded-2xl border border-line bg-elevated/40 p-4 sm:flex-row">
          <div className="flex items-center gap-2 text-sm font-semibold text-muted">
            <span className={cn('h-2.5 w-2.5 rounded-full', running ? 'bg-spark-400 animate-pulse' : 'bg-faint')} /> {running ? 'Выполняется' : 'Остановлено'}
          </div>
          <div className="flex flex-1 justify-center">
            <button onClick={start} className={cn(running ? 'btn-danger' : 'btn-iris', 'h-11 min-w-[180px]')}>{running ? <Square size={16} /> : <Play size={17} />} {running ? cfg.stopAction : cfg.primaryAction}</button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented options={['Визуал', 'Логи']} value={view === 'visual' ? 0 : 1} onChange={(i) => setView(i === 0 ? 'visual' : 'logs')} size="sm" />
          <div className="inline-flex rounded-lg border border-line bg-elevated p-0.5">
            <button onClick={() => setGrid(false)} className={cn('rounded p-1.5', !grid ? 'bg-surface text-fg' : 'text-muted')}><List size={15} /></button>
            <button onClick={() => setGrid(true)} className={cn('rounded p-1.5', grid ? 'bg-surface text-fg' : 'text-muted')}><LayoutGrid size={15} /></button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {selectedAccounts.length === 0 ? (
              <span className="text-xs text-muted">Аккаунты не выбраны</span>
            ) : selectedAccounts.map((a) => (
              <span key={a.id} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-elevated px-2 py-1 text-xs">
                <Avatar name={a.name} color={a.avatarColor} size={18} /> {a.name} · {a.phone.replace('+', '')} <span className="text-spark-300">● готов</span>
              </span>
            ))}
          </div>
        </div>
      </SectionCard>

      {view === 'logs' ? (
        <LogsPanel logs={logs} emptyText={cfg.logEmpty} title="Логи выполнения" live={running} />
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-3 gap-2.5">
            <LaunchStat icon={<MessagesSquare size={18} />} color="#06b6d4" label="Диалогов" value={String(totalDialogs)} />
            <LaunchStat icon={<Users size={18} />} color="#7145ff" label="Аккаунтов" value={String(selected.size)} />
            <LaunchStat icon={<Mail size={18} />} color="#f59e0b" label="Непрочитанных" value={String(totalUnread)} />
          </div>

          {/* Messenger */}
          <div className="card grid gap-0 overflow-hidden p-0 lg:grid-cols-[340px_1fr]">
            {/* dialog list */}
            <div className="flex flex-col border-b border-line lg:border-b-0 lg:border-r">
              <div className="flex items-center gap-2 border-b border-line p-3">
                <div className="relative flex-1">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} className="input h-9 pl-9 text-sm" placeholder="Поиск диалогов…" />
                </div>
                <button onClick={() => pushToast({ type: 'info', title: 'Новый диалог (демо)' })} className="btn-icon h-9 w-9"><Plus size={16} /></button>
                <button onClick={() => pushToast({ type: 'info', title: 'Открыть в Telegram (демо)' })} className="btn-icon h-9 w-9"><ExternalLink size={15} /></button>
              </div>
              <div className="max-h-[460px] overflow-y-auto">
                {filtered.map((d) => (
                  <button key={d.id} onClick={() => openDialog(d.id)} className={cn('flex w-full items-center gap-3 border-b border-line/50 p-3 text-left transition-colors hover:bg-elevated', activeId === d.id && 'bg-iris-500/8')}>
                    <Avatar name={d.name} color={d.color} size={42} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-bold text-fg">{d.name}</span><span className="shrink-0 text-[11px] text-faint">{d.time}</span></div>
                      <div className="truncate text-xs text-muted">{d.last}</div>
                      <div className="truncate text-[11px] text-iris-300/70">@ {d.account}</div>
                    </div>
                    {d.unread > 0 && <span className="grid h-5 min-w-[20px] place-items-center rounded-full bg-rose-500 px-1 text-[11px] font-bold text-white">{d.unread}</span>}
                  </button>
                ))}
              </div>
            </div>

            {/* chat pane */}
            <div className="flex min-h-[420px] flex-col">
              {active ? (
                <>
                  <div className="flex items-center gap-3 border-b border-line p-3">
                    <Avatar name={active.name} color={active.color} size={38} />
                    <div className="min-w-0"><div className="truncate text-sm font-bold text-fg">{active.name}</div><div className="text-xs text-muted">через @{active.account}</div></div>
                  </div>
                  <div className="flex-1 space-y-2 overflow-y-auto bg-[rgb(var(--bg))] p-4">
                    {active.messages.map((m) => (
                      <div key={m.id} className={cn('flex', m.from === 'me' ? 'justify-end' : 'justify-start')}>
                        <div className={cn('max-w-[75%] rounded-2xl px-3.5 py-2 text-sm', m.from === 'me' ? 'bg-iris-gradient text-white' : 'border border-line bg-surface text-fg')}>
                          {m.ai && <span className="mb-0.5 flex items-center gap-1 text-[10px] font-bold uppercase opacity-80"><Sparkles size={10} /> ИИ</span>}
                          {m.text}
                          <span className={cn('mt-0.5 block text-[10px]', m.from === 'me' ? 'text-white/70' : 'text-faint')}>{m.time}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 border-t border-line p-3">
                    <input value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} className="input flex-1" placeholder="Написать сообщение…" />
                    <button onClick={send} className="btn-iris h-[42px] px-4"><Send size={16} /></button>
                  </div>
                </>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                  <div className="grid h-20 w-20 place-items-center rounded-full border border-line bg-elevated text-iris-400"><MessagesSquare size={34} /></div>
                  <div><div className="font-display text-base font-bold text-fg">Выберите диалог</div><div className="mt-1 text-sm text-muted">Выберите диалог из списка слева, чтобы начать переписку</div></div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* ══════════════════════ WARMING LAYOUT (Прогрев аккаунтов) ══════════════════════ */
const INTENSITY = [
  { emoji: '🐢', label: 'Осторожный', desc: 'Для новых аккаунтов (0-7 дней)' },
  { emoji: '🐇', label: 'Нормальный', desc: 'Для прогретых аккаунтов (7-30 дней)' },
  { emoji: '🚀', label: 'Агрессивный', desc: 'Для старых аккаунтов (30+ дней)' },
]
const DURATIONS = [
  { num: '30', unit: 'мин', short: '30м' }, { num: '1', unit: 'час', short: '1ч' },
  { num: '2', unit: 'часов', short: '2ч' }, { num: '8', unit: 'часов', short: '8ч' },
  { num: '1', unit: 'день', short: '1д' }, { num: '3', unit: 'дней', short: '3д' },
  { num: '7', unit: 'дней', short: '7д' },
]
const TZ = ['UTC+3 (Moscow)', 'UTC+2 (Kyiv)', 'UTC+0 (London)', 'UTC+1 (Berlin)', 'UTC+5 (Almaty)']

function WarmingModule({ cfg }: { cfg: ModuleConfig }) {
  const addTask = useApp((s) => s.addTask)
  const pushToast = useApp((s) => s.pushToast)
  const guardNet = useApp((s) => s.guardNet)

  const seedUrls = useMemo(() => genTargets(cfg.seedTargetCount ?? 0).map((n) => `https://t.me/${n}`), [cfg])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [fromH, setFromH] = useState(9)
  const [toH, setToH] = useState(24)
  const [windows, setWindows] = useState<{ from: string; to: string }[]>([])
  const [tz, setTz] = useState('UTC+3 (Moscow)')
  const [randomBreaks, setRandomBreaks] = useState(true)
  const [intensity, setIntensity] = useState(2)
  const [autoAdapt, setAutoAdapt] = useState(true)
  const [safety, setSafety] = useState(false)
  const [progressive, setProgressive] = useState(true)
  const [durIdx, setDurIdx] = useState(1)
  const [reactions, setReactions] = useState(true)
  const [readCh, setReadCh] = useState(true)
  const [readSrc, setReadSrc] = useState('Из подписок')
  const [stories, setStories] = useState(true)
  const [joinGroups, setJoinGroups] = useState(true)
  const [joinSrc, setJoinSrc] = useState('Пользовательские')
  const [dialogs, setDialogs] = useState(false)
  const [trust, setTrust] = useState(false)
  const [fineOpen, setFineOpen] = useState(false)
  const [targets, setTargets] = useState<string[]>(seedUrls)
  const [targetInput, setTargetInput] = useState('')
  const [running, setRunning] = useState(false)

  const dialogsAllowed = selected.size >= 2
  const windowLabel = `Окно: ${String(fromH).padStart(2, '0')}:00 — ${toH >= 24 ? '23:59' : `${String(toH).padStart(2, '0')}:00`} (${toH - fromH} ч)`

  const addTargets = () => {
    const parsed = targetInput.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean)
    if (!parsed.length) return
    setTargets((t) => [...new Set([...parsed, ...t])]); setTargetInput('')
    pushToast({ type: 'success', title: 'Добавлено', desc: `${parsed.length} шт.` })
  }
  const run = () => {
    if (!guardNet(cfg.primaryAction)) return
    if (selected.size === 0) return pushToast({ type: 'error', title: 'Аккаунты не выбраны', desc: 'Выберите хотя бы один аккаунт.' })
    setRunning(true)
    addTask({ module: cfg.key, title: `${cfg.title} · ${selected.size} акк.`, status: 'running', progress: 6, accountsCount: selected.size, logCount: cfg.logSeedCount })
    pushToast({ type: 'success', title: 'Прогрев запущен', desc: `${cfg.title} · ${selected.size} акк.` })
    setTimeout(() => setRunning(false), 1400)
  }
  const logs = useMemo(() => seedLogs(cfg.key, cfg.logSeedCount), [cfg])

  return (
    <div className="space-y-4">
      {/* 1. Accounts */}
      <AccountPicker selected={selected} onChange={setSelected} actions={cfg.accountActions} withFilters={!!cfg.accountFilters} selectedTitle={cfg.selectedTitle ?? 'Выбрано'} />

      {/* 2. Warming settings */}
      <SectionCard icon={<Settings2 size={18} />} title="Настройки прогрева">
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Schedule */}
          <div className="rounded-2xl border border-line bg-elevated/40 p-4">
            <div className="mb-3 flex items-start gap-2.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-spark-500/12 text-spark-400"><Calendar size={17} /></span>
              <div><div className="text-sm font-bold text-fg">Расписание активности</div><div className="text-xs text-muted">Окно активности в течение каждого дня сеанса</div></div>
            </div>
            <div className="mb-1 flex items-end gap-2">
              <div><span className="label">Активность с</span><input type="number" value={fromH} onChange={(e) => setFromH(Number(e.target.value))} className="input h-10 w-20 text-center" /></div>
              <span className="pb-2.5 text-sm text-muted">до</span>
              <div><span className="label opacity-0">до</span><input type="number" value={toH} onChange={(e) => setToH(Number(e.target.value))} className="input h-10 w-20 text-center" /></div>
              <span className="pb-2.5 text-sm text-muted">часов</span>
            </div>
            <div className="mb-3 text-xs text-muted">{windowLabel}</div>
            <span className="label">Окна активности</span>
            {windows.map((w, i) => (
              <div key={i} className="mb-2 flex items-center gap-2 rounded-lg border border-line bg-surface p-2">
                <input defaultValue={w.from} className="input h-8 w-20 text-center text-xs" />
                <span className="text-muted">—</span>
                <input defaultValue={w.to} className="input h-8 w-20 text-center text-xs" />
                <button onClick={() => setWindows((ws) => ws.filter((_, j) => j !== i))} className="ml-auto text-faint hover:text-rose-300"><Trash2 size={14} /></button>
              </div>
            ))}
            <button onClick={() => setWindows((w) => [...w, { from: '08:00', to: '11:00' }])} className="btn-ghost mb-2 h-9 w-full text-sm"><Plus size={15} /> Добавить окно</button>
            <p className="mb-3 text-xs leading-snug text-muted">Несколько промежутков в течение дня (например 8–9, 15–16, 20–21). Пока есть хотя бы одно окно — прогрев идёт только в эти часы, а одиночный диапазон выше игнорируется. Час окончания не включается.</p>
            <span className="label">Таймзона</span>
            <Select value={tz} onChange={setTz} options={TZ.map((z) => ({ value: z, label: z }))} />
            <div className="mt-3"><Switch checked={randomBreaks} onChange={setRandomBreaks} label="Случайные перерывы" /></div>
          </div>

          {/* Intensity */}
          <div className="rounded-2xl border border-line bg-elevated/40 p-4">
            <div className="mb-3 flex items-start gap-2.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-iris-500/12 text-iris-400"><Cpu size={17} /></span>
              <div><div className="text-sm font-bold text-fg">Интенсивность прогрева</div><div className="text-xs text-muted">Автоподбор лимитов по возрасту аккаунта</div></div>
            </div>
            <div className="space-y-2">
              {INTENSITY.map((it, i) => (
                <button key={it.label} onClick={() => setIntensity(i)} className={cn('flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-all', i === intensity ? 'border-iris-500/60 bg-iris-500/10' : 'border-line bg-elevated hover:border-iris-500/30')}>
                  <span className="text-xl">{it.emoji}</span>
                  <div><div className={cn('text-sm font-bold', i === intensity ? 'text-fg' : 'text-muted')}>{it.label}</div><div className="text-xs text-muted">{it.desc}</div></div>
                </button>
              ))}
            </div>
            <div className="mt-3"><Switch checked={autoAdapt} onChange={setAutoAdapt} label="Автоадаптация по стадии аккаунта" /></div>
          </div>
        </div>

        {/* Safety limits */}
        <div className={cn('mt-4 rounded-2xl border p-4', safety ? 'border-rose-500/40 bg-rose-500/5' : 'border-dashed border-line')}>
          <div className="mb-3 flex items-center gap-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-rose-500/12 text-rose-400"><Shield size={17} /></span>
            <div className="flex-1"><div className="text-sm font-bold text-fg">Лимиты безопасности</div><div className="text-xs text-muted">Защита от блокировок Telegram</div></div>
            <Switch checked={safety} onChange={setSafety} />
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[{ label: 'Действий/час', val: '30', Icon: Bolt }, { label: 'Действий/день', val: '200', Icon: Calendar }, { label: 'Вступлений/день', val: '15', Icon: Users }, { label: 'Сообщений/день', val: '25', Icon: MessageCircle }].map((f) => (
              <div key={f.label}>
                <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted"><f.Icon size={13} /> {f.label}</span>
                <input defaultValue={f.val} disabled={!safety} className="input h-10 disabled:opacity-50" />
              </div>
            ))}
          </div>
          <div className="mt-3"><Switch checked={progressive} onChange={setProgressive} label="Прогрессивное увеличение (день 1: 30%, день 7: 100%)" /></div>
        </div>

        {/* Session duration */}
        <div className="mt-4 rounded-2xl border border-line bg-elevated/40 p-4">
          <div className="mb-3 flex items-start gap-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-spark-500/12 text-spark-400"><Clock size={17} /></span>
            <div><div className="text-sm font-bold text-fg">Длительность сеанса</div><div className="text-xs text-muted">Длительность прогрева НА ОДИН АККАУНТ. Общее время задачи больше из-за разноса запусков (anti-detect)</div></div>
          </div>
          <div className="flex flex-wrap gap-2">
            {DURATIONS.map((d, i) => (
              <button key={d.short} onClick={() => setDurIdx(i)} className={cn('flex min-w-[76px] flex-col items-center rounded-xl border px-4 py-2 transition-all', i === durIdx ? 'border-spark-500/60 bg-spark-gradient text-[#04150c]' : 'border-line bg-elevated text-fg hover:border-spark-500/30')}>
                <span className="font-display text-base font-bold">{d.num}</span><span className="text-[11px] opacity-80">{d.unit}</span>
              </button>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-sm text-muted">Или укажите:</span>
            <input defaultValue="1" className="input h-9 w-16 text-center" />
            <Select className="w-28" value="hour" onChange={() => {}} options={[{ value: 'min', label: 'мин' }, { value: 'hour', label: 'час' }, { value: 'day', label: 'дней' }]} />
          </div>
        </div>
      </SectionCard>

      {/* 3. Warming actions */}
      <div className="card overflow-hidden p-0">
        <div className="flex items-center gap-3 border-b border-line bg-spark-500/8 px-4 py-3.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-spark-500/15 text-spark-400"><CheckSquare size={18} /></span>
          <div><div className="font-display text-base font-bold text-fg">Действия прогрева</div><div className="text-xs text-muted">Имитация естественного поведения</div></div>
        </div>
        <div className="space-y-2 p-4">
          <ActionRow label="Реакции 🔥 ❤️ 🔥" checked={reactions} onChange={setReactions} />
          <ActionRow label="Читать каналы" checked={readCh} onChange={setReadCh} right={<Select className="w-40" value={readSrc} onChange={setReadSrc} options={['Из подписок', 'Из спарсенных групп', 'Из спарсенных каналов', 'Рандомные'].map((o) => ({ value: o, label: o }))} />} />
          <ActionRow label="Диалоги между аккаунтами" checked={dialogs && dialogsAllowed} onChange={(v) => dialogsAllowed && setDialogs(v)} disabled={!dialogsAllowed} right={!dialogsAllowed && <span className="flex items-center gap-1 text-xs font-semibold text-amber-400"><AlertTriangle size={12} /> Выберите 2+ аккаунтов</span>} />
          <ActionRow label="Просмотр сторис" checked={stories} onChange={setStories} />
          <ActionRow label="Вступать в группы" checked={joinGroups} onChange={setJoinGroups} right={<Select className="w-40" value={joinSrc} onChange={setJoinSrc} options={['Пользовательские', 'Из спарсенных групп', 'Из подписок', 'Рандомные'].map((o) => ({ value: o, label: o }))} />} />
          <div className="rounded-xl border border-spark-500/30 bg-spark-500/5 p-1">
            <ActionRow label={<span className="flex items-center gap-1.5"><Star size={14} className="text-amber-400" fill="currentColor" /> Повышение доверия</span>} checked={trust} onChange={setTrust} bare />
          </div>
        </div>
      </div>

      {/* 4. Fine tuning */}
      <div className="card p-0">
        <div className="flex w-full items-center gap-3 px-4 py-3.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-spark-500/12 text-spark-400"><SlidersHorizontal size={18} /></span>
          <div><div className="font-display text-base font-bold text-fg">Тонкая настройка действий</div><div className="text-xs text-muted">Включайте или отключайте отдельные действия прогрева</div></div>
          <button onClick={() => setFineOpen((v) => !v)} className="btn-icon ml-auto h-8 w-8"><ChevronDown size={16} className={cn('transition-transform', !fineOpen && '-rotate-90')} /></button>
        </div>
        {fineOpen && (
          <div className="grid gap-2 border-t border-line p-4 sm:grid-cols-2">
            {['Пролистывание ленты', 'Открытие профилей', 'Клики по ссылкам', 'Голосование в опросах', 'Сохранение медиа', 'Печатает…'].map((a) => (
              <ToggleRow key={a} icon={<Check size={16} />} label={a} checked onChange={() => {}} />
            ))}
          </div>
        )}
      </div>

      {/* 5. Target groups */}
      <div className="card overflow-hidden p-0">
        <div className="flex items-center gap-3 border-b border-line bg-pink-500/8 px-4 py-3.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-pink-500/15 text-pink-400"><MapPin size={18} /></span>
          <div><div className="font-display text-base font-bold text-fg">Целевые группы/каналы</div><div className="text-xs text-muted">Вступать в определённые группы во время прогрева</div></div>
        </div>
        <div className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-bold text-fg"><MapPin size={15} className="text-pink-400" /> Целевые группы/каналы <span className="rounded-md bg-elevated px-1.5 py-0.5 text-xs text-muted">{targets.length}</span></span>
            <button onClick={() => setTargets([])} className="flex items-center gap-1 text-xs font-semibold text-rose-300 hover:underline"><Trash2 size={13} /> Очистить все</button>
          </div>
          <p className="mb-2 text-xs text-muted">Укажите группы/каналы для вступления во время прогрева. Это подготовит аккаунты для НейроКомментинга, НейроЧаттинга или МассРеакции.</p>
          <div className="flex gap-2">
            <textarea value={targetInput} onChange={(e) => setTargetInput(e.target.value)} rows={3} className="input resize-none font-mono text-xs" placeholder={'Введите @username или ссылки (по одной в строке)\nПример:\n@cryptogroup\n@newsChannel\nhttps://t.me/joinchat/...'} />
            <button onClick={addTargets} className="btn-iris h-auto shrink-0 flex-col px-4"><Plus size={16} /> Добавить</button>
          </div>
          <div className="mt-2 flex gap-2">
            <button onClick={() => { setTargets((t) => [`https://t.me/parsed_group_${t.length}`, ...t]); pushToast({ type: 'success', title: 'Из спарсенных групп', desc: 'Добавлено (демо).' }) }} className="btn-ghost h-9 text-xs"><HistoryIcon size={14} /> Из спарсенных групп</button>
            <button onClick={() => { setTargets((t) => [`https://t.me/parsed_channel_${t.length}`, ...t]); pushToast({ type: 'success', title: 'Из спарсенных каналов', desc: 'Добавлено (демо).' }) }} className="btn-ghost h-9 text-xs"><HistoryIcon size={14} /> Из спарсенных каналов</button>
          </div>
          {targets.length > 0 && (
            <div className="mt-3 rounded-xl border border-line bg-elevated/40 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase text-muted"><Users size={13} /> Группы ({targets.length})</div>
              <div className="flex max-h-52 flex-wrap gap-1.5 overflow-y-auto">
                {targets.slice(0, 45).map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-xs text-iris-300">
                    {t}<button onClick={() => setTargets((arr) => arr.filter((x) => x !== t))} className="text-faint hover:text-rose-300"><X size={12} /></button>
                  </span>
                ))}
                {targets.length > 45 && <span className="inline-flex items-center rounded-lg bg-elevated px-2 py-1 text-xs font-semibold text-muted">+{targets.length - 45} ещё</span>}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 6. Launch & logs */}
      <SectionCard icon={<Play size={18} />} title={running ? 'Выполнение & Логи' : 'Запуск & Логи'} badge={running ? 'LIVE' : undefined}>
        <div className="mb-4 grid grid-cols-2 gap-2.5">
          <LaunchStat icon={<Users size={18} />} color="#7145ff" label="Аккаунты" value={String(selected.size)} warn={selected.size === 0} />
          <LaunchStat icon={<Clock size={18} />} color="#0ec464" label="Длительность" value={DURATIONS[durIdx].short} />
        </div>
        {!running && selected.size === 0 && (
          <div className="mb-4 flex items-center gap-2.5 rounded-2xl border border-rose-500/30 bg-rose-500/8 p-4">
            <AlertTriangle size={18} className="text-rose-400" />
            <div><div className="text-sm font-bold text-rose-300">Проблемы с конфигурацией</div><div className="text-xs text-muted">Выберите хотя бы один аккаунт</div></div>
          </div>
        )}
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-elevated/40 p-4 sm:flex-row">
          <div className="flex items-center gap-2 text-sm font-semibold text-muted">
            <span className={cn('h-2.5 w-2.5 rounded-full', running ? 'bg-spark-400 animate-pulse' : 'bg-faint')} /> {running ? 'Выполняется' : 'Остановлено'}
          </div>
          <div className="flex flex-1 justify-center">
            {running ? (
              <button onClick={() => { setRunning(false); pushToast({ type: 'info', title: 'Остановлено' }) }} className="btn-danger h-11 min-w-[180px]"><Square size={16} /> {cfg.stopAction ?? 'Остановить'}</button>
            ) : (
              <button onClick={run} disabled={selected.size === 0} className="btn-iris h-11 min-w-[180px]"><Play size={17} /> {cfg.primaryAction}</button>
            )}
          </div>
        </div>
        {running && <div className="mt-4"><LogsPanel logs={logs} emptyText={cfg.logEmpty} title="Логи выполнения" live /></div>}
      </SectionCard>
    </div>
  )
}

function ActionRow({ label, checked, onChange, right, disabled, bare }: { label: React.ReactNode; checked: boolean; onChange: (v: boolean) => void; right?: React.ReactNode; disabled?: boolean; bare?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between gap-3 rounded-xl p-3', bare ? '' : 'border border-line bg-elevated/40', disabled && 'opacity-60')}>
      <span className="flex items-center gap-3">
        <Switch checked={checked} onChange={onChange} />
        <span className="text-sm font-semibold text-fg">{label}</span>
      </span>
      {right}
    </div>
  )
}

/* ══════════════════════ MASS-LOOKING LAYOUT (Масслукинг) ══════════════════════ */
function LookingModule({ cfg }: { cfg: ModuleConfig }) {
  const addTask = useApp((s) => s.addTask)
  const pushToast = useApp((s) => s.pushToast)
  const guardNet = useApp((s) => s.guardNet)

  const seedUrls = useMemo(() => genTargets(cfg.seedTargetCount ?? 0).map((n) => `https://t.me/${n}`).join('\n'), [cfg])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [aiProtect, setAiProtect] = useState(false)
  const [targetsText, setTargetsText] = useState(seedUrls)
  const [byMembers, setByMembers] = useState(false)
  const [collectWriters, setCollectWriters] = useState(100)
  const [transFrom, setTransFrom] = useState(2)
  const [transTo, setTransTo] = useState(6)
  const [floodWait, setFloodWait] = useState(120)
  const [quarantine, setQuarantine] = useState(3)
  const [storiesCount, setStoriesCount] = useState(0)
  const [perAccLimit, setPerAccLimit] = useState(0)
  const [storyReactions, setStoryReactions] = useState(false)
  const [running, setRunning] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(true)

  const targetCount = targetsText.split('\n').filter((l) => l.trim()).length

  const run = () => {
    if (!guardNet(cfg.primaryAction)) return
    if (selected.size === 0) return pushToast({ type: 'error', title: 'Аккаунты не выбраны', desc: 'Выберите хотя бы один аккаунт.' })
    setRunning(true)
    addTask({ module: cfg.key, title: `${cfg.title} · ${selected.size} акк.`, status: 'running', progress: 10, accountsCount: selected.size, logCount: 0 })
    pushToast({ type: 'success', title: 'Просмотр запущен', desc: `${cfg.title} · ${selected.size} акк.` })
    setTimeout(() => setRunning(false), 1400)
  }

  return (
    <div className="space-y-4">
      {/* 1. Accounts */}
      <AccountPicker selected={selected} onChange={setSelected} actions={cfg.accountActions} withFilters={!!cfg.accountFilters} selectedTitle={cfg.selectedTitle ?? 'Выбрано'} />

      {/* 2. Settings */}
      <SectionCard icon={<Settings2 size={18} />} title="Настройки" badge={`Целей: ${targetCount}`}>
        {cfg.aiProtection && (
          <div className="mb-4 flex items-center gap-3 rounded-2xl border border-spark-500/40 bg-spark-500/8 p-4">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-spark-500/15 text-spark-400"><Shield size={20} /></div>
            <div className="flex-1">
              <div className="flex items-center gap-2"><span className="font-bold text-fg">Защита аккаунтов ИИ</span><Badge tone="spark">NEW</Badge></div>
              <div className="text-xs text-muted">Умная защита от блокировок, заморозок и банов с помощью ИИ. Снижает риск бана на 97%.</div>
            </div>
            <Switch checked={aiProtect} onChange={setAiProtect} />
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {/* Left */}
          <div className="space-y-4">
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-1">
                <span className="label mb-0">Пользователи и чаты</span>
                <span className="text-xs text-muted">{cfg.targetHint}</span>
              </div>
              <textarea value={targetsText} onChange={(e) => setTargetsText(e.target.value)} rows={7} className="input resize-none font-mono text-xs" />
              <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted"><ListChecks size={13} /> Целей: {targetCount}</div>
            </div>
            <ToggleRow icon={<Users size={16} />} label="Из групп брать по списку участников" checked={byMembers} onChange={setByMembers} />
            <LookRow icon={<MessageCircle size={16} />} label="Сколько писавших собирать из чата">
              <Stepper value={collectWriters} onChange={setCollectWriters} />
            </LookRow>
          </div>

          {/* Right */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-elevated/40 p-3">
              <span className="text-sm font-semibold text-fg">Задержка между переходами</span>
              <div className="flex items-center gap-2">
                <Stepper value={transFrom} onChange={setTransFrom} suffix=" сек" />
                <span className="text-muted">до</span>
                <Stepper value={transTo} onChange={setTransTo} suffix=" сек" />
              </div>
            </div>
            <LookRow icon={<Clock size={16} />} label="Задержка при FloodWait (сек)"><Stepper value={floodWait} onChange={setFloodWait} /></LookRow>
            <LookRow icon={<Shield size={16} />} label="Кол-во FloodWait до карантина"><Stepper value={quarantine} onChange={setQuarantine} /></LookRow>
            <LookRow icon={<Eye size={16} />} label="Сколько историй просматривать" sub="без ограничений"><Stepper value={storiesCount} onChange={setStoriesCount} /></LookRow>
            <LookRow icon={<Ban size={16} />} label="Лимит просмотров на аккаунт (0 = без лимита)" sub="без лимита"><Stepper value={perAccLimit} onChange={setPerAccLimit} /></LookRow>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-elevated/40 p-3">
              <span className="flex items-center gap-2.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-rose-500/12 text-rose-400"><Heart size={16} /></span>
                <span><span className="block text-sm font-semibold text-fg">Реакции на истории</span><span className="block text-xs text-muted">Случайные эмодзи на просмотренные истории</span></span>
              </span>
              <Switch checked={storyReactions} onChange={setStoryReactions} />
            </div>
          </div>
        </div>
      </SectionCard>

      {/* 3. Launch */}
      <SectionCard icon={<Play size={18} />} title={running ? 'Выполнение' : 'Запуск'} badge={running ? 'LIVE' : undefined}>
        <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <LaunchStat icon={<Eye size={18} />} color="#06b6d4" label="Просмотрено историй" value={running ? '—' : '1'} />
          <LaunchStat icon={<Heart size={18} />} color="#ec4899" label="Отправлено реакций" value="0" />
          <LaunchStat icon={<Check size={18} />} color="#0ec464" label="Целей готово" value={String(Math.max(0, targetCount + 17))} />
          <LaunchStat icon={<X size={18} />} color="#f59e0b" label="Целей пропущено" value="1" warn />
        </div>
        {!running && selected.size === 0 && (
          <div className="mb-4 flex items-center gap-2.5 rounded-2xl border border-rose-500/30 bg-rose-500/8 p-4">
            <AlertTriangle size={18} className="text-rose-400" />
            <div><div className="text-sm font-bold text-rose-300">Проблемы с конфигурацией</div><div className="text-xs text-muted">Выберите хотя бы один аккаунт</div></div>
          </div>
        )}
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-elevated/40 p-4 sm:flex-row">
          <div className="flex items-center gap-2 text-sm font-semibold text-muted">
            <span className={cn('h-2.5 w-2.5 rounded-full', running ? 'bg-spark-400 animate-pulse' : 'bg-faint')} /> {running ? 'Выполняется' : 'Остановлено'}
          </div>
          <div className="flex flex-1 justify-center">
            {running ? (
              <button onClick={() => { setRunning(false); pushToast({ type: 'info', title: 'Остановлено' }) }} className="btn-danger h-11 min-w-[180px]"><Square size={16} /> {cfg.stopAction ?? 'Остановить'}</button>
            ) : (
              <button onClick={run} disabled={selected.size === 0} className="btn-primary h-11 min-w-[180px]"><Play size={17} /> {cfg.primaryAction}</button>
            )}
          </div>
        </div>
      </SectionCard>

      {/* 4. View history */}
      <div className="card p-0">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-iris-500/12 text-iris-400"><HistoryIcon size={18} /></span>
          <span className="font-display text-base font-bold text-fg">История просмотров</span>
          <span className="rounded-md bg-elevated px-1.5 py-0.5 text-xs font-bold text-muted">1</span>
          <button onClick={() => pushToast({ type: 'info', title: 'Вся история', desc: 'Открываю историю (демо).' })} className="btn-ghost ml-auto h-8 text-xs">Вся история →</button>
          <button onClick={() => setHistoryOpen((v) => !v)} className="btn-icon h-8 w-8"><ChevronDown size={16} className={cn('transition-transform', !historyOpen && '-rotate-90')} /></button>
        </div>
        {historyOpen && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line p-4">
            <button onClick={() => { setTargetsText((t) => `https://t.me/prev_viewed_1\n${t}`); pushToast({ type: 'success', title: 'Добавлено', desc: 'Ранее просмотренные добавлены.' }) }} className="btn-ghost h-9 text-sm"><HistoryIcon size={15} /> Добавить ранее просмотренных (1)</button>
            <button onClick={() => pushToast({ type: 'success', title: 'Экспорт (демо)' })} className="btn-ghost h-9 text-sm"><Download size={15} /> Экспорт</button>
            <span className="text-xs text-muted">юзеры, чьи сторис уже смотрели — постят регулярно</span>
          </div>
        )}
      </div>
    </div>
  )
}

/* Boxed field row for mass-looking */
function LookRow({ icon, label, sub, children }: { icon: React.ReactNode; label: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-elevated/40 p-3">
      <span className="flex items-center gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-spark-500/12 text-spark-400">{icon}</span>
        <span><span className="block text-sm font-semibold text-fg">{label}</span>{sub && <span className="block text-xs text-muted">{sub}</span>}</span>
      </span>
      {children}
    </div>
  )
}

/* ── Rich helpers ── */
function SectionCard({ icon, title, badge, right, children }: { icon: React.ReactNode; title: string; badge?: string; right?: React.ReactNode; children: React.ReactNode }) {
  const setHelpTopic = useUi((s) => s.setHelpTopic)
  const setHelpOpen = useUi((s) => s.setHelpOpen)

  return (
    <div className="card p-0">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3.5">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-spark-500/12 text-spark-400">{icon}</span>
        <span className="font-display text-base font-bold text-fg">{title}</span>
        {badge && <span className="rounded-md bg-spark-500/12 px-2 py-0.5 text-xs font-bold text-spark-300">{badge}</span>}
        <div className="ml-auto flex items-center gap-2">
          {right && <div>{right}</div>}
          <button
            type="button"
            className="grid h-8 w-8 place-items-center rounded-xl bg-spark-gradient text-[#04150c] shadow-pop transition-transform hover:scale-[1.03]"
            title="Help Center"
            aria-label="Help Center"
            onClick={() => { setHelpTopic(title); setHelpOpen(true) }}
          >
            <HelpCircle size={16} />
          </button>
        </div>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function NumberField({ label, value, onChange, suffix }: { label: string; value: number; onChange: (n: number) => void; suffix?: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between"><span className="text-sm text-muted">{label}</span>{suffix && <span className="rounded bg-elevated px-1.5 text-xs font-bold text-spark-300">{suffix}</span>}</div>
      <div className="flex items-center gap-2">
        <button onClick={() => onChange(Math.max(0, value - 1))} className="btn-icon h-9 w-9">−</button>
        <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} className="input h-9 text-center" />
        <button onClick={() => onChange(value + 1)} className="btn-icon h-9 w-9">+</button>
      </div>
    </div>
  )
}

function ToggleRow({ icon, label, checked, onChange }: { icon: React.ReactNode; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-line bg-elevated/40 p-3">
      <span className="flex items-center gap-2 text-sm font-semibold text-fg"><span className="text-spark-400">{icon}</span> {label}</span>
      <Switch checked={checked} onChange={onChange} />
    </div>
  )
}

function DelayRow({ delay, preset }: { delay: { label: string; from: number; to?: number; unit?: string }; preset: number }) {
  const mul = [0.6, 1, 1.8][preset] ?? 1
  const [from, setFrom] = useState(Math.round(delay.from * mul))
  const [to, setTo] = useState(delay.to ? Math.round(delay.to * mul) : undefined)
  const unit = delay.unit ? ` ${delay.unit}` : ''
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-3 last:border-0 last:pb-0">
      <span className="text-sm font-medium text-fg">{delay.label}</span>
      <div className="flex items-center gap-2">
        <Stepper value={from} onChange={setFrom} suffix={unit} />
        {to !== undefined && <><span className="text-muted">до</span><Stepper value={to} onChange={setTo} suffix={unit} /></>}
      </div>
    </div>
  )
}

function Stepper({ value, onChange, suffix }: { value: number; onChange: (n: number) => void; suffix?: string }) {
  return (
    <div className="flex items-center overflow-hidden rounded-lg border border-line bg-elevated">
      <button onClick={() => onChange(Math.max(0, value - 1))} className="px-2.5 py-1.5 text-muted hover:text-fg">−</button>
      <span className="min-w-[54px] text-center font-mono text-sm font-bold text-fg">{value}{suffix}</span>
      <button onClick={() => onChange(value + 1)} className="px-2.5 py-1.5 text-muted hover:text-fg">+</button>
    </div>
  )
}

function LaunchStat({ icon, color, label, value, warn }: { icon: React.ReactNode; color: string; label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-elevated/40 p-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl" style={{ background: `${color}20`, color }}>{icon}</span>
      <div className="min-w-0">
        <div className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</div>
        <div className={cn('font-display text-lg font-bold', warn ? 'text-amber-400' : 'text-fg')}>{value}</div>
      </div>
    </div>
  )
}

/* ══════════════════════ GENERIC LAYOUT (остальные модули) ══════════════════════ */
function GenericModule({ cfg }: { cfg: ModuleConfig }) {
  const data = useApp((s) => s.data)
  const addTask = useApp((s) => s.addTask)
  const pushToast = useApp((s) => s.pushToast)
  const guardNet = useApp((s) => s.guardNet)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [toggles, setToggles] = useState<Record<number, number>>({})
  const [mode, setMode] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [limitChip, setLimitChip] = useState(cfg.limitChipDefault ?? 50)
  const [limitField, setLimitField] = useState(cfg.limitField?.value ?? 100)
  const [sourceTab, setSourceTab] = useState(0)
  const [rows, setRows] = useState<string[]>([])
  const [rowInput, setRowInput] = useState('')
  const [palette, setPalette] = useState<Set<string>>(new Set(['🔥', '❤️']))
  const [langs, setLangs] = useState<Set<string>>(new Set())
  const [sort, setSort] = useState('')
  const [pageSize, setPageSize] = useState(25)
  const [results, setResults] = useState<ParseResult[]>([])
  const [running, setRunning] = useState(false)
  const [promptsOpen, setPromptsOpen] = useState(false)
  const [activePrompt, setActivePrompt] = useState(0)
  const [ggrSource, setGgrSource] = useState(0)
  const [ggrStatus, setGgrStatus] = useState('Все статусы')
  const [ggrSort, setGgrSort] = useState('По умолчанию')

  const logs = useMemo(() => seedLogs(cfg.key, cfg.logSeedCount), [cfg])
  const accent = cfg.accent
  const primaryBtn = accent === 'iris' ? 'btn-iris' : 'btn-primary'

  const addRow = () => { if (!rowInput.trim()) return; setRows((r) => [...r, rowInput.trim()]); setRowInput('') }

  const run = () => {
    if (!guardNet(cfg.primaryAction)) return
    if (cfg.accountPicker && selected.size === 0) return pushToast({ type: 'error', title: 'Аккаунты не выбраны', desc: 'Выберите хотя бы один аккаунт.' })
    setRunning(true)
    addTask({ module: cfg.key, title: `${cfg.title} · ${selected.size || activeAccounts(data).length} акк.`, status: 'running', progress: 12, accountsCount: selected.size || 1, logCount: cfg.logSeedCount })
    if (cfg.results) {
      const n = Math.min(typeof limitChip === 'number' ? limitChip : 50, 12)
      setTimeout(() => setResults(makeResults(cfg.results!.kind, Math.max(5, n))), 400)
    }
    pushToast({ type: 'success', title: 'Задача запущена', desc: `${cfg.title} добавлен в очередь.` })
    setTimeout(() => setRunning(false), 1200)
  }
  const stop = () => { setRunning(false); pushToast({ type: 'info', title: 'Остановлено', desc: cfg.title }) }

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {cfg.ggr ? (
            <GgrPanel source={ggrSource} setSource={setGgrSource} status={ggrStatus} setStatus={setGgrStatus} sort={ggrSort} setSort={setGgrSort} statuses={cfg.ggrStatuses!} sources={cfg.ggrSources!} />
          ) : cfg.accountPicker ? (
            <AccountPicker selected={selected} onChange={setSelected} actions={cfg.accountActions} withFilters={!!cfg.accountFilters} />
          ) : null}

          {(cfg.sourceTabs || cfg.sourceButtons) && (
            <Card className="p-4">
              {cfg.sourceTabs && (
                <>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="label mb-0">{cfg.sourceTabs.label}</span>
                    <span className="text-xs text-muted">{cfg.sourceTabs.emptyRows.replace('0', String(rows.length))}</span>
                  </div>
                  {cfg.sourceTabs.tabs.length > 1 && <Segmented className="mb-3" size="sm" options={cfg.sourceTabs.tabs} value={sourceTab} onChange={setSourceTab} />}
                  <div className="flex gap-2">
                    <input value={rowInput} onChange={(e) => setRowInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addRow()} className="input" placeholder={cfg.sourceTabs.placeholder} />
                    <button onClick={addRow} className="btn-ghost h-[42px] shrink-0 px-4"><Plus size={16} /> {cfg.sourceTabs.addLabel}</button>
                  </div>
                  {rows.length > 0 && (
                    <div className="mt-3 space-y-1.5">
                      {rows.map((r, i) => (
                        <div key={i} className="flex items-center gap-2 rounded-lg border border-line bg-elevated px-3 py-1.5 text-sm">
                          <Globe size={14} className="text-muted" /><span className="flex-1 truncate text-fg">{r}</span>
                          <button onClick={() => setRows((arr) => arr.filter((_, j) => j !== i))} className="text-faint hover:text-rose-300"><X size={14} /></button>
                        </div>
                      ))}
                      <button onClick={() => setRows([])} className="mt-1 text-xs font-semibold text-muted hover:text-fg">{cfg.sourceTabs.clearLabel ?? 'Очистить'}</button>
                    </div>
                  )}
                </>
              )}
              {cfg.sourceButtons?.map((b) => (
                <button key={b} onClick={() => { setRows((r) => [...r, 'Импортировано из истории']); pushToast({ type: 'success', title: b, desc: 'Источники подставлены (демо).' }) }} className="btn-ghost mt-1 h-10 w-full"><HistoryIcon size={15} /> {b}</button>
              ))}
            </Card>
          )}

          {(cfg.toggleGroups || cfg.prompts || cfg.modeToggle || cfg.speedPresets || cfg.limitChips || cfg.limitField) && (
            <Card className="space-y-4 p-4">
              {cfg.toggleGroups?.map((grp, gi) => (
                <ToggleGroup key={grp.label} label={grp.label} options={grp.options} value={toggles[gi] ?? grp.defaultIndex ?? 0} onChange={(v) => setToggles((t) => ({ ...t, [gi]: v }))} />
              ))}
              {cfg.prompts && (
                <div>
                  <span className="label">Промпты</span>
                  <button onClick={() => setPromptsOpen(true)} className="btn-ghost h-10 w-full justify-between">
                    <span className="flex items-center gap-2"><FileText size={15} /> {cfg.prompts}</span>
                    <span className="text-muted">{SYSTEM_PROMPTS_FALLBACK[activePrompt]} <ChevronRight size={14} className="inline" /></span>
                  </button>
                </div>
              )}
              <div className="flex flex-wrap gap-6">
                {cfg.modeToggle && <div><span className="label">{cfg.modeToggle.label}</span><Segmented options={cfg.modeToggle.options} value={mode} onChange={setMode} size="sm" /></div>}
                {cfg.speedPresets && (
                  <div><span className="label">{cfg.speedPresets.label}</span><Segmented options={cfg.speedPresets.options} value={speed} onChange={setSpeed} size="sm" /><span className="mt-1 block text-xs text-muted">Значение: {cfg.speedPresets.values[speed]}</span></div>
                )}
              </div>
              {cfg.limitChips && (
                <div>
                  <span className="label">Лимит результатов</span>
                  <div className="flex flex-wrap gap-1.5">
                    {cfg.limitChips.map((c) => (
                      <button key={String(c)} onClick={() => setLimitChip(c === '∞' ? 99999 : (c as number))} className={cn('min-w-[46px] rounded-lg border px-3 py-1.5 text-sm font-semibold transition-all', (limitChip === c || (c === '∞' && limitChip === 99999)) ? 'border-spark-500/50 bg-spark-500/12 text-spark-300' : 'border-line bg-elevated text-muted hover:text-fg')}>{c}</button>
                    ))}
                  </div>
                </div>
              )}
              {cfg.limitField && (
                <div><span className="label">{cfg.limitField.label}</span><input type="number" value={limitField} onChange={(e) => setLimitField(Number(e.target.value))} className="input max-w-[200px]" /></div>
              )}
            </Card>
          )}

          {cfg.reactionPalette && (
            <Card className="p-4">
              <span className="label">{cfg.key === 'mass-looking' ? 'Реакции при просмотре' : 'Палитра реакций'}</span>
              <div className="flex flex-wrap gap-2">
                {cfg.reactionPalette.map((e) => {
                  const on = palette.has(e)
                  return <button key={e} onClick={() => { const n = new Set(palette); n.has(e) ? n.delete(e) : n.add(e); setPalette(n) }} className={cn('grid h-11 w-11 place-items-center rounded-xl border text-xl transition-all', on ? 'border-spark-500/50 bg-spark-500/12 scale-105' : 'border-line bg-elevated hover:scale-105')}>{e}</button>
                })}
              </div>
              <div className="mt-2 text-xs text-muted">Выбрано: {palette.size}</div>
            </Card>
          )}

          {cfg.warmingWindows && <WarmingPanel timezone={cfg.timezone!} duration={cfg.durationMin!} />}

          {cfg.extraButtons?.some((b) => !['КУПИТЬ', 'Прошлые проверки'].includes(b)) && (
            <div className="flex flex-wrap gap-2">
              {cfg.extraButtons.filter((b) => !['КУПИТЬ', 'Прошлые проверки'].includes(b)).map((b) => (
                <button key={b} onClick={() => pushToast({ type: 'info', title: b, desc: 'Действие в демо.' })} className="btn-ghost h-9 text-sm">{b}</button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <Card className="p-4">
            {cfg.counters && (
              <div className="mb-3 grid grid-cols-3 gap-2">
                {cfg.counters.map((c) => (
                  <div key={c.label} className="rounded-xl border border-line bg-elevated p-2.5 text-center"><div className="font-display text-lg font-bold text-fg">{c.value}</div><div className="text-[11px] text-muted">{c.label}</div></div>
                ))}
              </div>
            )}
            {cfg.timer && (
              <div className="mb-3 flex items-center justify-between rounded-xl border border-line bg-elevated px-3 py-2">
                <span className="flex items-center gap-1.5 text-xs text-muted"><Clock size={14} /> Осталось</span>
                <span className="font-mono text-sm font-bold text-fg">{cfg.timer.current} <span className="text-faint">/ {cfg.timer.total}</span></span>
              </div>
            )}
            <div className="space-y-2">
              <button onClick={run} disabled={running} className={cn(primaryBtn, 'h-11 w-full')}>{running ? <Sparkles size={17} className="animate-pulse" /> : <Play size={17} />} {cfg.primaryAction}</button>
              <div className="flex gap-2">
                {cfg.secondaryAction && <button onClick={() => pushToast({ type: 'success', title: 'Настройки сохранены' })} className="btn-ghost h-10 flex-1 text-sm"><Save size={15} /> {cfg.secondaryAction}</button>}
                {cfg.stopAction && <button onClick={stop} className="btn-ghost h-10 flex-1 text-sm text-rose-300"><Square size={15} /> {cfg.stopAction}</button>}
              </div>
            </div>
          </Card>

          {!cfg.results && <LogsPanel logs={logs} emptyText={cfg.logEmpty} title="Логи выполнения" />}

          {cfg.blacklistEmpty && (
            <Card className="p-4"><div className="mb-1 text-sm font-bold text-fg">Чёрный список</div><p className="text-xs text-muted">{cfg.blacklistEmpty}</p></Card>
          )}
        </div>

        {cfg.results && (
          <div className="lg:col-span-3">
            <ResultsPanel cfg={cfg.results} results={results} sort={sort} setSort={setSort} langs={langs} setLangs={setLangs} pageSize={pageSize} setPageSize={setPageSize} onClear={() => setResults([])} />
          </div>
        )}
      </div>

      <Modal open={promptsOpen} onClose={() => setPromptsOpen(false)} title={cfg.prompts} subtitle="Системные промпты генерации" icon={<FileText size={22} />}>
        <div className="space-y-2">
          {SYSTEM_PROMPTS_FALLBACK.map((p, i) => (
            <button key={p} onClick={() => { setActivePrompt(i); setPromptsOpen(false) }} className={cn('flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors', i === activePrompt ? 'border-spark-500/50 bg-spark-500/8' : 'border-line bg-elevated hover:border-spark-500/30')}>
              <span className={cn('grid h-8 w-8 place-items-center rounded-lg text-sm font-bold', i === activePrompt ? 'bg-spark-gradient text-[#04150c]' : 'border border-line text-muted')}>{i + 1}</span>
              <div><div className="text-sm font-semibold text-fg">{p}</div><div className="text-xs text-muted">Промпт #{i + 1} · системный</div></div>
            </button>
          ))}
        </div>
      </Modal>
    </>
  )
}

/* ── GGR panel ── */
function GgrPanel({ source, setSource, status, setStatus, sort, setSort, statuses, sources }: {
  source: number; setSource: (i: number) => void
  status: string; setStatus: (s: string) => void
  sort: string; setSort: (s: string) => void
  statuses: string[]; sources: string[]
}) {
  const accounts = activeAccounts(useApp((s) => s.data))
  const filtered = accounts.filter((a) => {
    if (status === 'Валидный') return a.status === 'active'
    if (status === 'Заморожен') return a.status === 'frozen'
    if (status === 'Разавторизирован') return a.status === 'reauth'
    if (status === 'Невалидный') return a.status === 'invalid'
    return true
  })
  const sorted = [...filtered].sort((a, b) => sort === 'Сначала с высоким рейтингом' ? (b.ggr ?? 0) - (a.ggr ?? 0) : sort === 'Сначала с низким рейтингом' ? (a.ggr ?? 0) - (b.ggr ?? 0) : 0)
  return (
    <Card className="p-4">
      <Segmented className="mb-3" size="sm" options={sources} value={source} onChange={setSource} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Select className="w-44" value={status} onChange={setStatus} options={statuses.map((s) => ({ value: s, label: s }))} />
        <Select className="w-56" value={sort} onChange={setSort} options={['По умолчанию', 'Сначала с высоким рейтингом', 'Сначала с низким рейтингом'].map((s) => ({ value: s, label: s }))} />
      </div>
      {sorted.length === 0 ? (
        <EmptyState icon={<Sparkles size={24} />} title="У вас пока нет аккаунтов в панели" desc="Добавьте аккаунты или импортируйте .session / tdata." />
      ) : (
        <div className="space-y-1.5">
          {sorted.map((a) => (
            <div key={a.id} className="flex items-center gap-3 rounded-xl border border-line bg-elevated p-2.5">
              <Avatar name={a.name} color={a.avatarColor} size={32} />
              <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-fg">{a.name}</div><div className="truncate text-xs text-muted">@{a.username}</div></div>
              <StatusBadge status={a.status} />
              <div className="w-24">
                <div className="mb-1 flex items-center justify-between text-xs"><span className="text-muted">GGR</span><span className="font-bold text-fg">{a.ggr}</span></div>
                <div className="h-1.5 overflow-hidden rounded-full bg-line"><div className={cn('h-full rounded-full', (a.ggr ?? 0) > 80 ? 'bg-spark-500' : (a.ggr ?? 0) > 60 ? 'bg-amber-500' : 'bg-rose-500')} style={{ width: `${a.ggr}%` }} /></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/* ── Warming windows ── */
function WarmingPanel({ timezone, duration }: { timezone: string; duration: number }) {
  const [windows, setWindows] = useState([{ from: '09:00', to: '12:00' }])
  const pushToast = useApp((s) => s.pushToast)
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="label mb-0">Окна активности</span>
        <span className="flex items-center gap-1.5 text-xs text-muted"><Globe size={13} /> {timezone}</span>
      </div>
      <div className="space-y-2">
        {windows.map((w, i) => (
          <div key={i} className="flex items-center gap-2 rounded-xl border border-line bg-elevated p-2.5">
            <Clock size={15} className="text-spark-400" />
            <input defaultValue={w.from} className="input h-9 w-24 text-center" />
            <span className="text-muted">—</span>
            <input defaultValue={w.to} className="input h-9 w-24 text-center" />
            <span className="ml-auto text-xs text-muted">{duration}м</span>
            <button onClick={() => setWindows((ws) => ws.filter((_, j) => j !== i))} className="text-faint hover:text-rose-300"><Trash2 size={15} /></button>
          </div>
        ))}
      </div>
      <button onClick={() => { setWindows((w) => [...w, { from: '14:00', to: '17:00' }]); pushToast({ type: 'success', title: 'Окно добавлено' }) }} className="btn-ghost mt-2 h-9 w-full text-sm"><Plus size={15} /> Добавить окно</button>
    </Card>
  )
}

/* ── Parser results ── */
function ResultsPanel({ cfg, results, sort, setSort, langs, setLangs, pageSize, setPageSize, onClear }: {
  cfg: NonNullable<ModuleConfig['results']>
  results: ParseResult[]
  sort: string; setSort: (s: string) => void
  langs: Set<string>; setLangs: (s: Set<string>) => void
  pageSize: number; setPageSize: (n: number) => void
  onClear: () => void
}) {
  const pushToast = useApp((s) => s.pushToast)
  const FLAGS: Record<string, string> = { ru: '🇷🇺', ua: '🇺🇦', en: '🇬🇧' }
  const filtered = results.filter((r) => langs.size === 0 || langs.has(r.lang))
  const iconFor = (a: string): React.ReactNode => {
    if (a.includes('ссылк') || a.includes('ID')) return <Copy size={13} />
    if (a.includes('Экспорт')) return <Download size={13} />
    if (a.includes('Очистить')) return <Trash2 size={13} />
    return null
  }
  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-4">
        <div className="text-sm font-bold text-fg">Результаты <span className="ml-1 rounded-md bg-elevated px-1.5 py-0.5 font-mono text-xs text-muted">{filtered.length}</span></div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {cfg.toolbar.map((t) => (
            <button key={t} onClick={() => { if (t === 'Очистить') { onClear(); pushToast({ type: 'info', title: 'Результаты очищены' }) } else pushToast({ type: 'success', title: t, desc: 'Демо-действие.' }) }} className="btn-ghost h-8 text-xs">{iconFor(t)} {t}</button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <Select className="w-52" value={sort} onChange={setSort} placeholder="Сортировать по..." options={cfg.sortOptions.filter((s) => s !== 'Сортировать по...').map((s) => ({ value: s, label: s }))} />
        {cfg.languageFilter && (
          <div className="flex items-center gap-1.5">
            {LANGUAGES.map((l) => {
              const on = langs.has(l.code)
              return <button key={l.code} onClick={() => { const n = new Set(langs); n.has(l.code) ? n.delete(l.code) : n.add(l.code); setLangs(n) }} className={cn('chip', on ? 'chip-active' : 'text-muted')}>{l.flag} {l.label}</button>
            })}
          </div>
        )}
        {cfg.pageSizes && <Select className="ml-auto w-28" value={String(pageSize)} onChange={(v) => setPageSize(Number(v))} options={cfg.pageSizes.map((n) => ({ value: String(n), label: `${n} / стр` }))} />}
      </div>
      <div className="flex flex-wrap gap-2 border-b border-line p-4">
        {cfg.stats.map((s) => (
          <div key={s.label} className={cn('rounded-xl border px-3 py-2', s.accent ? 'border-spark-500/40 bg-spark-500/8' : 'border-line bg-elevated')}>
            <div className={cn('font-display text-lg font-bold', s.accent ? 'text-spark-300' : 'text-fg')}>{s.value}</div>
            <div className="text-[11px] text-muted">{s.label}</div>
          </div>
        ))}
      </div>
      {filtered.length === 0 ? (
        <EmptyState icon={<Sparkles size={26} />} title="Результатов пока нет" desc={cfg.emptyText} />
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-line text-left text-[11px] font-bold uppercase tracking-wide text-muted">
                <th className="px-4 py-2.5">Название</th>
                <th className="px-4 py-2.5">Username</th>
                {cfg.kind !== 'user' && <th className="px-4 py-2.5 text-right">Участники</th>}
                <th className="px-4 py-2.5">Язык</th>
                <th className="px-4 py-2.5 text-right">Метки</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-line/50 last:border-0 hover:bg-elevated/40">
                  <td className="px-4 py-2.5 font-semibold text-fg">{r.title}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-iris-300">@{r.username}</td>
                  {cfg.kind !== 'user' && <td className="px-4 py-2.5 text-right font-mono text-fg">{compact(r.members)}</td>}
                  <td className="px-4 py-2.5">{FLAGS[r.lang]}</td>
                  <td className="px-4 py-2.5 text-right">
                    {r.verified && <Badge tone="spark">✓ verified</Badge>}
                    {r.premium && <Badge tone="iris">★ premium</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-line px-4 py-2">
            <span className="text-xs text-muted">Показано {Math.min(filtered.length, pageSize)} из {filtered.length}</span>
            <button className="flex items-center gap-1 text-xs font-semibold text-muted hover:text-fg"><ArrowUp size={13} /> Наверх</button>
          </div>
        </div>
      )}
    </Card>
  )
}
