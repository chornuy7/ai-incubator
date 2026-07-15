import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Mail, Send, AlertTriangle } from 'lucide-react'
import { PageHeader, Card, Select } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import { AccountPicker } from '@/features/account-picker/AccountPicker'
import { fetchGoals, type Goal } from '@/api/goalsApi'
import { startModuleTask } from '@/api/modulesApi'

export function MailingPage() {
  const nav = useNavigate()
  const pushToast = useApp((s) => s.pushToast)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [numbersText, setNumbersText] = useState('')
  const [message, setMessage] = useState('')
  const [maxPerAccount, setMaxPerAccount] = useState(30)
  const [delayMin, setDelayMin] = useState(30)
  const [delayMax, setDelayMax] = useState(90)
  const [goals, setGoals] = useState<Goal[]>([])
  const [goalId, setGoalId] = useState('')
  const [launching, setLaunching] = useState(false)

  useEffect(() => { void fetchGoals().then(setGoals).catch(() => {}) }, [])

  const numbers = useMemo(() => {
    const raw = numbersText.split(/[\n,;]+/).map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 7)
    return [...new Set(raw)]
  }, [numbersText])

  const perAcc = selected.size ? Math.ceil(numbers.length / selected.size) : 0
  const canLaunch = selected.size > 0 && numbers.length > 0 && message.trim().length > 0 && !launching

  async function launch() {
    setLaunching(true)
    try {
      await startModuleTask('mailing', {
        accountIds: [...selected],
        targets: numbers,
        promptText: message.trim(),
        maxPerAccount,
        delays: { action: [delayMin, delayMax] },
        ...(goalId ? { goalId } : {}),
      })
      pushToast({ type: 'success', title: 'Рассылка создана', desc: `${numbers.length} номеров · ${selected.size} аккаунтов` })
      nav('/panel/tasks')
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось создать', desc: e instanceof Error ? e.message : '' })
    } finally { setLaunching(false) }
  }

  return (
    <div>
      <PageHeader
        title="Мейлинг"
        subtitle="Рассылка в Telegram по номерам телефонов (§8.4). Резолв номера → аккаунт → ЛС."
        icon={<Mail size={22} />}
        badge="каркас"
      />

      <Card className="mb-4 flex items-start gap-2 border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200/90">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <span>Массовая рассылка незнакомым — высокий риск спам-блока <b>ваших аккаунтов</b>. Держите лимиты низкими и задержки большими. Реальная отправка подключается на live-прогоне.</span>
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
            <div className="mb-1 text-xs text-white/50">Номера телефонов ({numbers.length} валидных)</div>
            <textarea className="input min-h-[110px] font-mono text-sm" value={numbersText} onChange={(e) => setNumbersText(e.target.value)} placeholder={'+380671234567\n+48512345678\nпо одному на строку'} />
          </Card>

          <Card className="p-4">
            <div className="mb-1 text-xs text-white/50">Текст сообщения</div>
            <textarea className="input min-h-[90px]" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Здравствуйте! …" />
            {goals.length > 0 && (
              <div className="mt-2">
                <div className="mb-1 text-xs text-white/50">Цель (опционально — генерация к цели)</div>
                <Select value={goalId} onChange={setGoalId} options={[{ value: '', label: 'Без цели' }, ...goals.map((g) => ({ value: g.id, label: g.name }))]} />
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="mb-2 text-sm font-semibold text-fg">Безопасность</div>
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
            <button onClick={() => void launch()} disabled={!canLaunch} className="btn-primary mt-3 h-10 w-full disabled:opacity-40">
              <Send size={16} /> {launching ? 'Создание…' : 'Создать рассылку'}
            </button>
          </Card>
        </div>
      </div>
    </div>
  )
}
