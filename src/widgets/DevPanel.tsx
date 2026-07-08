import { useState } from 'react'
import { FlaskConical, X, WifiOff, RotateCcw } from 'lucide-react'
import { useApp } from '@/mocks/store'
import { Switch } from '@/shared/ui'
import { cn } from '@/shared/lib/utils'
import type { UserState } from '@/shared/types'

const SCENARIOS: { key: UserState; label: string; hint: string }[] = [
  { key: 'with-data', label: 'С данными', hint: 'Реальные аккаунты + демо UI' },
  { key: 'empty', label: 'Пустой UI', hint: '0 аккаунтов в таблице' },
  { key: 'no-sub', label: 'Без подписки', hint: 'Paywall' },
  { key: 'guest', label: 'Гость', hint: 'Экран входа' },
]

export function DevPanel() {
  const [open, setOpen] = useState(false)
  const userState = useApp((s) => s.userState)
  const setUserState = useApp((s) => s.setUserState)
  const netErrors = useApp((s) => s.netErrors)
  const toggleNetErrors = useApp((s) => s.toggleNetErrors)
  const resetData = useApp((s) => s.resetData)
  const pushToast = useApp((s) => s.pushToast)

  return (
    <div className="fixed bottom-4 left-4 z-[90]">
      {open ? (
        <div className="w-72 rounded-2xl border border-iris-500/40 bg-surface/95 p-4 shadow-pop backdrop-blur-xl animate-scale-in">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FlaskConical size={16} className="text-iris-400" />
              <span className="font-display text-sm font-bold text-fg">Dev-панель</span>
            </div>
            <button onClick={() => setOpen(false)} className="text-faint hover:text-fg"><X size={16} /></button>
          </div>

          <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-faint">Сценарий данных</div>
          <div className="grid grid-cols-2 gap-2">
            {SCENARIOS.map((s) => (
              <button
                key={s.key}
                onClick={() => setUserState(s.key)}
                className={cn(
                  'rounded-xl border p-2.5 text-left transition-all',
                  userState === s.key ? 'border-iris-500/50 bg-iris-500/12' : 'border-line bg-elevated hover:border-iris-500/30',
                )}
              >
                <div className={cn('text-sm font-bold', userState === s.key ? 'text-iris-300' : 'text-fg')}>{s.label}</div>
                <div className="text-[11px] text-muted">{s.hint}</div>
              </button>
            ))}
          </div>

          <div className="mt-4 space-y-3 border-t border-line pt-3">
            <div className="flex items-center gap-2 text-sm">
              <WifiOff size={15} className="text-rose-400" />
              <Switch checked={netErrors} onChange={toggleNetErrors} label="Мок-ошибки сети" />
            </div>
            <button
              onClick={() => { resetData(); pushToast({ type: 'info', title: 'Данные сброшены', desc: 'Сценарий перезагружен с нуля.' }) }}
              className="btn-ghost h-9 w-full text-sm"
            >
              <RotateCcw size={15} /> Сбросить данные
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 rounded-full border border-iris-500/40 bg-surface/90 px-3.5 py-2 shadow-pop backdrop-blur-xl transition-transform hover:-translate-y-0.5"
        >
          <FlaskConical size={16} className="text-iris-400" />
          <span className="text-sm font-bold text-fg">Dev</span>
        </button>
      )}
    </div>
  )
}
