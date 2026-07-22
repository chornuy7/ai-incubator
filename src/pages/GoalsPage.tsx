import { useEffect, useState } from 'react'
import { Target, Plus, Pencil, Trash2, BookOpen, Hash, X, ArrowLeft, Copy } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Badge } from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { confirmDialog } from '@/shared/lib/dialog'
import { FolderPicker } from '@/features/modules/shared'
import {
  fetchGoals, createGoal, updateGoal, deleteGoal, isGoalExpired, isSaneDeadline,
  DEADLINE_MIN_YEAR, DEADLINE_MAX_YEAR, LEAD_TARGET_MAX, FOLLOW_UP_MAX, FOLLOW_UP_DEFAULT,
  type Goal, type GoalInput, type FollowUp,
  fetchKb, createKb, deleteKb, uploadKbFile, kbFileUrl, type KbItem,
} from '@/api/goalsApi'
import { fetchLeads } from '@/api/leadsApi'
import { fetchCampaigns, type Campaign } from '@/api/campaignsApi'

const EMPTY: GoalInput = { name: '', description: '', targetAction: '', stages: [], completionCriteria: '', audience: '', channels: [], deadline: '', leadTarget: 0, followUp: { enabled: false, limit: FOLLOW_UP_DEFAULT, instructions: '' }, toneOfVoice: '', restrictions: '' }

