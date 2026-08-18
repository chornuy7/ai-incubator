import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Sparkles, MessagesSquare, Mail, Users,
  ChevronDown, Check, Image as ImageIcon, Settings2,
} from 'lucide-react'
import { MODULES } from '@/shared/config/modules'
import { isHidden } from '@/shared/config/routes'
import { useApp } from '@/mocks/store'
import { Badge, Switch, Select, Segmented } from '@/shared/ui'
import { AccountPicker } from '@/features/account-picker/AccountPicker'
import { fetchGoals, type Goal } from '@/api/goalsApi'
import { fetchPricing } from '@/api/balanceApi'
import { cn } from '@/shared/lib/utils'
import { promptDialog } from '@/shared/lib/dialog'
// Из API диалогов модулю нужен только СПИСОК: он показывает сводку «сколько диалогов и
// непрочитанных», а читают и отвечают руками на «Обзоре аккаунта».
import { fetchInbox, type InboxDialog } from '@/api/neuroDialogsApi'
import { useModuleTask } from '@/features/modules/shared/useModuleTask'
import { PresetBar } from '@/features/modules/shared/PresetBar'
import {
  SectionCard,
  HelpButton,
  NumberField,
  LaunchPanel,
  LaunchSteps,
  markCurrentStep,
  PromptCards,
  loadPromptBodies,
  ProtectionBlock,
  AiGenerationNotice,
  TimingSection,
  TaskStartedModal,
  type DelaysShape,
} from '@/features/modules/shared'
import type { ModuleTaskSettings } from '@/api/modulesApi'

const cfg = MODULES['neuro-dialogs']!

const GOAL_KEY = 'neuro-dialogs:goal'
const GOAL_ID_KEY = 'neuro-dialogs:goalId'
const SCOPE_KEY = 'neuro-dialogs:replyAll'
const IMG_KEY = 'neuro-dialogs:analyzeImages' // §10.5





