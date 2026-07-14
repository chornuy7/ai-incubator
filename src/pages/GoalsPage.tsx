import { useEffect, useState } from 'react'
import { Target, Plus, Pencil, Trash2 } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { PageHeader, Card, EmptyState, Modal, Badge } from '@/shared/ui'
import { fetchGoals, createGoal, updateGoal, deleteGoal, type Goal, type GoalInput } from '@/api/goalsApi'

const EMPTY: GoalInput = { name: '', description: '', targetAction: '', stages: [], completionCriteria: '', audience: '' }

export function GoalsPage() {
  const pushToast = useApp((s) => s.pushToast)
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Goal | null>(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<GoalInput>(EMPTY)
  const [stagesText, setStagesText] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      setGoals(await fetchGoals())
    } catch (err) {
      pushToast({ type: 'error', title: 'Не удалось загрузить цели', desc: err instanceof Error ? err.message : '' })
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const openNew = () => {
    setEditing(null); setForm(EMPTY); setStagesText(''); setOpen(true)
  }
  const openEdit = (g: Goal) => {
    setEditing(g)
    setForm({ name: g.name, description: g.description, targetAction: g.targetAction, completionCriteria: g.completionCriteria, audience: g.audience })
    setStagesText((g.stages || []).join('\n'))
    setOpen(true)
  }

  const save = async () => {
    if (!form.name.trim()) return pushToast({ type: 'error', title: 'Укажите название цели' })
    setSaving(true)
    const payload: GoalInput = { ...form, stages: stagesText.split('\n').map((s) => s.trim()).filter(Boolean) }
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

  const remove = async (g: Goal) => {
    if (!window.confirm(`Удалить цель «${g.name}»?`)) return
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
      <PageHeader
        title="Цели"
        subtitle="Цель кампании: целевое действие, этапы и критерий завершения. AI-модули работают к выбранной цели."
        icon={<Target size={22} />}
        actions={<button onClick={openNew} className="btn-primary h-10"><Plus size={16} /> Новая цель</button>}
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
                  <button onClick={() => remove(g)} className="btn-icon h-8 w-8" aria-label="Удалить"><Trash2 size={14} /></button>
                </div>
              </div>
              {g.description && <div className="text-sm text-white/60">{g.description}</div>}
              {g.stages?.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {g.stages.map((s, i) => <Badge key={i} tone="iris">{i + 1}. {s}</Badge>)}
                </div>
              )}
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/40">
                {g.completionCriteria && <span>Критерий: {g.completionCriteria}</span>}
                {g.audience && <span>Аудитория: {g.audience}</span>}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? 'Изменить цель' : 'Новая цель'}
        subtitle="AI будет вести кампанию к этой цели"
        icon={<Target size={22} />}
        footer={<>
          <button onClick={() => setOpen(false)} className="btn-ghost h-10">Отмена</button>
          <button onClick={save} disabled={saving} className="btn-primary h-10">{saving ? 'Сохранение…' : editing ? 'Сохранить' : 'Создать'}</button>
        </>}
      >
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
        </div>
      </Modal>
    </div>
  )
}