export function GoalsPage() {
  const pushToast = useApp((s) => s.pushToast)
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Goal | null>(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<GoalInput>(EMPTY)
  const [stagesText, setStagesText] = useState('')
  const [channels, setChannels] = useState<string[]>([])
  const [chInput, setChInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [kb, setKb] = useState<KbItem[]>([])
  const [kbTitle, setKbTitle] = useState('')
  const [kbContent, setKbContent] = useState('')
  const [kbUploading, setKbUploading] = useState(false) // §4: загрузка файла в КБ
  const [leadsByGoal, setLeadsByGoal] = useState<Record<string, number>>({}) // §4: сколько лидов у цели
  const [campaignsByGoal, setCampaignsByGoal] = useState<Record<string, Campaign[]>>({}) // §4: цель оркестрирует кампании

  const load = async () => {
    setLoading(true)
    try {
      setGoals(await fetchGoals())
      // §4: считаем лидов по каждой цели для прогресса к «цели по лидам».
      void fetchLeads().then((leads) => {
        const by: Record<string, number> = {}
        for (const l of leads) if (l.goalId) by[l.goalId] = (by[l.goalId] || 0) + 1
        setLeadsByGoal(by)
      }).catch(() => {})
      // §4: цель оркестрирует кампании — показываем их под целью.
      void fetchCampaigns().then(({ campaigns }) => {
        const by: Record<string, Campaign[]> = {}
        for (const c of campaigns) if (c.goalId) (by[c.goalId] ||= []).push(c)
        setCampaignsByGoal(by)
      }).catch(() => {})
    } catch (err) {
      pushToast({ type: 'error', title: 'Не удалось загрузить цели', desc: err instanceof Error ? err.message : '' })
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const openNew = () => {
    setEditing(null); setForm(EMPTY); setStagesText(''); setChannels([]); setChInput(''); setKb([]); setOpen(true)
  }
  const openEdit = (g: Goal) => {
    setEditing(g)
    setForm({ name: g.name, description: g.description, targetAction: g.targetAction, completionCriteria: g.completionCriteria, audience: g.audience, deadline: g.deadline || '', leadTarget: g.leadTarget || 0, followUp: g.followUp || { enabled: false, limit: FOLLOW_UP_DEFAULT, instructions: '' }, toneOfVoice: g.toneOfVoice || '', restrictions: g.restrictions || '' })
    setStagesText((g.stages || []).join('\n'))
    setChannels(g.channels || []); setChInput('')
    setKb([]); setKbTitle(''); setKbContent('')
    void fetchKb(g.id).then(setKb).catch(() => {})
    setOpen(true)
  }

  const addChannels = () => {
    const parsed = chInput.split(/[\n,\s]+/).map((s) => s.trim().replace(/^@/, '').replace(/https?:\/\/t\.me\//i, '').split('/')[0]).filter(Boolean)
    if (!parsed.length) return
    setChannels((prev) => [...new Set([...parsed, ...prev])])
    setChInput('')
  }

  const addKb = async () => {
    if (!editing || !kbContent.trim()) return
    try {
      await createKb(editing.id, { title: kbTitle.trim(), content: kbContent.trim() })
      setKbTitle(''); setKbContent('')
      setKb(await fetchKb(editing.id))
    } catch (err) {
      pushToast({ type: 'error', title: 'Ошибка базы знаний', desc: err instanceof Error ? err.message : '' })
    }
  }
  // §4: база знаний с файлами — грузим и сразу обновляем список.
  const addKbFile = async (file: File | undefined) => {
    if (!editing || !file) return
    setKbUploading(true)
    try {
      await uploadKbFile(editing.id, file)
      setKb(await fetchKb(editing.id))
      pushToast({ type: 'success', title: 'Файл добавлен в базу знаний', desc: file.name })
    } catch (err) {
      pushToast({ type: 'error', title: 'Файл не загружен', desc: err instanceof Error ? err.message : '' })
    } finally { setKbUploading(false) }
  }

  const removeKb = async (item: KbItem) => {
    if (!editing) return
    if (!window.confirm('Удалить элемент базы знаний? Действие необратимо.')) return
    try {
      await deleteKb(editing.id, item.id)
      setKb(await fetchKb(editing.id))
    } catch (err) {
      pushToast({ type: 'error', title: 'Ошибка удаления', desc: err instanceof Error ? err.message : '' })
    }
  }

  const save = async () => {
    if (!form.name.trim()) return pushToast({ type: 'error', title: 'Укажите название цели' })
    setSaving(true)
    const payload: GoalInput = { ...form, stages: stagesText.split('\n').map((s) => s.trim()).filter(Boolean), channels }
    try {
      if (editing) {
        await updateGoal(editing.id, payload)
        pushToast({ type: 'success', title: 'Цель обновлена', desc: form.name })
      } else {
        await createGoal(payload)
        pushToast({ type: 'success', title: 'Цель создана', desc: form.name })
      }
      setOpen(false)
      await load()
    } catch (err) {
      pushToast({ type: 'error', title: 'Ошибка сохранения', desc: err instanceof Error ? err.message : '' })
    } finally {
      setSaving(false)
    }
  }

  /**
   * Копия цели со всей начинкой. Цели у нас объёмные — этапы, критерий, тон,
   * ограничения, дожим, — и под каждую новую кампанию их переписывали руками.
   * База знаний не копируется: она привязана к своей цели и обычно другая.
   */
  const duplicate = async (g: Goal) => {
    try {
      const copy = await createGoal({
        name: `${g.name} — копия`,
        description: g.description,
        targetAction: g.targetAction,
        stages: g.stages,
        completionCriteria: g.completionCriteria,
        audience: g.audience,
        channels: g.channels,
        // Дедлайн и цель по лидам НЕ копируем: это план конкретной кампании,
        // у копии он свой. Чужой дедлайн мог бы сразу оказаться просроченным.
        followUp: g.followUp,
        toneOfVoice: g.toneOfVoice,
        restrictions: g.restrictions,
      })
      pushToast({ type: 'success', title: 'Цель скопирована', desc: copy.name })
      await load()
      openEdit(copy)
    } catch (err) {
      pushToast({ type: 'error', title: 'Не удалось скопировать', desc: err instanceof Error ? err.message : '' })
    }
  }

  const remove = async (g: Goal) => {
    if (!(await confirmDialog({ title: 'Удалить цель?', message: `«${g.name}» будет удалена.`, confirmLabel: 'Удалить', tone: 'danger' }))) return
    try {
      await deleteGoal(g.id)
      pushToast({ type: 'success', title: 'Цель удалена', desc: g.name })
      await load()
    } catch (err) {
      pushToast({ type: 'error', title: 'Ошибка удаления', desc: err instanceof Error ? err.message : '' })
    }
  }

  const set = (patch: Partial<GoalInput>) => setForm((f) => ({ ...f, ...patch }))

  return (
    <div>
      {!open && (<>
      <PageHeader
        title="Цели"
        subtitle="Цель кампании: целевое действие, этапы и критерий завершения. AI-модули работают к выбранной цели."
        icon={<Target size={22} />}
        actions={<div className="flex items-center gap-2"><HelpButton topic="goals" className="h-10 w-10" /><button onClick={openNew} className="btn-primary h-10"><Plus size={16} /> Новая цель</button></div>}
      />

      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : goals.length === 0 ? (
        <EmptyState
          icon={<Target size={26} />}
          title="Целей пока нет"
          desc="Создайте цель кампании — к ней привяжутся задачи и база знаний."
          action={<button onClick={openNew} className="btn-primary h-10"><Plus size={16} /> Создать цель</button>}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {goals.map((g) => (
            <Card key={g.id} className="flex flex-col gap-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-white">{g.name}</div>
                  {g.targetAction && <div className="mt-0.5 text-xs text-spark-300">Действие: {g.targetAction}</div>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => openEdit(g)} className="btn-icon h-8 w-8" aria-label="Изменить"><Pencil size={14} /></button>
                  <button onClick={() => void duplicate(g)} className="btn-icon h-8 w-8" aria-label="Дублировать цель" title="Дублировать цель"><Copy size={14} /></button>
                  <button onClick={() => remove(g)} className="btn-icon-danger h-8 w-8" aria-label="Удалить цель" title="Удалить цель"><Trash2 size={14} /></button>
                </div>
              </div>
              {g.description && <div className="text-sm text-white/60">{g.description}</div>}
              {g.stages?.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {g.stages.map((s, i) => <Badge key={i} tone="iris">{i + 1}. {s}</Badge>)}
                </div>
              )}

              {g.followUp?.enabled && (
                <Badge tone="iris">
                  Дожим до {g.followUp.limit} сообщ.
                </Badge>
              )}

              {/* §4: дедлайн + прогресс по лидам */}
              {(g.deadline || g.leadTarget > 0) && (
                <div className="flex flex-wrap items-center gap-2">
                  {g.deadline && (
                    <Badge tone={isGoalExpired(g) ? 'rose' : 'amber'}>
                      {isGoalExpired(g) ? '⏱ Дедлайн истёк' : `⏱ до ${new Date(g.deadline).toLocaleDateString('ru-RU')}`}
                    </Badge>
                  )}
                  {g.leadTarget > 0 && (() => {
                    const have = leadsByGoal[g.id] || 0
                    const done = have >= g.leadTarget
                    return (
                      <span className="inline-flex min-w-[140px] flex-col gap-0.5">
                        <span className="flex items-center justify-between text-[11px] text-white/50">
                          <span>Лиды к цели</span><span className={done ? 'text-spark-300' : 'text-white/70'}>{have}/{g.leadTarget}</span>
                        </span>
                        <span className="h-1.5 overflow-hidden rounded-full bg-line">
                          <span className="block h-full rounded-full bg-spark-500 transition-all" style={{ width: `${Math.min(100, Math.round((have / g.leadTarget) * 100))}%` }} />
                        </span>
                      </span>
                    )
                  })()}
                </div>
              )}

              {/* §4: кампании под этой целью — цель их оркестрирует */}
              {(campaignsByGoal[g.id]?.length ?? 0) > 0 && (
                <div className="rounded-lg border border-line bg-elevated/40 p-2">
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Кампании цели ({campaignsByGoal[g.id].length})</div>
                  <div className="flex flex-wrap gap-1.5">
                    {campaignsByGoal[g.id].map((c) => (
                      <a key={c.id} href="/panel/campaign" title={`${c.moduleKey} · ${c.accountIds.length} акк.`}
                        className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-0.5 text-xs text-fg hover:border-spark-500/40">
                        <span className={`h-1.5 w-1.5 rounded-full ${c.status === 'active' ? 'bg-spark-400' : c.status === 'paused' ? 'bg-amber-400' : c.status === 'done' ? 'bg-faint' : 'bg-iris-400'}`} />
                        {c.name}
                      </a>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/40">
                {(g.channels?.length ?? 0) > 0 && <span className="text-spark-300"><Hash size={11} className="mb-0.5 inline" /> {g.channels.length} каналов/групп</span>}
                {g.completionCriteria && <span>Критерий: {g.completionCriteria}</span>}
                {g.audience && <span>Аудитория: {g.audience}</span>}
              </div>
            </Card>
          ))}
        </div>
      )}
      </>)}

      {/* §4: создание/редактирование цели — полноэкранная вьюшка, а не модалка. */}
      {open && (
      <div>
        <button onClick={() => setOpen(false)} className="btn-ghost mb-3 h-9"><ArrowLeft size={15} /> Назад к целям</button>
        <PageHeader
          title={editing ? 'Изменить цель' : 'Новая цель'}
          subtitle="AI будет вести кампанию к этой цели"
          icon={<Target size={22} />}
        />
        <Card className="p-4">
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-white/50">Название *</label>
            <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Продажа курса" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-white/50">Целевое действие</label>
            <input className="input" value={form.targetAction} onChange={(e) => set({ targetAction: e.target.value })} placeholder="Оплата / заявка / переход по ссылке" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-white/50">Описание</label>
            <textarea className="input min-h-[64px]" value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="О чём кампания и продукт" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-white/50">Этапы (по одному на строку)</label>
            <textarea className="input min-h-[64px]" value={stagesText} onChange={(e) => setStagesText(e.target.value)} placeholder={'знакомство\nинтерес\nоффер'} />
          </div>

          <div>
            <label className="mb-1 flex items-center gap-1.5 text-xs text-white/50"><Hash size={12} /> Каналы / группы цели <span className="text-white/30">— где ведём к цели ({channels.length})</span></label>
            <FolderPicker targets={channels} onLoad={(t) => setChannels((prev) => [...new Set([...t, ...prev])])} />
            <div className="flex gap-2">
              <input value={chInput} onChange={(e) => setChInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addChannels() } }} className="input" placeholder="@channel или t.me/channel — или загрузите папку выше" />
              <button type="button" onClick={addChannels} className="btn-ghost h-11 shrink-0 px-4"><Plus size={15} /> Добавить</button>
            </div>
            {channels.length > 0 && (
              <div className="mt-2 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-line bg-elevated/40 p-2.5">
                {channels.map((c) => (
                  <span key={c} className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-0.5 text-xs font-medium text-fg">
                    @{c}
                    <button type="button" onClick={() => setChannels((arr) => arr.filter((x) => x !== c))} className="text-faint hover:text-rose-300"><X size={12} /></button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-white/50">Критерий завершения</label>
              <input className="input" value={form.completionCriteria} onChange={(e) => set({ completionCriteria: e.target.value })} placeholder="Получен целевой ответ" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-white/50">Аудитория</label>
              <input className="input" value={form.audience} onChange={(e) => set({ audience: e.target.value })} placeholder="IT-предприниматели" />
            </div>
          </div>

          {/* §4: дедлайн цели + цель по лидам (оба опциональны). */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-white/50">Дедлайн <span className="text-white/30">(опционально — по истечении работа останавливается)</span></label>
              <div className="flex gap-2">
                {/* §4: без границ в поле даты проходил год 123123 — карточка рисовала
                    «до 24.07.123123», и цель не истекала никогда. Те же границы на сервере. */}
                <input
                  type="date" className="input"
                  min={`${DEADLINE_MIN_YEAR}-01-01`} max={`${DEADLINE_MAX_YEAR}-12-31`}
                  value={form.deadline || ''} onChange={(e) => set({ deadline: e.target.value })}
                />
                {form.deadline && <button type="button" onClick={() => set({ deadline: '' })} className="btn-ghost h-auto shrink-0 px-3 text-xs">Сбросить</button>}
              </div>
              {form.deadline && !isSaneDeadline(form.deadline) && (
                <div className="mt-1 text-xs text-rose-300">Дата вне допустимого диапазона ({DEADLINE_MIN_YEAR}–{DEADLINE_MAX_YEAR}) — проверьте год</div>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs text-white/50">Цель по лидам <span className="text-white/30">(0 = не задано, максимум {LEAD_TARGET_MAX.toLocaleString('ru-RU')})</span></label>
              {/* Без потолка сюда проходило 999999999999, и прогресс-бар терял смысл. */}
              <input type="number" min={0} max={LEAD_TARGET_MAX} className="input" value={form.leadTarget || 0} onChange={(e) => set({ leadTarget: Math.min(LEAD_TARGET_MAX, Math.max(0, Number(e.target.value) || 0)) })} placeholder="Напр. 50" />
            </div>
          </div>

          {/* §9: тон и запреты задаются ОДИН раз на кампанию — их читают все модули,
              которые пишут текст: рассылка, нейрочатинг, диалоги, комментинг.
              Иначе правила расходятся: в рассылке один голос, в комментариях другой. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-white/50">Тон общения <span className="text-white/30">— как писать</span></label>
              <textarea
                className="input min-h-[76px] resize-y"
                value={form.toneOfVoice || ''}
                onChange={(e) => set({ toneOfVoice: e.target.value })}
                placeholder="Напр. на «ты», дружелюбно и коротко, без канцелярита и восклицаний, максимум один смайл"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-white/50">Ограничения <span className="text-white/30">— чего делать нельзя</span></label>
              <textarea
                className="input min-h-[76px] resize-y"
                value={form.restrictions || ''}
                onChange={(e) => set({ restrictions: e.target.value })}
                placeholder="Напр. не обещать доход, не давить, не писать про конкурентов, не отправлять ссылку без согласия"
              />
            </div>
          </div>
          <p className="-mt-1 text-xs text-white/35">
            Эти правила подставляются во все модули кампании — рассылку, нейрочатинг, диалоги и комментинг.
          </p>

          {/* §9: дожим — единственный способ не потерять человека, который написал сам
              после того, как диалог по нему уже закрыли. */}
          <div className="rounded-lg border border-white/10 p-3">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={!!form.followUp?.enabled}
                onChange={(e) => set({ followUp: { ...(form.followUp || { limit: FOLLOW_UP_DEFAULT, instructions: '' }), enabled: e.target.checked } as FollowUp })}
              />
              <span>
                <span className="text-sm font-semibold text-fg">Дожимать, если написал сам после закрытия</span>
                <span className="mt-0.5 block text-xs text-white/45">
                  Обычно диалог с человеком заканчивается, когда он выполнил целевое действие или отказался —
                  дальше ему не пишут. Но если он потом написал сам, это входящий интерес, и молчать в ответ
                  глупо. Бот продолжит разговор, но не более указанного числа сообщений.
                </span>
              </span>
            </label>

            {form.followUp?.enabled && (
              <div className="mt-3 grid gap-3 sm:grid-cols-[160px_1fr]">
                <div>
                  <label className="mb-1 block text-xs text-white/50">Максимум сообщений</label>
                  <input
                    type="number" min={1} max={FOLLOW_UP_MAX} className="input"
                    value={form.followUp.limit || FOLLOW_UP_DEFAULT}
                    onChange={(e) => set({ followUp: { ...form.followUp!, limit: Math.min(FOLLOW_UP_MAX, Math.max(1, Number(e.target.value) || FOLLOW_UP_DEFAULT)) } })}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-white/50">Что делать в дожиме <span className="text-white/30">(необязательно)</span></label>
                  <input
                    className="input"
                    value={form.followUp.instructions || ''}
                    onChange={(e) => set({ followUp: { ...form.followUp!, instructions: e.target.value } })}
                    placeholder="Напр. предложить консультацию или узнать, что не подошло"
                  />
                </div>
              </div>
            )}
          </div>

          {editing && (
            <div className="rounded-lg border border-white/10 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm text-white/70">
                <BookOpen size={15} /> База знаний <span className="text-white/30">— что AI знает о продукте</span>
              </div>
              {kb.length > 0 && (
                <div className="mb-2 flex flex-col gap-1">
                  {kb.map((k) => (
                    <div key={k.id} className="flex items-start justify-between gap-2 rounded bg-white/5 px-2 py-1.5">
                      <div className="flex min-w-0 items-center gap-2">
                        {k.fileRef && k.kind === 'image' && (
                          <img src={kbFileUrl(k.fileRef)} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                        )}
                        <div className="min-w-0">
                          {k.title && <div className="text-xs font-semibold text-white">{k.title}</div>}
                          <div className="truncate text-xs text-white/60">{k.content}</div>
                          {k.fileRef && (
                            <a href={kbFileUrl(k.fileRef)} target="_blank" rel="noreferrer" className="text-[11px] font-semibold text-spark-300 hover:underline">
                              открыть файл
                            </a>
                          )}
                        </div>
                      </div>
                      <button onClick={() => void removeKb(k)} className="btn-icon-danger h-6 w-6 shrink-0" aria-label="Удалить из базы знаний" title="Удалить"><Trash2 size={12} /></button>
                    </div>
                  ))}
                </div>
              )}
              <input className="input mb-1" value={kbTitle} onChange={(e) => setKbTitle(e.target.value)} placeholder="Заголовок (опционально)" />
              <textarea className="input min-h-[52px]" value={kbContent} onChange={(e) => setKbContent(e.target.value)} placeholder="Факт о продукте / условие / ответ на частый вопрос" />
              <button onClick={() => void addKb()} disabled={!kbContent.trim()} className="btn-ghost mt-1 h-8 text-xs"><Plus size={13} /> Добавить в базу знаний</button>
              {/* §4: файлы, а не только текст */}
              <div className="mt-2 border-t border-line pt-2">
                <label className="flex cursor-pointer items-center gap-2 text-xs text-white/60">
                  <input
                    type="file"
                    className="hidden"
                    accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.csv,.md,.doc,.docx,.xls,.xlsx"
                    onChange={(e) => { void addKbFile(e.target.files?.[0]); e.target.value = '' }}
                  />
                  <span className="btn-ghost h-8 px-3 text-xs">{kbUploading ? 'Загрузка…' : '+ Прикрепить файл'}</span>
                  <span className="text-white/40">картинка или документ, до 3 МБ</span>
                </label>
              </div>
            </div>
          )}
        </div>
          <div className="mt-4 flex justify-end gap-2 border-t border-line pt-4">
            <button onClick={() => setOpen(false)} className="btn-ghost h-10">Отмена</button>
            <button onClick={save} disabled={saving} className="btn-primary h-10">{saving ? 'Сохранение…' : editing ? 'Сохранить' : 'Создать'}</button>
          </div>
        </Card>
      </div>
      )}
    </div>
  )
}