export function NeuroDialogsModule() {
  const pushToast = useApp((s) => s.pushToast)
  const { task, running, starting, start, stop, savePreset, deletePreset, editPreset, presets, justStarted, dismissJustStarted } = useModuleTask('neuro-dialogs')

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [aiOpen, setAiOpen] = useState(true)
  const [aiEnabled, setAiEnabled] = useState(true)
  const [replyAll, setReplyAll] = useState(() => localStorage.getItem(SCOPE_KEY) === '1')
  const [dialogGoal, setDialogGoal] = useState(() => localStorage.getItem(GOAL_KEY) ?? '')
  const [analyzeImages, setAnalyzeImages] = useState(() => localStorage.getItem(IMG_KEY) === '1') // §10.5
  const [imageMult, setImageMult] = useState<number | null>(null) // §10.5: наценка «картинка ×N» из админки
  const [goals, setGoals] = useState<Goal[]>([])
  const [goalId, setGoalId] = useState(() => localStorage.getItem(GOAL_ID_KEY) ?? '') // §9: цель кампании
  const [aiProtect, setAiProtect] = useState(true)
  const [protLevel, setProtLevel] = useState(1)
  const [activePrompt, setActivePrompt] = useState(0)
  const [promptBodies, setPromptBodies] = useState(() =>
    loadPromptBodies('neuro-dialogs', cfg.messagePrompts ?? []),
  )
  // Лимиты для ЛС. Важно: общий лимит и лимит на аккаунт — это ДИАПАЗОН [min, max],
  // из которого воркер берёт случайное число (антидетект). Для авто-ответчика min по умолчанию
  // равен max, иначе цель могла бы выпасть в 0–1 и задача завершалась бы после первого ответа.
  // Лимит на аккаунт держим равным общему, чтобы один аккаунт не «упирался» раньше времени
  // и монитор не висел в статусе «работает», ничего не отвечая.
  const [maxActions, setMaxActions] = useState(50)
  const [minActions, setMinActions] = useState(50)
  const [maxPerAcc, setMaxPerAcc] = useState(50)
  const [minPerAcc, setMinPerAcc] = useState(50)
  // §9: лимит переписки с ОДНИМ лидом. По умолчанию — вести до целевого действия.
  const [replyLimitMode, setReplyLimitMode] = useState<'untilTarget' | 'count'>('untilTarget')
  const [maxRepliesPerLead, setMaxRepliesPerLead] = useState(5)
  const [delayPreset, setDelayPreset] = useState(1)
  const [delays, setDelays] = useState<DelaysShape>({
    comment: [30, 120],
    action: [20, 90],
    join: [84, 156],
    floodWait: 120,
    floodQuarantine: 3,
  })

  const [dialogs, setDialogs] = useState<InboxDialog[]>([])

  const accountIds = useMemo(() => [...selected], [selected])


  const totalUnread = useMemo(() => dialogs.reduce((s, d) => s + (d.unread || 0), 0), [dialogs])

  useEffect(() => { localStorage.setItem(GOAL_KEY, dialogGoal) }, [dialogGoal])
  useEffect(() => { localStorage.setItem(GOAL_ID_KEY, goalId) }, [goalId])
  useEffect(() => { localStorage.setItem(SCOPE_KEY, replyAll ? '1' : '0') }, [replyAll])
  useEffect(() => { localStorage.setItem(IMG_KEY, analyzeImages ? '1' : '0') }, [analyzeImages])
  // §10.5: подтягиваем актуальную наценку за изображение — показать «×N» у тумблера.
  useEffect(() => { void fetchPricing().then((p) => setImageMult(p.imageMultiplier ?? null)).catch(() => {}) }, [])
  useEffect(() => { void fetchGoals().then(setGoals).catch(() => {}) }, [])

  const buildSettings = useCallback((): ModuleTaskSettings => ({
    accountIds,
    aiProtection: aiProtect,
    protectionLevel: protLevel,
    promptIndex: activePrompt,
    promptText: promptBodies[activePrompt],
    promptOverrides: promptBodies,
    maxActions,
    minActions,
    maxPerAccount: maxPerAcc,
    minPerAccount: minPerAcc,
    delayPreset,
    delays,
    probability: aiEnabled ? 100 : 0,
    replyScope: replyAll ? 'all' : 'unread',
    dialogGoal: dialogGoal.trim(),
    analyzeImages, // §10.5: описывать входящие фото vision-моделью
    // §9: сколько сообщений пишем ОДНОМУ лиду — числом или до целевого действия.
    replyLimitMode,
    maxRepliesPerLead: replyLimitMode === 'count' ? maxRepliesPerLead : 0,
    ...(goalId ? { goalId } : {}), // §9: привязка диалога к цели кампании (наследует KB/этапы, лиды к цели)
  }), [accountIds, aiProtect, protLevel, activePrompt, promptBodies, maxActions, minActions, maxPerAcc, minPerAcc, delayPreset, delays, aiEnabled, replyAll, dialogGoal, analyzeImages, goalId, replyLimitMode, maxRepliesPerLead])

  const applyPreset = useCallback((s: ModuleTaskSettings) => {
    if (s.aiProtection !== undefined) setAiProtect(s.aiProtection)
    if (s.protectionLevel !== undefined) setProtLevel(s.protectionLevel)
    if (s.promptIndex !== undefined) setActivePrompt(s.promptIndex)
    if (Array.isArray(s.promptOverrides)) setPromptBodies(s.promptOverrides)
    if (s.maxActions !== undefined) setMaxActions(s.maxActions)
    if (s.minActions !== undefined) setMinActions(s.minActions)
    if (s.maxPerAccount !== undefined) setMaxPerAcc(s.maxPerAccount)
    if (s.minPerAccount !== undefined) setMinPerAcc(s.minPerAccount)
    if (s.delayPreset !== undefined) setDelayPreset(s.delayPreset)
    if (s.delays) setDelays((d) => ({ ...d, ...s.delays }))
    if (s.probability !== undefined) setAiEnabled(s.probability > 0)
    if (s.replyScope) setReplyAll(s.replyScope === 'all')
    if (typeof s.dialogGoal === 'string') setDialogGoal(s.dialogGoal)
    if (typeof s.analyzeImages === 'boolean') setAnalyzeImages(s.analyzeImages)
    if (typeof s.goalId === 'string') setGoalId(s.goalId)
    if (s.replyLimitMode === 'count' || s.replyLimitMode === 'untilTarget') setReplyLimitMode(s.replyLimitMode)
    if (typeof s.maxRepliesPerLead === 'number' && s.maxRepliesPerLead > 0) setMaxRepliesPerLead(s.maxRepliesPerLead)
    pushToast({ type: 'success', title: 'Шаблон применён' })
  }, [pushToast])

  const loadInbox = useCallback(async () => {
    if (!accountIds.length) {
      setDialogs([])
      return
    }
    try {
      const res = await fetchInbox(accountIds, 120)
      setDialogs(res.dialogs.filter((d) => !d.error))
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Не удалось загрузить диалоги',
        desc: err instanceof Error ? err.message : 'Ошибка',
      })
    }
  }, [accountIds, pushToast])



  useEffect(() => {
    void loadInbox()
  }, [loadInbox])

  useEffect(() => {
    if (!accountIds.length) return
    const t = setInterval(() => void loadInbox(), 25_000)
    return () => clearInterval(t)
  }, [accountIds.length, loadInbox])

  const canStart = accountIds.length > 0

  // Сохранение шаблона доступно из двух мест (полоса вверху и кнопка в баре) — обработчик один.
  const handleSavePreset = async () => {
    const name = await promptDialog({ title: 'Сохранить шаблон', message: 'Название шаблона настроек', placeholder: 'Напр. Тёплый диалог' })
    if (name) void savePreset(name, buildSettings())
  }

  return (
    <div className="space-y-4">
      <TaskStartedModal task={justStarted} moduleTitle={cfg.title} onClose={dismissJustStarted} />
      {/* ТЗ 06.08 §10: выбор шаблона — вверху, до всех настроек (TPL-001). */}
      <PresetBar presets={presets} onApply={applyPreset} onSave={handleSavePreset}
        onEdit={editPreset} onDelete={deletePreset} disabled={running} />
      <div id="sec-accounts" className="scroll-mt-24">
        <AccountPicker
          selected={selected}
          onChange={setSelected}
          actions={cfg.accountActions}
          withFilters={!!cfg.accountFilters}
          selectedTitle={cfg.selectedTitle ?? 'Выбрано'}
        />
      </div>

      {/* §3 (MR-113 · 17.08): «Защита аккаунтов» — ОТДЕЛЬНЫМ блоком, как во всех модулях
          (раньше была вложена внутрь «ИИ авто-ответы» — расходилось с единой структурой). */}
      <div id="sec-protect" className="scroll-mt-24">
        <SectionCard icon={<Settings2 size={18} />} title="Защита">
          <ProtectionBlock enabled={aiProtect} onEnabled={setAiProtect} level={protLevel} onLevel={setProtLevel} />
        </SectionCard>
      </div>

      <div className="card p-0">
        <div className="flex items-center gap-3 px-4 py-3.5">
          <button
            type="button"
            onClick={() => setAiOpen((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-iris-500/12 text-iris-400">
              <Sparkles size={18} />
            </span>
            <span className="font-display text-base font-bold text-fg">ИИ авто-ответы</span>
            <Badge tone={aiEnabled ? 'spark' : 'muted'}>{aiEnabled ? 'включено' : 'выключено'}</Badge>
            <ChevronDown size={16} className={cn('ml-auto text-muted transition-transform', !aiOpen && '-rotate-90')} />
          </button>
          <HelpButton topic="НейроДиалоги" />
        </div>
        {aiOpen && (
          <div className="space-y-4 border-t border-line p-4">
            <Switch
              checked={aiEnabled}
              onChange={setAiEnabled}
              label="Отвечать на входящие автоматически"
              desc="ИИ генерирует ответы на новые ЛС при запущенном модуле"
            />
            <Switch
              checked={replyAll}
              onChange={setReplyAll}
              label="Отвечать всем, кто писал"
              desc="Не только новым: ИИ ответит в каждом ЛС, где последнее сообщение от собеседника — даже если оно уже прочитано"
            />

            {/* §10 (MR-49): цели/кампании скрыты глобально — «Цель кампании» прячем вместе с ними.
                Вернут раздел «Цели» (снимут hidden) — привязка к цели появится снова. */}
            {!isHidden('/panel/goals') && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-fg">Цель кампании <span className="text-[11px] font-normal text-faint">(опционально)</span></span>
                  <a href="/panel/goals" className="text-[11px] font-semibold text-spark-300 hover:underline">+ Создать цель</a>
                </div>
                <Select
                  value={goalId}
                  onChange={setGoalId}
                  placeholder="Без цели"
                  options={[{ value: '', label: 'Без цели' }, ...goals.map((g) => ({ value: g.id, label: g.name }))]}
                />
                <p className="text-[11px] leading-relaxed text-muted">Диалоги привяжутся к цели: ИИ учтёт её этапы и базу знаний, а лиды попадут в CRM к этой цели.</p>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-fg">Инструкция для ИИ · цель диалога</span>
                <span className="text-[11px] text-faint">{dialogGoal.trim().length} симв.</span>
              </div>
              <textarea
                value={dialogGoal}
                onChange={(e) => setDialogGoal(e.target.value)}
                rows={4}
                className="input w-full resize-none text-sm"
                placeholder={
                  'Ты — менеджер студии Auto Mapping.\n' +
                  'Цель: выяснить задачу клиента и пригласить на бесплатный созвон.\n' +
                  'Отвечай коротко, на «ты», задавай один уточняющий вопрос за раз.'
                }
              />
              <p className="text-xs leading-relaxed text-muted">
                Добавляется к выбранному промпту и применяется к каждому авто-ответу: кем быть, как общаться и к чему вести диалог.
              </p>
            </div>

            {/* §10.5: анализ входящих изображений. Отдельный тумблер, т.к. vision дороже
                текста — расход считается с наценкой «картинка ×N» из админки. */}
            <button
              type="button"
              onClick={() => setAnalyzeImages((v) => !v)}
              className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${analyzeImages ? 'border-spark-500/50 bg-spark-500/10' : 'border-line bg-surface hover:border-spark-500/30'}`}
            >
              <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border ${analyzeImages ? 'border-spark-500 bg-spark-500 text-[#04150c]' : 'border-line'}`}>{analyzeImages && <Check size={13} />}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-semibold text-fg"><ImageIcon size={14} className="shrink-0 text-spark-300" /> Анализировать входящие изображения</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted">
                  Если собеседник прислал фото — ИИ опишет его и учтёт в ответе. Расход vision дороже текста
                  {imageMult ? <> — <b className="text-fg">×{imageMult}</b> за изображение</> : ' (наценка задаётся в админке)'}.
                </span>
              </span>
            </button>

            <p className="rounded-xl border border-line bg-elevated/60 px-3 py-2 text-xs leading-relaxed text-muted">
              Авто-режим (кнопка «Начать») отвечает {replyAll
                ? <b className="text-fg">всем, кто написал последним</b>
                : <b className="text-fg">только на непрочитанные входящие ЛС</b>} выбранных аккаунтов — сам первым никому не пишет.
              Без ключа OpenAI ответы будут шаблонными и цель диалога учтена не будет. <b className="text-fg">Переписки</b> ниже — ручной инбокс: читайте и отвечайте руками.
            </p>
            {replyAll && (
              <p className="rounded-xl border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs leading-relaxed text-amber-200/90">
                Разбор накопившихся ЛС — самый рискованный режим: пачка ответов подряд с одного номера ловит PEER_FLOOD и репорты.
                Аккаунт отвечает не более чем в {[2, 4, 6][protLevel]} диалогах за заход и уходит в конец очереди, но лимиты и задержки
                в секции <b className="text-fg">«Тайминги и задержки»</b> всё равно стоит проверить перед первым запуском.
              </p>
            )}
          </div>
        )}
      </div>

      {/* §3 (MR-113 · ND-001): AI / промпты — ОТДЕЛЬНЫМ блоком, отдельно от настроек ИИ-ответов. */}
      {cfg.messagePrompts && (
        <SectionCard icon={<Sparkles size={18} />} title="AI / промпты">
          <div className="space-y-3">
            <AiGenerationNotice />
            <PromptCards
              moduleKey="neuro-dialogs"
              labels={cfg.messagePrompts}
              activeIndex={activePrompt}
              onActiveChange={setActivePrompt}
              onBodiesChange={setPromptBodies}
            />
          </div>
        </SectionCard>
      )}

      {/* §9: сколько сообщений ведём с ОДНИМ лидом — переключатель режима. */}
      <SectionCard icon={<MessagesSquare size={18} />} title="Переписка с одним лидом" id="sec-settings">
        <div className="flex flex-col gap-3">
          <Segmented
            options={['До целевого действия', 'Фиксировано']}
            value={replyLimitMode === 'untilTarget' ? 0 : 1}
            onChange={(i) => setReplyLimitMode(i === 0 ? 'untilTarget' : 'count')}
          />
          {replyLimitMode === 'untilTarget' ? (
            <p className="rounded-xl border border-spark-500/25 bg-spark-500/8 px-3 py-2 text-xs leading-relaxed text-muted">
              ИИ ведёт диалог, пока лид не выполнит целевое действие цели (статус «Целевое») —
              или пока не откажется («Закрыт»). Останавливают только суточные лимиты и защита.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <NumberField label="Максимум ответов одному лиду" value={maxRepliesPerLead} onChange={setMaxRepliesPerLead} min={1} max={50} suffix="1–50" />
              <p className="rounded-xl border border-line bg-elevated/60 px-3 py-2 text-xs leading-relaxed text-muted">
                После {maxRepliesPerLead} {maxRepliesPerLead === 1 ? 'ответа' : 'ответов'} диалог с этим человеком не продолжаем,
                даже если он пишет снова. Полезно, чтобы не «переписываться вечно».
              </p>
            </div>
          )}
          <p className="text-xs text-white/40">
            В обоих режимах отказ («не пиши мне») сразу закрывает лида — больше ему не пишем.
          </p>
        </div>
      </SectionCard>

      <TimingSection
        totalLabel="Ответов за запуск"
        total={{ min: minActions, max: maxActions, onMin: setMinActions, onMax: setMaxActions }}
        perAccount={{ min: minPerAcc, max: maxPerAcc, onMin: setMinPerAcc, onMax: setMaxPerAcc }}
        delays={delays}
        onDelays={(updater) => setDelays(updater)}
        showComment={false}
        showAction
        showJoin={false}
        labels={{ action: 'Задержка между ответами' }}
        delayPresets={['Агрессивный', 'Сбалансированный', 'Консервативный']}
        delayPreset={delayPreset}
        onDelayPreset={setDelayPreset}
      />

      <p className="rounded-xl border border-line bg-elevated/60 px-3 py-2 text-xs leading-relaxed text-muted">
        «Ответов за запуск» и «На аккаунт» — это диапазон: воркер берёт случайное число между «от» и «до» (для маскировки под живого человека).
        Если поставить «от» = 0, задача может случайно завершиться после первого же ответа. По умолчанию «от» = «до», то есть лимит фиксированный.
      </p>

      {/*
        Просмотр ЛС убран из НейроДиалогов (правка 18.08). Это была вторая копия
        «Обзора аккаунта» (/panel/inbox): тот же список диалогов и то же поле ответа.
        Модуль настраивает АВТООТВЕТЫ — читать и отвечать руками нужно на своём экране,
        а держать одно и то же в двух местах значит чинить каждую правку дважды.
      */}

      {/* Запуск — плавающая нижняя панель ПОСЛЕ списка диалогов, чтобы фиксированный бар их не перекрывал
          (без обёртки-карточки: панель уходит в нижний бар, карточка осталась бы пустой). */}
      <div id="sec-run" className="scroll-mt-24">
        <LaunchPanel
          running={running}
          starting={starting}
          canStart={canStart}
          steps={!running ? <LaunchSteps steps={markCurrentStep([
            { label: 'Аккаунты', done: accountIds.length > 0, anchor: 'sec-accounts' },
            { label: 'Настройки', done: true, optional: true, anchor: 'sec-settings' },
            { label: 'Запуск', done: false, anchor: 'sec-run' },
          ])} /> : null}
          blockedBy={!running && !canStart ? ['выберите аккаунты'] : []}
          onStart={() => { void start(buildSettings(), `${cfg.title} · ${selected.size} акк.`) }}
          onStop={stop}
          onSave={handleSavePreset}
          primaryLabel={cfg.primaryAction ?? 'Начать'}
          stats={[
            { icon: <MessagesSquare size={18} />, color: '#06b6d4', label: 'Диалогов', value: String(dialogs.length) },
            { icon: <Users size={18} />, color: '#7145ff', label: 'Аккаунтов', value: String(selected.size), warn: !selected.size },
            { icon: <Mail size={18} />, color: '#f59e0b', label: 'Непрочит.', value: String(totalUnread) },
            { icon: <Sparkles size={18} />, color: '#0ec464', label: 'ИИ', value: aiEnabled ? 'ON' : 'OFF' },
          ]}
          task={task}
          warn={!canStart ? 'Выберите хотя бы один аккаунт' : undefined}
          presets={presets}
          onApplyPreset={applyPreset}
        />
      </div>
    </div>
  )
}
