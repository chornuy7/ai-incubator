import { useCallback, useMemo, useState } from 'react'
import {
  Play, Sparkles, Hash, Settings2, Clock, Timer, Users, MessageSquareText,
  Heart, Eye, Shield, MessageCircle, Database, Trophy, LayoutGrid, List, Link2, Plus,
} from 'lucide-react'
import { MODULES, type ModuleConfig } from '@/shared/config/modules'
import { activeAccounts, useApp } from '@/mocks/store'
import { ToggleGroup, Segmented, EmptyState, Badge } from '@/shared/ui'
import { LogsPanel } from '@/widgets/LogsPanel'
import { AccountPicker } from '@/features/account-picker/AccountPicker'
import { useModuleTask } from './shared/useModuleTask'
import {
  SectionCard, NumberField, DelayFields, SingleDelayField,
  ProtectionBlock, TargetsEditor, LaunchPanel, PromptCards, loadPromptBodies, AiGenerationNotice,
} from './shared'
import type { ModuleTaskSettings } from '@/api/modulesApi'

const DEFAULT_DELAYS = {
  comment: [30, 120] as [number, number],
  action: [30, 120] as [number, number],
  join: [84, 156] as [number, number],
  floodWait: 120,
  floodQuarantine: 3,
}

export function LiveModule({ moduleKey }: { moduleKey: string }) {
  const cfg = MODULES[moduleKey]
  if (!cfg) return null
  return <LiveModuleInner cfg={cfg} moduleKey={moduleKey} />
}

