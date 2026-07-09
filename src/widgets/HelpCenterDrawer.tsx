import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { BookOpen, HelpCircle, Layers, Lightbulb, Send, Sparkles, Workflow, X } from 'lucide-react'
import { useUi } from '@/shared/lib/uiStore'
import { findHelpDoc, type HelpDoc } from '@/shared/config/helpDocs'
import { cn } from '@/shared/lib/utils'

type HelpMsg = { id: string; role: 'user' | 'assistant'; text: string }

/** Достаёт ключ модуля из пути вида /panel/modules/:moduleKey. */
function moduleKeyFromPath(pathname: string): string | undefined {
  const m = pathname.match(/\/panel\/modules\/([^/?#]+)/)
  return m?.[1]
}

function DocSection({ icon, title, accent, children }: {
  icon: React.ReactNode; title: string; accent: 'spark' | 'iris'; children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl border border-line bg-elevated/40 p-3.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className={cn('grid h-7 w-7 place-items-center rounded-lg', accent === 'iris' ? 'bg-iris-500/12 text-iris-400' : 'bg-spark-500/12 text-spark-400')}>{icon}</span>
        <span className="text-xs font-bold uppercase tracking-wide text-muted">{title}</span>
      </div>
      <div className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{children}</div>
    </div>
  )
}

function HelpDocView({ doc }: { doc: HelpDoc }) {
  const accent: 'spark' | 'iris' = doc.title.toLowerCase().includes('парс') || doc.title.toLowerCase().includes('ggr') || doc.title.toLowerCase().includes('нейродиалог')
    ? 'iris'
    : 'spark'
  return (
    <div className="space-y-3">
      <div className={cn('rounded-2xl border p-3.5', accent === 'iris' ? 'border-iris-500/30 bg-iris-500/8' : 'border-spark-500/30 bg-spark-500/8')}>
        <div className="flex items-center gap-2">
          <BookOpen size={16} className={accent === 'iris' ? 'text-iris-300' : 'text-spark-300'} />
          <span className="font-display text-base font-bold text-fg">{doc.title}</span>
        </div>
        <p className="mt-1 text-xs text-muted">Документация модуля — как это устроено внутри</p>
      </div>

      <DocSection icon={<Sparkles size={15} />} title="Что это" accent={accent}>{doc.what}</DocSection>
      <DocSection icon={<Workflow size={15} />} title="Как работает внутри" accent={accent}>{doc.how}</DocSection>
      <DocSection icon={<Layers size={15} />} title="Как работает вместе с другими модулями" accent={accent}>{doc.together}</DocSection>
      <DocSection icon={<Lightbulb size={15} />} title="Пример результата" accent={accent}>{doc.example}</DocSection>

      {doc.tips?.length ? (
        <div className="rounded-2xl border border-line bg-elevated/40 p-3.5">
          <div className="mb-1.5 flex items-center gap-2">
            <Lightbulb size={15} className={accent === 'iris' ? 'text-iris-400' : 'text-spark-400'} />
            <span className="text-xs font-bold uppercase tracking-wide text-muted">Советы</span>
          </div>
          <ul className="space-y-1.5">
            {doc.tips.map((t, i) => (
              <li key={i} className="flex gap-2 text-sm leading-relaxed text-fg">
                <span className={accent === 'iris' ? 'text-iris-400' : 'text-spark-400'}>•</span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function helpIntro(topic: string) {
  const clean = topic?.trim() || 'раздел'
  return `Помощь по разделу: ${clean}\n\nПодсказка: настройки применяются на сервере и учитывают защиту аккаунтов, ограничения и тайминги. Если опишите, что именно хотите добиться, я предложу подходящую конфигурацию.`
}

function assistantReply(topic: string, question: string) {
  const q = question.toLowerCase()
  const cleanTopic = topic?.trim() || 'раздел'

  if (q.includes('время') || q.includes('минут') || q.includes('duration') || q.includes('workMode'.toLowerCase())) {
    return `Если включён режим “по времени”, то длительность ограничивает общее время выполнения задачи.\nДля безопасности время разбивается на “периоды” с учётом защиты (Консервативный/Сбалансированный/Агрессивный). Раздел: ${cleanTopic}.`
  }
  if (q.includes('задержк') || q.includes('flood') || q.includes('скорост')) {
    return `Задержки определяют паузы между действиями и вступлением в целевую сущность, а также реакцию на FloodWait.\nПопробуйте начать с “Рекомендуемые” задержки и затем подобрать под нужную скорость/риск. Раздел: ${cleanTopic}.`
  }
  if (q.includes('модуль') || q.includes('в работе') || q.includes('busy') || q.includes('аккаунт')) {
    return `Аккаунт считается “в работе”, если у него есть активная задача (lock) в другом модуле.\nВ меню выбора/таблицах это отображается через ` +
      `"busyIn.moduleLabel".Раздел: ${cleanTopic}.`
  }

  return `Понял задачу по ${cleanTopic}.\nСначала уточните: цель (скорость/безопасность/лимиты), и какой триггер вас интересует. Затем я подскажу конкретные значения для таймингов и лимитов.`
}

export function HelpCenterDrawer() {
  const open = useUi((s) => s.helpOpen)
  const topic = useUi((s) => s.helpTopic)
  const setHelpOpen = useUi((s) => s.setHelpOpen)
  const location = useLocation()

  const [messages, setMessages] = useState<HelpMsg[]>([])
  const [input, setInput] = useState('')

  const doc = useMemo(
    () => findHelpDoc(topic, moduleKeyFromPath(location.pathname)),
    [topic, location.pathname],
  )
  const intro = useMemo(() => helpIntro(topic), [topic])

  useEffect(() => {
    if (!open) return
    const first = doc
      ? `Это документация по разделу «${doc.title}». Ниже можно задать уточняющий вопрос по настройкам.`
      : intro
    setMessages([{ id: 'intro', role: 'assistant', text: first }])
    setInput('')
  }, [open, intro, doc])

  const send = () => {
    const text = input.trim()
    if (!text) return

    const userMsg: HelpMsg = { id: `${Date.now()}_${Math.random()}`, role: 'user', text }
    const assistantMsg: HelpMsg = {
      id: `${Date.now()}_${Math.random()}_a`,
      role: 'assistant',
      text: assistantReply(topic, text),
    }

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setInput('')
  }

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[96]">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={() => setHelpOpen(false)} />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-line bg-surface shadow-pop animate-fade-in">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2.5">
            <HelpCircle size={20} className="text-spark-400" />
            <div>
              <h3 className="font-display text-lg font-bold text-fg">Help Center</h3>
              <p className="text-xs text-muted">{doc ? 'Документация и подсказки по разделу' : 'Чат-подсказки по разделу'}</p>
            </div>
          </div>
          <button onClick={() => setHelpOpen(false)} className="btn-icon"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {doc && <HelpDocView doc={doc} />}
          {doc && (
            <div className="mb-3 mt-5 flex items-center gap-2">
              <span className="h-px flex-1 bg-line" />
              <span className="text-xs font-bold uppercase tracking-wide text-muted">Спросить ещё</span>
              <span className="h-px flex-1 bg-line" />
            </div>
          )}
          <div className="space-y-3">
            {messages.map((m) => (
              <div key={m.id} className={cn('whitespace-pre-wrap rounded-2xl border px-4 py-3 text-sm', m.role === 'user' ? 'bg-spark-500/8 border-spark-500/30' : 'bg-elevated/40 border-line')}>
                <div className={cn('mb-1 text-xs font-bold uppercase', m.role === 'user' ? 'text-spark-300' : 'text-muted')}>{m.role === 'user' ? 'Вы' : 'AI'}</div>
                {m.text}
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-line p-4">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={2}
                className="input min-h-[44px] resize-none text-sm"
                placeholder="Напишите вопрос про настройки…"
              />
            </div>
            <button
              type="button"
              onClick={send}
              className="btn-primary h-10 w-10"
              aria-label="Отправить"
              disabled={!input.trim()}
            >
              <Send size={16} />
            </button>
          </div>
          <div className="mt-2 text-xs text-muted">Локальная демо-логика (без отправки на сервер).</div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

