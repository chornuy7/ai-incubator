import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Megaphone, Send, Info, CalendarClock, Pencil, Trash2, Play, X } from 'lucide-react'
import { PageHeader, Card, NumberField } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import { AccountPicker } from '@/features/account-picker/AccountPicker'
import { MessageComposer } from '@/features/composer/MessageComposer'
import { useSession } from '@/features/auth/session'
import { startModuleTask } from '@/api/modulesApi'
import { confirmDialog } from '@/shared/lib/dialog'
import {
  fetchAutomationRules, createAutomationRule, updateAutomationRule, deleteAutomationRule, runAutomationRuleNow,
  type AutomationRule, type AutomationSchedule,
} from '@/api/automationApi'
import { usePlan, planHasModule } from '@/features/billing/plan'
import { ModuleNotPaid } from '@/features/billing/ModuleNotPaid'

/** Локальная дата-время в формат `datetime-local` (без сдвига в UTC, как делает toISOString). */
function toLocalInput(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Человекочитаемое расписание для карточки запланированного поста. */
function scheduleLabel(s: AutomationSchedule): string {
  if (s.type === 'once') return s.at ? `Один раз · ${new Date(s.at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}` : 'Один раз · время не задано'
  if (s.type === 'daily') return `Каждый день в ${s.time || '12:00'}`
  return `Каждые ${s.intervalMinutes || 60} мин`
}

export function AutopostingPage() {
  // §5.4: модуль живёт не под /panel/modules/*, поэтому гейт подписки — здесь же.
  const planModules = usePlan((st) => st.modules)
  if (!planHasModule(planModules, 'autoposting')) return <ModuleNotPaid title="Автопостинг" />

  const nav = useNavigate()
  const pushToast = useApp((s) => s.pushToast)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [channelsText, setChannelsText] = useState('')
  const [text, setText] = useState('')
  const [media, setMedia] = useState<string[]>([])
  const [delayMin, setDelayMin] = useState(60)
  const [delayMax, setDelayMax] = useState(180)
  const [launching, setLaunching] = useState(false)

  // §11: пост можно опубликовать сразу или запланировать. Планирование не плодит второй
  // планировщик — это правило автоматизации с moduleKey='autoposting' (§6), поэтому
  // запланированные посты живут в общем списке автоматизаций и переживают рестарт.
  const [mode, setMode] = useState<'now' | 'schedule'>('now')
  const [schedType, setSchedType] = useState<AutomationSchedule['type']>('once')
  const [schedAt, setSchedAt] = useState(() => toLocalInput(Date.now() + 60 * 60_000))
  const [schedTime, setSchedTime] = useState('12:00')
  const [schedInterval, setSchedInterval] = useState(1440)
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)

  const [rules, setRules] = useState<AutomationRule[]>([])
  const [loadingRules, setLoadingRules] = useState(true)
  const [showSpent, setShowSpent] = useState(false)

  // «Отработавшее» = разовое правило, которое уже выключилось после запуска. Оно ничего
  // больше не сделает, но занимало место наравне с живыми (баг 10.5-b).
  const spentRules = useMemo(() => rules.filter((r) => !r.enabled && r.schedule?.type === 'once'), [rules])
  const activeRules = useMemo(() => rules.filter((r) => !spentRules.includes(r)), [rules, spentRules])
  const visibleRules = showSpent ? [...activeRules, ...spentRules] : activeRules

  const channels = useMemo(() => {
    const raw = channelsText.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)
    return [...new Set(raw)]
  }, [channelsText])

  // §11: публикацию создаёт только админ (единый отправитель).
  const me = useSession((s) => s.user)
  const canWrite = !me || me.isAdmin
  const ready = selected.size > 0 && channels.length > 0 && text.trim().length > 0
  const canLaunch = canWrite && ready && !launching

  const loadRules = async () => {
    setLoadingRules(true)
    try { setRules((await fetchAutomationRules()).filter((r) => r.moduleKey === 'autoposting')) }
    catch { /* список необязателен для публикации — молча оставляем пустым */ }
    finally { setLoadingRules(false) }
  }
  useEffect(() => { void loadRules() }, [])

  const buildSchedule = (): AutomationSchedule => {
    if (schedType === 'once') return { type: 'once', at: new Date(schedAt).getTime() }
    if (schedType === 'daily') return { type: 'daily', time: schedTime }
    return { type: 'interval', intervalMinutes: schedInterval }
  }

  const settings = () => ({
    accountIds: [...selected],
    targets: channels,
    promptText: text.trim(),
    delays: { action: [delayMin, delayMax] as [number, number] },
    ...(media.length ? { mediaUrls: media } : {}),
  })

  const resetForm = () => {
    setEditingId(null)
    setName('')
    setChannelsText('')
    setText('')
    setMedia([])
    setSelected(new Set())
    setMode('now')
  }

  /** Загрузить запланированный пост в форму — редактируем и аккаунты-«боты», и каналы, и текст. */
  const editRule = (r: AutomationRule) => {
    setEditingId(r.id)
    setName(r.name)
    setSelected(new Set(r.accountIds || []))
    setChannelsText((r.settings?.targets || []).join('\n'))
    setText(String(r.settings?.promptText || ''))
    setMedia(Array.isArray(r.settings?.mediaUrls) ? r.settings.mediaUrls : [])
    const d = r.settings?.delays?.action
    if (Array.isArray(d)) { setDelayMin(d[0] ?? 60); setDelayMax(d[1] ?? 180) }
    setMode('schedule')
    setSchedType(r.schedule?.type || 'once')
    if (r.schedule?.type === 'once' && r.schedule.at) setSchedAt(toLocalInput(r.schedule.at))
    if (r.schedule?.type === 'daily') setSchedTime(r.schedule.time || '12:00')
    if (r.schedule?.type === 'interval') setSchedInterval(r.schedule.intervalMinutes || 1440)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const removeRule = async (r: AutomationRule) => {
    const ok = await confirmDialog({
      title: 'Удалить запланированный пост',
      message: `Пост «${r.name}» больше не опубликуется. Уже опубликованные посты останутся в каналах.`,
    })
    if (!ok) return
    try {
      await deleteAutomationRule(r.id)
      if (editingId === r.id) resetForm()
      await loadRules()
      pushToast({ type: 'success', title: 'Запланированный пост удалён' })
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось удалить', desc: e instanceof Error ? e.message : '' })
    }
  }

  const publishRuleNow = async (r: AutomationRule) => {
    try {
      await runAutomationRuleNow(r.id)
      pushToast({ type: 'success', title: 'Публикация запущена', desc: r.name })
      nav('/panel/tasks')
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось опубликовать', desc: e instanceof Error ? e.message : '' })
    }
  }

  async function launch() {
    setLaunching(true)
    try {
      if (mode === 'now') {
        await startModuleTask('autoposting', settings())
        pushToast({ type: 'success', title: 'Автопостинг создан', desc: `${channels.length} каналов · ${selected.size} аккаунтов` })
        nav('/panel/tasks')
        return
      }
      const payload = {
        // Автоимя должно РАЗЛИЧАТЬ посты: раньше все безымянные звались «Пост в N канал(ов)»,
        // и в списке висели одинаковые карточки, а диалог удаления подставлял то же неуникальное
        // имя — для необратимого действия непонятно, что именно стираешь (баг 10.5-a).
        name: name.trim() || `${text.trim().slice(0, 40) || 'Пост'} → ${channels[0] ?? '—'}${channels.length > 1 ? ` +${channels.length - 1}` : ''}`,
        moduleKey: 'autoposting',
        campaignId: null,
        accountIds: [...selected],
        settings: settings(),
        schedule: buildSchedule(),
      }
      if (editingId) {
        await updateAutomationRule(editingId, payload)
        pushToast({ type: 'success', title: 'Запланированный пост обновлён' })
      } else {
        await createAutomationRule(payload)
        pushToast({ type: 'success', title: 'Пост запланирован', desc: scheduleLabel(buildSchedule()) })
      }
      resetForm()
      await loadRules()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось сохранить', desc: e instanceof Error ? e.message : '' })
    } finally { setLaunching(false) }
  }

  const seg = (active: boolean) =>
    `flex-1 rounded-lg px-3 py-1.5 text-sm font-semibold transition-all ${active ? 'bg-spark-gradient text-[#04150c]' : 'text-muted hover:text-fg'}`

  return (
    <div>
      <PageHeader
        title="Автопостинг"
        subtitle="Публикация постов в СВОИ каналы/группы. Безопасно — не спам."
        icon={<Megaphone size={22} />}
      />

      <Card className="mb-4 flex items-start gap-2 border-iris-500/30 bg-iris-500/5 p-3 text-sm text-iris-200/90">
        <Info size={16} className="mt-0.5 shrink-0" />
        <span>Аккаунт-отправитель должен быть <b>админом</b> канала с правом публикации. Постим только в свои каналы — риска бана нет.</span>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-2 text-sm font-semibold text-fg">Аккаунты (админы каналов)</div>
          <AccountPicker selected={selected} onChange={setSelected} selectedTitle="Выбрано для постинга" />
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <div className="mb-1 text-xs text-white/50">Каналы/группы ({channels.length}) — свои, где аккаунт админ</div>
            <textarea className="input min-h-[80px] font-mono text-sm" value={channelsText} onChange={(e) => setChannelsText(e.target.value)} placeholder={'@my_channel\nhttps://t.me/my_group'} />
          </Card>

          <Card className="p-4">
            <MessageComposer value={text} onChange={setText} media={media} onMedia={setMedia} label="Текст поста" placeholder="Текст, который опубликуется в каналах…" />
          </Card>

          <Card className="p-4">
            <div className="mb-2 text-sm font-semibold text-fg">Когда публиковать</div>
            <div className="mb-3 flex gap-1 rounded-xl bg-elevated p-1">
              <button onClick={() => setMode('now')} className={seg(mode === 'now')}>Сейчас</button>
              <button onClick={() => setMode('schedule')} className={seg(mode === 'schedule')}>По расписанию</button>
            </div>

            {mode === 'schedule' && (
              <div className="mb-3 space-y-3 rounded-xl border border-line bg-elevated/40 p-3">
                <label className="block text-xs text-white/50">Название поста (чтобы найти его в списке)
                  <input value={name} onChange={(e) => setName(e.target.value)} className="input mt-1 h-9" placeholder="Утренний пост" />
                </label>
                <div className="flex gap-1 rounded-lg bg-elevated p-1">
                  <button onClick={() => setSchedType('once')} className={seg(schedType === 'once')}>Один раз</button>
                  <button onClick={() => setSchedType('daily')} className={seg(schedType === 'daily')}>Ежедневно</button>
                  <button onClick={() => setSchedType('interval')} className={seg(schedType === 'interval')}>Каждые N мин</button>
                </div>
                {schedType === 'once' && (
                  <label className="block text-xs text-white/50">Дата и время публикации
                    <input type="datetime-local" value={schedAt} onChange={(e) => setSchedAt(e.target.value)} className="input mt-1 h-9" />
                    {/* §8.4: поле рисуется браузером и в локали en-US показывает AM/PM, тогда как весь
                        интерфейс и карточки расписаний — 24-часовые. На прогоне 21–22.07 (баг 10.3-a)
                        это дало промах ровно на час: «11:09 PM» вместо 22:09. Подписываем, что реально
                        сохранится, — сверить введённое с показанным иначе негде. */}
                    {schedAt && !Number.isNaN(new Date(schedAt).getTime()) && (
                      <span className="mt-1 block text-[11px] text-iris-300">
                        Опубликуется: {new Date(schedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
                      </span>
                    )}
                  </label>
                )}
                {schedType === 'daily' && (
                  <label className="block text-xs text-white/50">Время публикации
                    <input type="time" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} className="input mt-1 h-9" />
                  </label>
                )}
                {schedType === 'interval' && (
                  <label className="block text-xs text-white/50">Интервал, минут
                    <NumberField value={schedInterval} onChange={setSchedInterval} min={1} />
                  </label>
                )}
              </div>
            )}

            <div className="mb-2 text-sm font-semibold text-fg">Темп</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-white/50">Задержка от (с)
                <NumberField value={delayMin} onChange={setDelayMin} min={1} />
              </label>
              {/* Клемп по blur, а не на каждый keystroke: иначе «до» с минимумом из соседнего поля не набирается (10.1-b). */}
              <label className="text-xs text-white/50">до (с)
                <NumberField value={delayMax} onChange={setDelayMax} min={delayMin} />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/50">
              <span>Каналов: <b className="text-white">{channels.length}</b></span>
              <span>Аккаунтов: <b className="text-white">{selected.size}</b></span>
            </div>
            {!canWrite && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                Публикацию создаёт только администратор (единый отправитель). У вас нет прав на отправку.
              </div>
            )}
            <div className="mt-3 flex gap-2">
              <button onClick={() => void launch()} disabled={!canLaunch} className="btn-primary h-10 flex-1 disabled:opacity-40">
                {mode === 'schedule' ? <CalendarClock size={16} /> : <Send size={16} />}
                {launching ? 'Сохранение…' : mode === 'now' ? 'Опубликовать' : editingId ? 'Сохранить изменения' : 'Запланировать'}
              </button>
              {editingId && (
                <button onClick={resetForm} className="btn-ghost h-10" title="Отменить редактирование"><X size={16} /> Отмена</button>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* §11: запланированные посты — их можно отредактировать (аккаунты, каналы, текст, время),
          опубликовать досрочно или удалить. Это те же правила автоматизации, вид со стороны постинга. */}
      <Card className="mt-4 p-4">
        <div className="mb-3 flex items-center gap-2">
          <CalendarClock size={16} className="text-spark-400" />
          <span className="font-display text-base font-bold text-fg">Запланированные посты</span>
          <span className="rounded-md bg-spark-500/12 px-2 py-0.5 text-xs font-bold text-spark-300">{activeRules.length}</span>
          {/* Разовое правило после срабатывания навсегда остаётся в списке со статусом «выключен».
              За месяц ежедневной работы список превращается в свалку мёртвых записей, среди которых
              надо выискивать живые (баг 10.5-b). Прячем их за переключатель. */}
          {spentRules.length > 0 && (
            <button
              type="button"
              onClick={() => setShowSpent((v) => !v)}
              className="ml-auto text-xs font-semibold text-muted hover:text-fg"
            >
              {showSpent ? 'Скрыть отработавшие' : `Показать отработавшие (${spentRules.length})`}
            </button>
          )}
        </div>
        {loadingRules ? (
          <p className="text-sm text-muted">Загрузка…</p>
        ) : visibleRules.length === 0 ? (
          <p className="text-sm text-muted">Пока ничего не запланировано. Выберите «По расписанию» выше — пост появится здесь и опубликуется сам.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleRules.map((r) => (
              <div key={r.id} className={`flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 ${editingId === r.id ? 'border-spark-500/50 bg-spark-500/8' : 'border-line bg-elevated/50'}`}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-fg">{r.name}</div>
                  <div className="text-xs text-muted">
                    {scheduleLabel(r.schedule)} · {(r.settings?.targets || []).length} канал(ов) · {(r.accountIds || []).length} аккаунт(ов)
                    {r.nextRun ? ` · следующий ${new Date(r.nextRun).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}` : ''}
                    {r.enabled ? '' : ' · выключен'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button onClick={() => void publishRuleNow(r)} className="btn-ghost h-8 px-2 text-xs" title="Опубликовать сейчас, не дожидаясь расписания"><Play size={14} /></button>
                  <button onClick={() => editRule(r)} className="btn-ghost h-8 px-2 text-xs" title="Редактировать пост: аккаунты, каналы, текст, время"><Pencil size={14} /></button>
                  <button onClick={() => void removeRule(r)} className="btn-ghost h-8 px-2 text-xs text-rose-300 hover:bg-rose-500/10" title="Удалить запланированный пост"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
