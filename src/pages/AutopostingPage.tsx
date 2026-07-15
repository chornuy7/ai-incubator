import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Megaphone, Send, Info } from 'lucide-react'
import { PageHeader, Card } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import { AccountPicker } from '@/features/account-picker/AccountPicker'
import { startModuleTask } from '@/api/modulesApi'

export function AutopostingPage() {
  const nav = useNavigate()
  const pushToast = useApp((s) => s.pushToast)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [channelsText, setChannelsText] = useState('')
  const [text, setText] = useState('')
  const [delayMin, setDelayMin] = useState(60)
  const [delayMax, setDelayMax] = useState(180)
  const [launching, setLaunching] = useState(false)

  const channels = useMemo(() => {
    const raw = channelsText.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)
    return [...new Set(raw)]
  }, [channelsText])

  const canLaunch = selected.size > 0 && channels.length > 0 && text.trim().length > 0 && !launching

  async function launch() {
    setLaunching(true)
    try {
      await startModuleTask('autoposting', {
        accountIds: [...selected],
        targets: channels,
        promptText: text.trim(),
        delays: { action: [delayMin, delayMax] },
      })
      pushToast({ type: 'success', title: 'Автопостинг создан', desc: `${channels.length} каналов · ${selected.size} аккаунтов` })
      nav('/panel/tasks')
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось создать', desc: e instanceof Error ? e.message : '' })
    } finally { setLaunching(false) }
  }

  return (
    <div>
      <PageHeader
        title="Автопостинг"
        subtitle="Публикация постов в СВОИ каналы/группы. Безопасно — не спам (§8.10)."
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
            <div className="mb-1 text-xs text-white/50">Текст поста</div>
            <textarea className="input min-h-[110px]" value={text} onChange={(e) => setText(e.target.value)} placeholder="Текст, который опубликуется в каналах…" />
          </Card>

          <Card className="p-4">
            <div className="mb-2 text-sm font-semibold text-fg">Темп</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-white/50">Задержка от (с)
                <input type="number" min={1} value={delayMin} onChange={(e) => setDelayMin(Math.max(1, Number(e.target.value) || 1))} className="input mt-1 h-9" />
              </label>
              <label className="text-xs text-white/50">до (с)
                <input type="number" min={delayMin} value={delayMax} onChange={(e) => setDelayMax(Math.max(delayMin, Number(e.target.value) || delayMin))} className="input mt-1 h-9" />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/50">
              <span>Каналов: <b className="text-white">{channels.length}</b></span>
              <span>Аккаунтов: <b className="text-white">{selected.size}</b></span>
            </div>
            <button onClick={() => void launch()} disabled={!canLaunch} className="btn-primary mt-3 h-10 w-full disabled:opacity-40">
              <Send size={16} /> {launching ? 'Создание…' : 'Опубликовать'}
            </button>
          </Card>
        </div>
      </div>
    </div>
  )
}
