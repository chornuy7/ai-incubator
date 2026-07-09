import { useEffect, useState } from 'react'
import { ShieldAlert, Check } from 'lucide-react'
import { Modal, Select } from '@/shared/ui'
import { NumberField } from './index'
import { useApp } from '@/mocks/store'
import { fetchAiSafety, saveAiSafety, type AiSafetySettings } from '@/api/featuresApi'

const DEFAULTS: AiSafetySettings = {
  onBan: 'continue',
  onSpamblock: 'skip',
  floodWaitExtraSeconds: 120,
  floodQuarantineThreshold: 3,
  delayMultiplier: 1,
  pacingMultiplier: 1,
  perAccountDailyCap: 0,
  updatedAt: 0,
}

/**
 * (11) Глобальные настройки ИИ-безопасности. Кнопка + модалка с Edit.
 * Политики применяются во всех воркерах (задержки, floodwait, карантин, бан, суточный кап).
 */
export function AiSafetyModal({ trigger }: { trigger?: (open: () => void) => React.ReactNode }) {
  const pushToast = useApp((s) => s.pushToast)
  const [open, setOpen] = useState(false)
  const [s, setS] = useState<AiSafetySettings>(DEFAULTS)
  const [loading, setLoading] = useState(false)

  const reload = async () => {
    try { setS(await fetchAiSafety()) } catch { /* API offline */ }
  }
  useEffect(() => { if (open) void reload() }, [open])

  const patch = (p: Partial<AiSafetySettings>) => setS((prev) => ({ ...prev, ...p }))

  const save = async () => {
    setLoading(true)
    try {
      const next = await saveAiSafety(s)
      setS(next)
      setOpen(false)
      pushToast({ type: 'success', title: 'ИИ-безопасность сохранена' })
    } catch (e) {
      pushToast({ type: 'error', title: 'Ошибка', desc: e instanceof Error ? e.message : '' })
    } finally { setLoading(false) }
  }

  return (
    <>
      {trigger ? trigger(() => setOpen(true)) : (
        <button type="button" onClick={() => setOpen(true)} className="btn-ghost h-10">
          <ShieldAlert size={16} /> ИИ-безопасность
        </button>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="ИИ-безопасность"
        subtitle="Глобальные политики защиты аккаунтов — применяются во всех модулях"
        icon={<ShieldAlert size={22} />}
        size="lg"
        footer={
          <>
            <button type="button" onClick={() => setOpen(false)} className="btn-ghost h-10 text-sm">Отмена</button>
            <button type="button" onClick={save} disabled={loading} className="btn-primary h-10 text-sm"><Check size={15} /> Сохранить</button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">При бане аккаунта</label>
              <Select
                value={s.onBan}
                onChange={(v) => patch({ onBan: v as AiSafetySettings['onBan'] })}
                options={[
                  { value: 'continue', label: 'Продолжать (только лог)' },
                  { value: 'quarantine', label: 'В карантин' },
                  { value: 'stop-account', label: 'Остановить аккаунт' },
                  { value: 'stop-task', label: 'Остановить всю задачу' },
                ]}
              />
            </div>
            <div>
              <label className="label">При спамблоке</label>
              <Select
                value={s.onSpamblock}
                onChange={(v) => patch({ onSpamblock: v as AiSafetySettings['onSpamblock'] })}
                options={[
                  { value: 'skip', label: 'Пометить и пропускать' },
                  { value: 'quarantine', label: 'В карантин' },
                ]}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField label="Доп. пауза при FloodWait (сек)" value={s.floodWaitExtraSeconds} onChange={(n) => patch({ floodWaitExtraSeconds: n })} />
            <NumberField label="FloodWait до карантина" value={s.floodQuarantineThreshold} onChange={(n) => patch({ floodQuarantineThreshold: n })} min={1} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField label="Множитель задержек (×10)" value={Math.round(s.delayMultiplier * 10)} onChange={(n) => patch({ delayMultiplier: Math.max(1, n) / 10 })} min={1} suffix={`×${s.delayMultiplier.toFixed(1)}`} />
            <NumberField label="Пейсинг активности (×10)" value={Math.round(s.pacingMultiplier * 10)} onChange={(n) => patch({ pacingMultiplier: Math.max(1, n) / 10 })} min={1} suffix={`×${s.pacingMultiplier.toFixed(1)}`} />
          </div>

          <NumberField label="Суточный кап действий на аккаунт (0 = без лимита)" value={s.perAccountDailyCap} onChange={(n) => patch({ perAccountDailyCap: n })} />

          <p className="text-xs text-muted">Дефолты сохраняют текущее поведение системы. Множители {'>'}1 замедляют работу и повышают безопасность.</p>
        </div>
      </Modal>
    </>
  )
}
