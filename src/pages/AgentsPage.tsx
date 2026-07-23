import { useEffect, useState } from 'react'
import { Bot, Plus, Pencil, Trash2, Copy, X } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Badge } from '@/shared/ui'
import { HelpButton } from '@/features/neuro-commenting/moduleUi'
import { confirmDialog } from '@/shared/lib/dialog'
import {
  fetchAgents, createAgent, updateAgent, deleteAgent,
  FOLLOW_UP_MAX, FOLLOW_UP_DEFAULT, type Agent, type AgentInput,
} from '@/api/agentsApi'

const EMPTY: AgentInput = {
  name: '', toneOfVoice: '', restrictions: '', character: '', language: '',
  followUp: { enabled: false, limit: FOLLOW_UP_DEFAULT, instructions: '' },
}

/**
 * «Агенты» — как персона общается ИИ. Отдельно от Цели: цель = ЧТО достичь, агент = КАК.
 * Решающий довод (созвон 22.07): одна кампания, где 500 хвалят и 500 спорят, — это два
 * агента. Значит тон/характер живут отдельной сущностью, а в кампании выбираются, как цель.
 */
export function AgentsPage() {
  const pushToast = useApp((s) => s.pushToast)
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<AgentInput | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    try { setAgents(await fetchAgents()) }
    catch (e) { pushToast({ type: 'error', title: 'Не удалось загрузить агентов', desc: e instanceof Error ? e.message : '' }) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const set = (patch: Partial<AgentInput>) => setForm((f) => ({ ...(f as AgentInput), ...patch }))

  const openNew = () => { setEditingId(null); setForm({ ...EMPTY }) }
  const openEdit = (a: Agent) => {
    setEditingId(a.id)
    setForm({ name: a.name, toneOfVoice: a.toneOfVoice, restrictions: a.restrictions, character: a.character, language: a.language, followUp: a.followUp })
  }

  const save = async () => {
    if (!form?.name.trim()) return pushToast({ type: 'error', title: 'Укажите название агента' })
    setSaving(true)
    try {
      if (editingId) { await updateAgent(editingId, form); pushToast({ type: 'success', title: 'Агент сохранён' }) }
      else { await createAgent(form); pushToast({ type: 'success', title: 'Агент создан' }) }
      setForm(null); setEditingId(null); await load()
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка сохранения', desc: e instanceof Error ? e.message : '' })
    } finally { setSaving(false) }
  }

  const duplicate = async (a: Agent) => {
    try {
      await createAgent({ name: `${a.name} — копия`, toneOfVoice: a.toneOfVoice, restrictions: a.restrictions, character: a.character, language: a.language, followUp: a.followUp })
      pushToast({ type: 'success', title: 'Агент скопирован' })
      await load()
    } catch (e) { pushToast({ type: 'error', title: 'Не удалось скопировать', desc: e instanceof Error ? e.message : '' }) }
  }

  const remove = async (a: Agent) => {
    if (!(await confirmDialog({ title: 'Удалить агента?', message: `«${a.name}» будет удалён.`, confirmLabel: 'Удалить', tone: 'danger' }))) return
    try { await deleteAgent(a.id); pushToast({ type: 'success', title: 'Агент удалён' }); await load() }
    catch (e) { pushToast({ type: 'error', title: 'Ошибка удаления', desc: e instanceof Error ? e.message : '' }) }
  }

  // ── Форма создания/редактирования ──
  if (form) {
    const fu = form.followUp!
    return (
      <div>
        <button onClick={() => { setForm(null); setEditingId(null) }} className="btn-ghost mb-3 h-9"><X size={15} /> Назад к агентам</button>
        <PageHeader title={editingId ? 'Изменить агента' : 'Новый агент'} subtitle="Как персона общается: тон, характер, что нельзя. Цель отдельно — она про результат." icon={<Bot size={22} />} />
        <Card className="space-y-4 p-4">
          <div>
            <label className="mb-1 block text-xs text-white/50">Название *</label>
            <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Напр. Дружелюбный эксперт" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-white/50">Характер / роль</label>
              <textarea className="input min-h-[76px] resize-y" value={form.character || ''} onChange={(e) => set({ character: e.target.value })} placeholder="Напр. опытный трейдер, спокойный, делится опытом без навязчивости" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-white/50">Тон общения <span className="text-white/30">— как писать</span></label>
              <textarea className="input min-h-[76px] resize-y" value={form.toneOfVoice || ''} onChange={(e) => set({ toneOfVoice: e.target.value })} placeholder="Напр. на «ты», коротко, без канцелярита и восклицаний" />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
            <div>
              <label className="mb-1 block text-xs text-white/50">Ограничения <span className="text-white/30">— чего нельзя</span></label>
              <textarea className="input min-h-[76px] resize-y" value={form.restrictions || ''} onChange={(e) => set({ restrictions: e.target.value })} placeholder="Напр. не обещать доход, не давить, не отправлять ссылку без согласия" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-white/50">Язык <span className="text-white/30">(пусто — язык собеседника)</span></label>
              <input className="input" value={form.language || ''} onChange={(e) => set({ language: e.target.value })} placeholder="русский" />
            </div>
          </div>

          {/* Дожим — настойчивость персоны: писать ли, если человек ответил после закрытия. */}
          <div className="rounded-lg border border-white/10 p-3">
            <label className="flex cursor-pointer items-start gap-2">
              <input type="checkbox" className="mt-1" checked={fu.enabled} onChange={(e) => set({ followUp: { ...fu, enabled: e.target.checked } })} />
              <span>
                <span className="text-sm font-semibold text-fg">Дожимать, если написал сам после закрытия</span>
                <span className="mt-0.5 block text-xs text-white/45">Диалог закрыт (цель достигнута или отказ), но человек написал сам — это входящий интерес. Персона продолжит, но не более указанного числа сообщений.</span>
              </span>
            </label>
            {fu.enabled && (
              <div className="mt-3 grid gap-3 sm:grid-cols-[160px_1fr]">
                <div>
                  <label className="mb-1 block text-xs text-white/50">Максимум сообщений</label>
                  <input type="number" min={1} max={FOLLOW_UP_MAX} className="input" value={fu.limit} onChange={(e) => set({ followUp: { ...fu, limit: Math.min(FOLLOW_UP_MAX, Math.max(1, Number(e.target.value) || FOLLOW_UP_DEFAULT)) } })} />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-white/50">Что делать в дожиме <span className="text-white/30">(необязательно)</span></label>
                  <input className="input" value={fu.instructions} onChange={(e) => set({ followUp: { ...fu, instructions: e.target.value } })} placeholder="Напр. предложить консультацию" />
                </div>
              </div>
            )}
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
        title="Агенты"
        subtitle="Как общается ИИ: тон, характер, ограничения. Выбираются в задачах кампании, как цель. Цель — про результат, агент — про манеру."
        icon={<Bot size={22} />}
        actions={<div className="flex items-center gap-2"><HelpButton topic="goals" className="h-10 w-10" /><button onClick={openNew} className="btn-primary h-9"><Plus size={15} /> Агент</button></div>}
      />
      {loading ? (
        <Card className="p-6 text-sm text-white/50">Загрузка…</Card>
      ) : agents.length === 0 ? (
        <EmptyState icon={<Bot size={26} />} title="Агентов пока нет" desc="Создайте персону — тон и характер, которыми ИИ общается. Одного агента можно выбирать в разных кампаниях." action={<button onClick={openNew} className="btn-primary h-9"><Plus size={15} /> Создать агента</button>} />
      ) : (
        <div className="flex flex-col gap-2">
          {agents.map((a) => (
            <Card key={a.id} className="flex flex-wrap items-start gap-2 p-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-iris-500/12 text-iris-300"><Bot size={18} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-white">{a.name}</span>
                  {a.language && <Badge tone="muted">{a.language}</Badge>}
                  {a.followUp?.enabled && <Badge tone="iris">дожим до {a.followUp.limit}</Badge>}
                </div>
                {a.character && <div className="mt-0.5 text-xs text-white/60">{a.character}</div>}
                {a.toneOfVoice && <div className="mt-0.5 text-xs text-white/40">тон: {a.toneOfVoice}</div>}
                {a.restrictions && <div className="mt-0.5 text-xs text-rose-300/70">нельзя: {a.restrictions}</div>}
              </div>
              <div className="flex shrink-0 gap-1">
                <button onClick={() => openEdit(a)} className="btn-icon h-8 w-8" aria-label="Изменить" title="Изменить"><Pencil size={14} /></button>
                <button onClick={() => void duplicate(a)} className="btn-icon h-8 w-8" aria-label="Дублировать" title="Дублировать"><Copy size={14} /></button>
                <button onClick={() => void remove(a)} className="btn-icon-danger h-8 w-8" aria-label="Удалить" title="Удалить"><Trash2 size={14} /></button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
