import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Mail, Send, AlertTriangle, ShieldAlert } from 'lucide-react'
import { PageHeader, Card, Select, Segmented } from '@/shared/ui'
import { DedupeButton } from '@/shared/ui/DedupeButton'
import type { MailingPrefill } from '@/features/mailing/TaskAudiencePanel'
import { useApp, activeAccounts } from '@/mocks/store'
import { AccountPicker } from '@/features/account-picker/AccountPicker'
import { MessageComposer } from '@/features/composer/MessageComposer'
import { useSession } from '@/features/auth/session'
import { fetchGoals, type Goal } from '@/api/goalsApi'
import { startModuleTask } from '@/api/modulesApi'
import { fetchSettings, saveSettings } from '@/api/settingsApi'
import { fetchLeads } from '@/api/leadsApi'
import { confirmDialog } from '@/shared/lib/dialog'
import { usePlan, planHasModule } from '@/features/billing/plan'
import { ModuleNotPaid } from '@/features/billing/ModuleNotPaid'

export function MailingPage() {
  // §5.4: модуль живёт не под /panel/modules/*, поэтому гейт подписки — здесь же.
  const planModules = usePlan((st) => st.modules)
  if (!planHasModule(planModules, 'mailing')) return <ModuleNotPaid title="Мейлинг" />

  const nav = useNavigate()
  const pushToast = useApp((s) => s.pushToast)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // §9.11: список, переданный кнопкой «В новую рассылку» из деталей прошлой задачи —
  // те, кому ещё не написали. Иначе человек сверял бы тысячу строк руками.
  const prefill = useLocation().state as MailingPrefill | null
  const [numbersText, setNumbersText] = useState(prefill?.targets || '')
  const [message, setMessage] = useState('')
  const [media, setMedia] = useState<string[]>([])
  const [maxPerAccount, setMaxPerAccount] = useState(25)
  const [delayMin, setDelayMin] = useState(90)
  const [delayMax, setDelayMax] = useState(300)
  const [protLevel, setProtLevel] = useState(0) // §11: паритет с masslooking/warming — уровень защиты
  const [delayPreset, setDelayPreset] = useState(1) // множитель задержек (Мин/Реком/Макс)
  const [goals, setGoals] = useState<Goal[]>([])
  const [goalId, setGoalId] = useState('')
  const [aiPerRecipient, setAiPerRecipient] = useState(false)
  const [launching, setLaunching] = useState(false)
  // §9: текст берётся из цели. Свой нужен, только если хочется отойти от неё —
  // раньше он был обязательным, и запустить рассылку по цели было нельзя вообще.
  const [ownText, setOwnText] = useState(false)
  // §3.3: аккаунты, ведущие горячий лид. Их нельзя забирать в рассылку — диалог
  // должен продолжаться. Сервер это запрещает, но раньше человек узнавал об этом
  // только по ошибке при запуске: аккаунты спокойно висели в выборке.
  const [hotAccounts, setHotAccounts] = useState<string[]>([])
  useEffect(() => {
    void fetchLeads({ status: 'hot' })
      .then((ls) => setHotAccounts([...new Set(ls.map((l) => l.accountId).filter(Boolean) as string[])]))
      .catch(() => {})
  }, [])
  // §9: цель ведёт весь процесс. Выбрал цель — можно сразу поднять чатинг под ней же:
  // рассылка приводит людей, чатинг ловит ответы и двигает их по воронке той же цели.
  const [withChat, setWithChat] = useState(true)
  // §3.9: потоки — общие для рассылки и чатинга: и то и другое работает одновременно.
  const [chatThreads, setChatThreads] = useState(3)

  // §6: порог trust для рассылки — настройка, а не константа: у спам-аккаунтов
  // trust низкий по определению, и жёсткий порог блокировал бы весь пул.
  const [minTrust, setMinTrust] = useState<number | null>(null)
  const [trustDraft, setTrustDraft] = useState('')
  const [savingTrust, setSavingTrust] = useState(false)
  useEffect(() => { void fetchGoals().then(setGoals).catch(() => {}) }, [])
  useEffect(() => {
    void fetchSettings().then((s) => { setMinTrust(s.mailingMinTrust); setTrustDraft(String(s.mailingMinTrust)) }).catch(() => {})
  }, [])

  /**
   * Цели рассылки: номер ИЛИ юзернейм. Правило то же, что на сервере
   * (`server/lib/mailing.js#classifyMailingTargets`) — если разойдутся, человек
   * увидит одно число, а уйдёт другое.
   */
  const targetsParsed = useMemo(() => {
    const lines = numbersText.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)
    const seen = new Set<string>()
    const phones: string[] = []
    const handles: string[] = []
    for (const raw of lines) {
      const h = raw.replace(/^https?:\/\//i, '').replace(/^(www\.)?t\.me\//i, '').replace(/^@/, '').replace(/\/+$/, '')
      if (/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(h)) {
        const k = `u:${h.toLowerCase()}`
        if (!seen.has(k)) { seen.add(k); handles.push(h) }
        continue
      }
      const d = raw.replace(/\D/g, '')
      if (d.length >= 7) {
        const k = `p:${d}`
        if (!seen.has(k)) { seen.add(k); phones.push(d) }
      }
    }
    return { phones, handles, all: [...phones, ...handles], total: lines.length }
  }, [numbersText])

  const numbers = targetsParsed.all


  // §11: рассылку/пост создаёт только один ответственный — админ (единый отправитель).
  const me = useSession((s) => s.user)
  const canWrite = !me || me.isAdmin
  // «Нет сессии» = дев/демо-админ — так же считает и сервер (isAdminRequest без заголовка).
  const isAdmin = !me || me.isAdmin
  const perAcc = selected.size ? Math.ceil(numbers.length / selected.size) : 0

  // Кто из выбранных не дотягивает до порога. trustScore приходит из кэша аккаунтов;
  // если его нет — считаем 0, то есть аккаунт ниже любого порога.
  const accounts = activeAccounts(useApp((s) => s.data))
  const belowTrust = useMemo(() => {
    if (minTrust == null) return []
    return accounts.filter((a) => selected.has(a.id) && (a.trustScore ?? 0) < minTrust)
  }, [accounts, selected, minTrust])
  const blockedByTrust = belowTrust.length > 0 && !isAdmin

  // Текст обязателен, только когда его больше неоткуда взять: нет цели (в ней лежит
  // первое сообщение) или человек сам выбрал писать своё.
  // Пересечение выбранных с «занятыми диалогом» — их надо убрать до запуска.
  const pickedHot = useMemo(() => [...selected].filter((id) => hotAccounts.includes(id)), [selected, hotAccounts])
  const needOwnText = !goalId || ownText

  /**
   * Сколько вариантов первого сообщения задано в описании выбранной цели.
   * Считаем так же, как сервер (`firstMessagesFromGoal`): важно, чтобы человек ДО запуска
   * видел, уйдёт ли вся рассылка одним текстом, — именно это ловит спамблок.
   */
  const openerCount = useMemo(() => {
    const desc = goals.find((g) => g.id === goalId)?.description || ''
    if (!desc.trim()) return 0
    // `\w` не покрывает кириллицу, поэтому «Альтернативн(ое)» ловим через \S*.
    const header = /(?:^|\n)[ \t]*(?:альтернативн\S*[ \t]+)?первое\s+сообщение\s*:?[ \t]*\n?/gi
    return desc.split(header)
      .slice(1)
      .filter((chunk) => chunk.split(/\n\s*\n/)[0].trim())
      .length
  }, [goals, goalId])
  const canLaunch = canWrite && !blockedByTrust && selected.size > 0 && numbers.length > 0
    && (!needOwnText || message.trim().length > 0) && pickedHot.length === 0 && !launching

  const applyTrust = async () => {
    const n = Number(trustDraft)
    if (!Number.isFinite(n)) return
    setSavingTrust(true)
    try {
      const s = await saveSettings({ mailingMinTrust: n })
      setMinTrust(s.mailingMinTrust); setTrustDraft(String(s.mailingMinTrust))
      pushToast({ type: 'success', title: 'Порог сохранён', desc: `Рассылка с trust ≥ ${s.mailingMinTrust}` })
    } catch (e) {
      pushToast({ type: 'error', title: 'Не сохранено', desc: e instanceof Error ? e.message : '' })
    } finally { setSavingTrust(false) }
  }

  async function launch() {
    // Ниже порога — запускаем только по осознанному подтверждению админа.
    // Сервер это тоже проверяет: флагу от клиента доверять нельзя.
    if (belowTrust.length) {
      const ok = await confirmDialog({
        title: `${belowTrust.length} аккаунтов ниже порога trust`,
        message: `Порог рассылки — ${minTrust}. У этих аккаунтов он ниже: ${belowTrust.slice(0, 5).map((a) => `${a.name} (${a.trustScore ?? 0})`).join(', ')}${belowTrust.length > 5 ? '…' : ''}.

Низкий trust — выше риск спамблока. Запустить всё равно?`,
        confirmLabel: 'Запустить',
        tone: 'danger',
      })
      if (!ok) return
    }
    setLaunching(true)
    try {
      await startModuleTask('mailing', {
        accountIds: [...selected],
        targets: numbers,
        threads: chatThreads,
        promptText: needOwnText ? message.trim() : '',
        maxPerAccount,
        delays: { dm: [delayMin, delayMax], action: [delayMin, delayMax] },
        protectionLevel: protLevel,
        delayPreset,
        ...(media.length ? { mediaUrls: media } : {}),
        aiPerRecipient: aiPerRecipient && !!goalId,
        ...(belowTrust.length ? { allowLowTrust: true } : {}),
        ...(goalId ? { goalId } : {}),
      })
      // Чатинг поднимаем ТОЙ ЖЕ целью и теми же аккаунтами — он слушает ответы на рассылку.
      if (goalId && withChat) {
        try {
          await startModuleTask('neuro-dialogs', {
            accountIds: [...selected],
            goalId,
            replyScope: 'unread',
            replyLimitMode: 'untilTarget',
            threads: chatThreads,
            delays: { dm: [delayMin, delayMax] },
          })
          pushToast({ type: 'success', title: 'Рассылка + чатинг запущены', desc: `${numbers.length} целей · одна цель на оба модуля` })
        } catch (e) {
          pushToast({ type: 'error', title: 'Рассылка пошла, чатинг — нет', desc: e instanceof Error ? e.message : '' })
        }
      } else {
        pushToast({ type: 'success', title: 'Рассылка создана', desc: `${numbers.length} целей · ${selected.size} аккаунтов` })
      }
      nav('/panel/tasks')
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось создать', desc: e instanceof Error ? e.message : '' })
    } finally { setLaunching(false) }
  }

  return (
    <div>
      <PageHeader
        title="Мейлинг"
        subtitle="Рассылка в Telegram по номерам и юзернеймам. Резолв цели → аккаунт → ЛС."
        icon={<Mail size={22} />}
        badge="live"
      />

      <Card className="mb-4 flex items-start gap-2 border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200/90">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <span>Отправка <b>реальная</b>. Массовая рассылка незнакомым — высокий риск спам-блока <b>ваших аккаунтов</b> и нарушение ToS Telegram. Предохранители: рассылают только аккаунты с trust&gt;70, действует суточный лимит ЛС (20–30/аккаунт) и паузы 90–300с; номера не из Telegram пропускаются. Держите лимиты низкими.</span>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card className="p-4">
            <div className="mb-2 text-sm font-semibold text-fg">Аккаунты-отправители</div>
            <AccountPicker selected={selected} onChange={setSelected} selectedTitle="Выбрано для рассылки" />
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-4">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xs text-white/50">
                Кому пишем — введено {targetsParsed.total}, уйдёт {numbers.length}
                {' '}<span className="text-white/35">
                  (номеров {targetsParsed.phones.length}, юзернеймов {targetsParsed.handles.length}
                  {targetsParsed.total > numbers.length ? ` · отброшено ${targetsParsed.total - numbers.length}` : ''})
                </span>
              </span>
              {/* Дубли и так схлопывались при разборе, но молча — человек видел «валидных
                  8500» вместо введённых 10000 и не понимал, куда делись полторы тысячи. */}
              <DedupeButton value={numbersText} onChange={setNumbersText} mode="auto" className="btn-soft ml-auto h-7 px-2 text-xs disabled:opacity-40" />
            </div>
            <textarea className="input min-h-[110px] font-mono text-sm" value={numbersText} onChange={(e) => setNumbersText(e.target.value)} placeholder={'+380671234567\n@username\nhttps://t.me/username'} />
          </Card>

          <Card className="p-4">
            {goalId && (
              <label className="mb-2 flex cursor-pointer items-start gap-2">
                <input type="checkbox" checked={ownText} onChange={(e) => setOwnText(e.target.checked)} className="mt-0.5 h-4 w-4 accent-spark" />
                <span>
                  <span className="text-xs font-semibold text-fg">Свой текст сообщения</span>
                  <span className="mt-0.5 block text-[11px] text-white/45">
                    По умолчанию берётся из цели («Первое сообщение» в её описании). Включите, только если
                    для этой рассылки нужен другой текст.
                  </span>
                </span>
              </label>
            )}
            {needOwnText
              ? <MessageComposer value={message} onChange={setMessage} media={media} onMedia={setMedia} minHeight={90} />
              : <div className="rounded-xl border border-line bg-elevated/40 p-3 text-xs text-white/45">
                  Текст возьмётся из цели «{goals.find((g) => g.id === goalId)?.name || ''}» — «Первое сообщение» в её описании.
                  {openerCount > 1
                    ? <span className="ml-1 text-spark-300">Вариантов: {openerCount} — чередуются между получателями.</span>
                    : <span className="ml-1 text-amber-300">
                        Вариант один: все получат одинаковый текст. Добавьте в описание цели блок
                        «Альтернативное первое сообщение:» — одинаковая рассылка ловит спамблок быстрее.
                      </span>}
                </div>}
            {goals.length > 0 && (
              <div className="mt-2">
                <div className="mb-1 text-xs text-white/50">Цель (опционально — генерация к цели)</div>
                <Select value={goalId} onChange={setGoalId} options={[{ value: '', label: 'Без цели' }, ...goals.map((g) => ({ value: g.id, label: g.name }))]} />
                {goalId && (
                  <label className="mt-2 flex items-center gap-2 text-xs text-white/60">
                    <input type="checkbox" checked={aiPerRecipient} onChange={(e) => setAiPerRecipient(e.target.checked)} className="h-4 w-4 rounded border-line accent-spark-500" />
                    ИИ-генерация текста к цели (вместо шаблона)
                  </label>
                )}
                {/* §9: цель ведёт весь процесс — отправили и слушаем ответы под ней же. */}
                {goalId && (
                  <div className="mt-2 rounded-xl border border-spark-500/25 bg-spark-500/5 p-2.5">
                    <label className="flex cursor-pointer items-start gap-2">
                      <input type="checkbox" checked={withChat} onChange={(e) => setWithChat(e.target.checked)} className="mt-0.5 h-4 w-4 accent-spark" />
                      <span>
                        <span className="text-xs font-semibold text-spark-200">Включить нейрочатинг под этой целью</span>
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-white/50">
                          Всё берётся из цели: текст первого сообщения, этапы, ссылка и целевое действие —
                          настраивать отдельно ничего не нужно. Рассылка приводит людей, чатинг ловит ответы
                          и ведёт их по этапам цели, статусы в CRM едут сами. Запустится второй задачей на тех же аккаунтах.
                        </span>
                      </span>
                    </label>
                    {withChat && (
                      <>
                        <div className="mt-2 flex items-center gap-2">
                          <span className="text-[11px] text-white/50">Потоков</span>
                          <input
                            type="number" min={1} max={20}
                            className="input h-8 w-16 text-xs"
                            value={chatThreads}
                            onChange={(e) => setChatThreads(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                          />
                          <span className="text-[11px] text-white/35">
                            аккаунты делятся между потоками — и рассылка, и ответы идут одновременно; 1 — по очереди
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="mb-2 text-sm font-semibold text-fg">Безопасность</div>
            {/* §11: паритет с masslooking/warming — уровень защиты и пресет задержек (множители пауз). */}
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-xs text-white/50">Уровень защиты</div>
                <Segmented options={['Консерв.', 'Сбаланс.', 'Агресс.']} value={protLevel} onChange={setProtLevel} size="sm" />
              </div>
              <div>
                <div className="mb-1 text-xs text-white/50">Пресет задержек</div>
                <Segmented options={['Мин', 'Реком.', 'Макс']} value={delayPreset} onChange={setDelayPreset} size="sm" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <label className="text-xs text-white/50">Лимит на аккаунт
                <input type="number" min={1} value={maxPerAccount} onChange={(e) => setMaxPerAccount(Math.max(1, Number(e.target.value) || 1))} className="input mt-1 h-9" />
              </label>
              <label className="text-xs text-white/50">Задержка от (с)
                <input type="number" min={1} value={delayMin} onChange={(e) => setDelayMin(Math.max(1, Number(e.target.value) || 1))} className="input mt-1 h-9" />
              </label>
              <label className="text-xs text-white/50">до (с)
                <input type="number" min={delayMin} value={delayMax} onChange={(e) => setDelayMax(Math.max(delayMin, Number(e.target.value) || delayMin))} className="input mt-1 h-9" />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/50">
              <span>Номеров: <b className="text-white">{numbers.length}</b></span>
              <span>Аккаунтов: <b className="text-white">{selected.size}</b></span>
              <span>≈ на аккаунт: <b className="text-white">{perAcc}</b></span>
            </div>
            {!canWrite && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                Рассылку создаёт только администратор (единый отправитель). У вас нет прав на отправку.
              </div>
            )}

            {/* §6: порог trust. Админу — предупреждение и право запустить всё равно,
                остальным — запрет. Сам порог правится тут же, но только админом. */}
            {minTrust != null && belowTrust.length > 0 && (
              <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${isAdmin ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : 'border-rose-500/30 bg-rose-500/10 text-rose-200'}`}>
                <div className="flex items-start gap-2">
                  <ShieldAlert size={14} className="mt-0.5 shrink-0" />
                  <div>
                    <b>{belowTrust.length}</b> из выбранных аккаунтов ниже порога trust <b>{minTrust}</b>:{' '}
                    {belowTrust.slice(0, 4).map((a) => `${a.name} (${a.trustScore ?? 0})`).join(', ')}{belowTrust.length > 4 ? '…' : ''}
                    <div className="mt-1 opacity-80">
                      {isAdmin
                        ? 'Низкий trust — выше риск спамблока. Запустить можно, но подтвердите: это попадёт в лог задачи.'
                        : 'Запуск заблокирован. Снять ограничение или изменить порог может только администратор.'}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {isAdmin && minTrust != null && (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-elevated/40 px-3 py-2">
                <span className="text-xs text-white/50">Порог trust для рассылки</span>
                <input
                  type="number" min={0} max={100}
                  className="input h-8 w-20 text-xs"
                  value={trustDraft}
                  onChange={(e) => setTrustDraft(e.target.value)}
                />
                <button
                  onClick={() => void applyTrust()}
                  disabled={savingTrust || trustDraft === String(minTrust)}
                  className="btn-ghost h-8 px-3 text-xs disabled:opacity-40"
                >
                  {savingTrust ? 'Сохраняю…' : 'Сохранить'}
                </button>
                <span className="text-xs text-white/30">действует для всех ролей</span>
              </div>
            )}
            {pickedHot.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                <div className="flex items-start gap-2">
                  <ShieldAlert size={14} className="mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <b>{pickedHot.length}</b> из выбранных ведут горячий лид — у них диалог в разгаре,
                    забирать их в рассылку нельзя:{' '}
                    {pickedHot.slice(0, 5).map((id) => accounts.find((a) => a.id === id)?.name || id.slice(-6)).join(', ')}
                    {pickedHot.length > 5 ? ' и др.' : ''}
                    <button
                      onClick={() => setSelected((prev) => new Set([...prev].filter((id) => !hotAccounts.includes(id))))}
                      className="btn-soft ml-2 h-7 px-2 text-xs"
                    >
                      Исключить их
                    </button>
                  </div>
                </div>
              </div>
            )}
            <button onClick={() => void launch()} disabled={!canLaunch} className="btn-primary mt-3 h-10 w-full disabled:opacity-40">
              <Send size={16} /> {launching ? 'Запуск…' : 'Начать'}
            </button>
          </Card>
        </div>
      </div>
    </div>
  )
}