function LiveModuleInner({ cfg, moduleKey }: { cfg: ModuleConfig; moduleKey: string }) {
  const accounts = activeAccounts(useApp((s) => s.data))
  const { task, running, starting, start, stop, savePreset, pushToast } = useModuleTask(moduleKey)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [toggles, setToggles] = useState<Record<number, number>>({})
  const [aiProtect, setAiProtect] = useState(true)
  const [protLevel, setProtLevel] = useState(1)
  const [probability, setProbability] = useState(cfg.probabilitySlider?.value ?? cfg.reactionSettings?.probability.value ?? 30)
  const [maxActions, setMaxActions] = useState(cfg.workModeFields?.maxValue ?? cfg.reactionSettings?.max.value ?? 100)
  const [maxPerAcc, setMaxPerAcc] = useState(10)
  const [minWords, setMinWords] = useState(0)
  const [durationMinutes, setDurationMinutes] = useState(cfg.reactionSettings?.duration.value ?? 60)
  const [srcTab, setSrcTab] = useState(0)
  const [input, setInput] = useState('')
  const [targets, setTargets] = useState<string[]>([])
  const [postInput, setPostInput] = useState('')
  const [postUrls, setPostUrls] = useState<string[]>([])
  const [keywords, setKeywords] = useState((cfg.defaultKeywords || []).join(', '))
  const [activePrompt, setActivePrompt] = useState(0)
  const [promptBodies, setPromptBodies] = useState(() => loadPromptBodies(moduleKey, cfg.messagePrompts ?? []))
  const [delayPreset, setDelayPreset] = useState(1)
  const [delays, setDelays] = useState(DEFAULT_DELAYS)
  const [palette, setPalette] = useState<Set<string>>(new Set(['👍', '❤️', '🔥']))
  const [viewTab, setViewTab] = useState(1)
  const [historyGrid, setHistoryGrid] = useState(true)

  const g = (i: number) => toggles[i] ?? 0
  const setTg = (i: number, v: number) => setToggles((t) => ({ ...t, [i]: v }))
  const needsTargets = Boolean(
    cfg.richLayout ||
    cfg.lookingLayout ||
    ['parsing-users', 'parsing-messages', 'parsing-comments'].includes(moduleKey),
  )
  const isParser = cfg.parserLayout || cfg.participantsLayout
  const isGgr = cfg.ggrLayout

  const addTargets = () => {
    const parsed = input.split(/[\n,\s]+/).map((s) => s.trim().replace(/^@/, '').replace(/https?:\/\/t\.me\//i, '').split('/')[0]).filter(Boolean)
    if (!parsed.length) return pushToast({ type: 'error', title: 'Нет целей' })
    setTargets((t) => [...new Set([...parsed, ...t])])
    setInput('')
    pushToast({ type: 'success', title: 'Добавлено', desc: `${parsed.length}` })
  }

  const addPostUrls = () => {
    const parsed = postInput.split('\n').map((s) => s.trim()).filter((s) => /t\.me\/(c\/\d+\/\d+|[a-zA-Z0-9_]+\/\d+)/i.test(s))
    if (!parsed.length) return pushToast({ type: 'error', title: 'Нет ссылок', desc: 'Формат: t.me/channel/123 или t.me/c/1234567890/42' })
    setPostUrls((p) => [...new Set([...parsed, ...p])])
    setPostInput('')
    pushToast({ type: 'success', title: 'Посты добавлены', desc: `${parsed.length}` })
  }

  const buildSettings = useCallback((): ModuleTaskSettings => ({
    accountIds: isGgr ? accounts.map((a) => a.id) : [...selected],
    targets,
    channels: targets,
    keywords: keywords.split(/[\n,;]+/).map((k) => k.trim()).filter(Boolean),
    commentMode: g(0),
    workMode: g(1),
    postFilter: g(2),
    probability,
    maxActions,
    maxComments: maxActions,
    maxPerAccount: maxPerAcc,
    minWords,
    durationMinutes: g(1) === 1 ? durationMinutes : undefined,
    aiProtection: aiProtect,
    protectionLevel: protLevel,
    promptIndex: activePrompt,
    promptText: promptBodies[activePrompt],
    promptOverrides: promptBodies,
    delayPreset,
    emojis: [...palette],
    postUrls,
    limit: maxActions,
    delays,
  }), [selected, targets, postUrls, toggles, probability, maxActions, maxPerAcc, minWords, durationMinutes, aiProtect, protLevel, activePrompt, promptBodies, delayPreset, palette, delays, keywords, isGgr, accounts])

  const hasPostTargets = postUrls.length > 0
  const busySelectedCount = useMemo(
    () => [...selected].filter((id) => accounts.some((a) => a.id === id && a.busyIn)).length,
    [selected, accounts],
  )
  const canStart = isGgr
    ? accounts.length > 0
    : selected.size > 0 && busySelectedCount === 0 && (!needsTargets || targets.length > 0 || hasPostTargets)
  const warn = !canStart
    ? (isGgr ? 'Нет аккаунтов в панели' : busySelectedCount ? `${busySelectedCount} акк. заняты в другом модуле` : !selected.size ? 'Выберите аккаунты' : 'Добавьте группу или ссылку на пост')
    : undefined

  const handleStart = () => void start(buildSettings(), `${cfg.title} · ${selected.size || accounts.length} акк.`)
  const handleSave = () => {
    const name = window.prompt('Название пресета')
    if (name?.trim()) void savePreset(name.trim(), buildSettings())
  }

  const logs = task?.logs ?? []
  const history = task?.commentHistory ?? task?.history ?? []
  const results = task?.results ?? []
  const progressDone = task?.progress.actionsDone ?? task?.progress.commentsSent ?? 0

  const launchStats = useMemo(() => {
    if (isGgr) return [
      { icon: <Trophy size={18} />, color: '#7145ff', label: 'Аккаунтов', value: String(accounts.length) },
      { icon: <Database size={18} />, color: '#06b6d4', label: 'Проверено', value: String(results.length) },
      { icon: <Shield size={18} />, color: '#0ec464', label: 'Валидных', value: String(results.filter((r) => r.status === 'valid').length) },
      { icon: <Clock size={18} />, color: '#f59e0b', label: 'Статус', value: task?.status ?? '—' },
    ]
    return [
      { icon: <Users size={18} />, color: '#7145ff', label: 'Аккаунты', value: String(selected.size), warn: selected.size === 0 },
      { icon: <Hash size={18} />, color: '#06b6d4', label: cfg.unit?.title ?? 'Цели', value: String(targets.length), warn: needsTargets && !targets.length && !hasPostTargets },
      { icon: <Clock size={18} />, color: '#0ec464', label: 'Интервал', value: `${delays.action[0]}–${delays.action[1]}с` },
      { icon: cfg.reactionSettings ? <Heart size={18} /> : <MessageSquareText size={18} />, color: '#f59e0b', label: 'Лимит', value: String(maxActions) },
    ]
  }, [selected, targets, postUrls, hasPostTargets, delays, maxActions, cfg, isGgr, accounts, results, task, needsTargets])

  return (
    <div className="space-y-4">
      {cfg.accountPicker && (
        <AccountPicker selected={selected} onChange={setSelected} actions={cfg.accountActions} withFilters={!!cfg.accountFilters} selectedTitle={cfg.selectedTitle ?? 'Выбрано'} />
      )}

      {(cfg.aiProtection || cfg.richLayout || cfg.lookingLayout || cfg.warmingLayout) && (
        <SectionCard icon={<Settings2 size={18} />} title={cfg.settingsTitle ?? 'Настройки'} badge={targets.length ? `${targets.length} целей` : undefined}>
          {cfg.aiProtection && <ProtectionBlock enabled={aiProtect} onEnabled={setAiProtect} level={protLevel} onLevel={setProtLevel} />}

          {cfg.reactionSettings ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-4 rounded-2xl border border-line bg-elevated/40 p-4">
                <ToggleGroup label="Режим" options={cfg.reactionSettings.modes} value={g(0)} onChange={(v) => setTg(0, v)} />
                <NumberField label={cfg.reactionSettings.duration.label} value={durationMinutes} onChange={setDurationMinutes} suffix={`${durationMinutes}m`} />
                <NumberField label={cfg.reactionSettings.max.label} value={maxActions} onChange={setMaxActions} />
                <NumberField label="На аккаунт" value={maxPerAcc} onChange={setMaxPerAcc} />
                <div>
                  <div className="mb-1 flex justify-between text-sm text-muted"><span>{cfg.reactionSettings.probability.label}</span><span className="text-spark-300">{probability}%</span></div>
                  <input type="range" min={0} max={100} value={probability} onChange={(e) => setProbability(Number(e.target.value))} className="w-full accent-spark-500" />
                </div>
              </div>
              <div className="rounded-2xl border border-line bg-elevated/40 p-4 text-sm text-muted">Правила реагирования применяются на сервере с учётом защиты аккаунтов.</div>
            </div>
          ) : cfg.toggleGroups ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-4 rounded-2xl border border-line bg-elevated/40 p-4">
                <ToggleGroup label={cfg.toggleGroups[0].label} options={cfg.toggleGroups[0].options} value={g(0)} onChange={(v) => setTg(0, v)} />
                {g(0) === 1 && <textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} rows={2} className="input resize-none text-sm" placeholder="ключевые слова" />}
                <div>
                  <div className="mb-1 flex justify-between text-sm text-muted"><span>{cfg.probabilitySlider?.label ?? 'Вероятность'}</span><span className="text-spark-300">{probability}%</span></div>
                  <input type="range" min={0} max={100} value={probability} onChange={(e) => setProbability(Number(e.target.value))} className="w-full accent-spark-500" />
                </div>
                {cfg.toggleGroups[2] && <ToggleGroup label={cfg.toggleGroups[2].label} options={cfg.toggleGroups[2].options} value={g(2)} onChange={(v) => setTg(2, v)} />}
              </div>
              <div className="space-y-4 rounded-2xl border border-line bg-elevated/40 p-4">
                <ToggleGroup label={cfg.toggleGroups[1].label} options={cfg.toggleGroups[1].options} value={g(1)} onChange={(v) => setTg(1, v)} />
                {g(1) === 1 ? (
                  <NumberField label="Длительность (мин)" value={durationMinutes} onChange={setDurationMinutes} />
                ) : (
                  <>
                    <NumberField label={cfg.workModeFields?.maxLabel ?? 'Макс.'} value={maxActions} onChange={setMaxActions} />
                    <NumberField label="На аккаунт" value={maxPerAcc} onChange={setMaxPerAcc} />
                    {cfg.workModeFields?.minWords && <NumberField label="Мин. слов" value={minWords} onChange={setMinWords} />}
                  </>
                )}
              </div>
            </div>
          ) : isParser ? (
            <div className="space-y-3">
              <label className="label">Ключевые слова / источник</label>
              <textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} rows={2} className="input resize-none text-sm" />
              <NumberField label="Лимит результатов" value={maxActions} onChange={setMaxActions} />
            </div>
          ) : isGgr ? (
            <p className="text-sm text-muted">Проверка всех аккаунтов панели: сессия, профиль, базовый GGR-скоринг.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField label="Макс. действий" value={maxActions} onChange={setMaxActions} />
              <NumberField label="На аккаунт" value={maxPerAcc} onChange={setMaxPerAcc} />
            </div>
          )}
        </SectionCard>
      )}

      {(cfg.sourceTabs || needsTargets) && !isGgr && (
        <SectionCard icon={<Hash size={18} />} title={cfg.sourceTabs?.label ?? 'Цели'} badge={String(targets.length)}>
          <TargetsEditor
            tabs={cfg.sourceTabs?.tabs}
            tab={srcTab}
            onTab={setSrcTab}
            input={input}
            onInput={setInput}
            targets={targets}
            onAdd={addTargets}
            onClear={() => setTargets([])}
            onRemove={(t) => setTargets((arr) => arr.filter((x) => x !== t))}
            placeholder={cfg.sourceTabs?.placeholder ?? '@username или t.me/...'}
          />
        </SectionCard>
      )}

      {cfg.postLinks && (
        <SectionCard icon={<Link2 size={18} />} title={cfg.postLinks.label} badge={String(postUrls.length)}>
          {cfg.postLinks.hint && <p className="mb-3 text-xs text-muted">{cfg.postLinks.hint}</p>}
          <div className="flex gap-2">
            <textarea
              value={postInput}
              onChange={(e) => setPostInput(e.target.value)}
              rows={3}
              className="input resize-none font-mono text-sm"
              placeholder={cfg.postLinks.placeholder}
            />
            <button type="button" onClick={addPostUrls} className="btn-ghost h-auto shrink-0 flex-col px-4">
              <Plus size={16} /> Добавить
            </button>
          </div>
          {postUrls.length > 0 && (
            <div className="mt-4 flex max-h-52 flex-col gap-1.5 overflow-y-auto rounded-xl border border-line bg-elevated/40 p-3">
              {postUrls.map((url) => (
                <span key={url} className="inline-flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs font-medium text-fg">
                  <span className="truncate font-mono">{url}</span>
                  <button type="button" onClick={() => setPostUrls((arr) => arr.filter((x) => x !== url))} className="shrink-0 text-faint hover:text-rose-300">×</button>
                </span>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {cfg.reactionPalette && (
        <SectionCard icon={<Heart size={18} />} title="Эмодзи">
          <div className="flex flex-wrap gap-2">
            {cfg.reactionPalette.map((e) => (
              <button key={e} type="button" onClick={() => { const n = new Set(palette); n.has(e) ? n.delete(e) : n.add(e); setPalette(n) }} className={`grid h-11 w-11 place-items-center rounded-xl border text-xl ${palette.has(e) ? 'border-spark-500/50 bg-spark-500/12' : 'border-line bg-elevated'}`}>{e}</button>
            ))}
          </div>
        </SectionCard>
      )}

      {cfg.messagePrompts && (
        <SectionCard icon={<Sparkles size={18} />} title="AI / промпты">
          <div className="space-y-3">
            <AiGenerationNotice />
            <PromptCards
            moduleKey={moduleKey}
            labels={cfg.messagePrompts}
            activeIndex={activePrompt}
            onActiveChange={setActivePrompt}
            onBodiesChange={setPromptBodies}
          />
          </div>
        </SectionCard>
      )}

      {cfg.delays && (
        <SectionCard icon={<Timer size={18} />} title="Задержки" right={cfg.delayPresets && <Segmented size="sm" options={cfg.delayPresets} value={delayPreset} onChange={setDelayPreset} />}>
          <DelayFields label="Действие" from={delays.action[0]} to={delays.action[1]} onFrom={(n) => setDelays((d) => ({ ...d, action: [n, d.action[1]] }))} onTo={(n) => setDelays((d) => ({ ...d, action: [d.action[0], n] }))} unit="с" />
          <DelayFields label="Вступление" from={delays.join[0]} to={delays.join[1]} onFrom={(n) => setDelays((d) => ({ ...d, join: [n, d.join[1]] }))} onTo={(n) => setDelays((d) => ({ ...d, join: [d.join[0], n] }))} unit="с" />
          <SingleDelayField label="FloodWait (сек)" value={delays.floodWait} onChange={(n) => setDelays((d) => ({ ...d, floodWait: n }))} />
          <SingleDelayField label="FloodWait → карантин" value={delays.floodQuarantine} onChange={(n) => setDelays((d) => ({ ...d, floodQuarantine: n }))} />
        </SectionCard>
      )}

      <SectionCard icon={<Play size={18} />} title={running ? 'Выполнение' : 'Запуск'} badge={running ? 'LIVE' : undefined}>
        <LaunchPanel
          running={running}
          starting={starting}
          canStart={canStart}
          onStart={handleStart}
          onStop={stop}
          onSave={handleSave}
          primaryLabel={cfg.primaryAction ?? 'Начать'}
          stats={launchStats}
          task={task}
          warn={warn}
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Segmented options={['Визуал', 'Логи']} value={viewTab} onChange={setViewTab} size="sm" />
          {viewTab === 0 && (
            <div className="inline-flex rounded-lg border border-line bg-elevated p-0.5">
              <button type="button" onClick={() => setHistoryGrid(false)} className={`rounded p-1.5 ${!historyGrid ? 'bg-surface text-fg' : 'text-muted'}`}><List size={15} /></button>
              <button type="button" onClick={() => setHistoryGrid(true)} className={`rounded p-1.5 ${historyGrid ? 'bg-surface text-fg' : 'text-muted'}`}><LayoutGrid size={15} /></button>
            </div>
          )}
        </div>
      </SectionCard>

      {viewTab === 1 ? (
        <LogsPanel logs={logs} emptyText={cfg.logEmpty ?? 'Логов пока нет'} title="Логи выполнения" live={running} />
      ) : (
        <SectionCard icon={<MessageCircle size={18} />} title={isParser || isGgr ? 'Результаты' : 'История'} badge={String(isParser || isGgr ? results.length : history.length)}>
          {(isParser || isGgr) && results.length > 0 ? (
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-line text-left text-xs text-muted"><th className="py-2">Имя</th><th>Детали</th><th>Статус</th></tr></thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i} className="border-b border-line/50">
                      <td className="py-2 font-medium text-fg">{String(r.name ?? r.title ?? r.username ?? '—')}</td>
                      <td className="text-muted">{String(r.username ? `@${r.username}` : r.score ?? r.members ?? r.id ?? '')}</td>
                      <td><Badge tone={r.status === 'valid' ? 'spark' : 'muted'}>{String(r.status ?? r.kind ?? 'ok')}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : history.length > 0 ? (
            historyGrid ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {history.map((h, i) => (
                  <div key={i} className="rounded-xl border border-line bg-elevated/40 p-3 text-sm">
                    <div className="text-xs text-muted">{String(h.accountName ?? '')} · @{String(h.channel ?? h.target ?? '')}</div>
                    <p className="mt-1 text-fg">{String(h.comment ?? h.text ?? h.emoji ?? '')}</p>
                  </div>
                ))}
              </div>
            ) : (
              <ul className="space-y-2">{history.map((h, i) => (
                <li key={i} className="rounded-xl border border-line bg-elevated/40 p-3 text-sm text-fg">{String(h.comment ?? h.text ?? JSON.stringify(h))}</li>
              ))}</ul>
            )
          ) : (
            <EmptyState icon={<Eye size={22} />} title="Пока пусто" desc={`Действий: ${progressDone}. Запустите модуль.`} />
          )}
        </SectionCard>
      )}

      {cfg.blacklistEmpty && (
        <div className="rounded-2xl border border-line bg-elevated/40 p-4 text-xs text-muted">{cfg.blacklistEmpty}</div>
      )}
    </div>
  )
}
