import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { BookOpen, HelpCircle, Layers, Lightbulb, Loader2, Send, Sparkles, Workflow, X } from 'lucide-react'
import { useUi } from '@/shared/lib/uiStore'
import { findHelpDoc, type HelpDoc } from '@/shared/config/helpDocs'
import { apiGet, apiPost } from '@/api/client'
import { cn } from '@/shared/lib/utils'

const QUICK_QUESTIONS = [
  'Что делает этот раздел и когда его использовать?',
  'Как настроить задержки, чтобы не банили?',
  'Почему аккаунт показывает «в работе»?',
  'Какие лимиты выставить для начала?',
]

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
  return `Помощь по разделу: ${clean}\n\nЗадайте вопрос про настройки, тайминги, лимиты или безопасность аккаунтов — отвечу с учётом того, как этот раздел работает внутри.`
}

/** Собирает текст документации раздела как контекст для ИИ. */
function docContext(doc: HelpDoc | null): string {
  if (!doc) return ''
  return [
    doc.title,
    `Что это: ${doc.what}`,
    `Как работает внутри: ${doc.how}`,
    `Связь с другими модулями: ${doc.together}`,
    `Пример: ${doc.example}`,
    doc.tips?.length ? `Советы: ${doc.tips.join('; ')}` : '',
  ].filter(Boolean).join('\n')
}

export function HelpCenterDrawer() {
  const open = useUi((s) => s.helpOpen)
  const topic = useUi((s) => s.helpTopic)
  const setHelpOpen = useUi((s) => s.setHelpOpen)
  const location = useLocation()

  const [messages, setMessages] = useState<HelpMsg[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [aiActive, setAiActive] = useState<boolean | null>(null)
  const messagesRef = useRef<HelpMsg[]>([])
  messagesRef.current = messages
  const bottomRef = useRef<HTMLDivElement>(null)

  const moduleKey = moduleKeyFromPath(location.pathname)
  const doc = useMemo(() => findHelpDoc(topic, moduleKey), [topic, moduleKey])
  const intro = useMemo(() => helpIntro(topic), [topic])

  useEffect(() => {
    if (!open) return
    const first = doc
      ? `Это документация по разделу «${doc.title}». Ниже можно задать уточняющий вопрос — отвечу ИИ с учётом того, как раздел устроен.`
      : intro
    setMessages([{ id: 'intro', role: 'assistant', text: first }])
    setInput('')
    void apiGet<{ ai?: boolean }>('/api/health').then((h) => setAiActive(!!h.ai)).catch(() => setAiActive(null))
  }, [open, intro, doc])

  // авто-скролл к последнему сообщению
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [messages])

  const send = async (override?: string) => {
    const text = (override ?? input).trim()
    if (!text || pending) return

    const userMsg: HelpMsg = { id: `${Date.now()}_${Math.random()}`, role: 'user', text }
    const loadingId = `${Date.now()}_${Math.random()}_a`
    const history = messagesRef.current.filter((m) => m.id !== 'intro').map((m) => ({ role: m.role, text: m.text }))
    setMessages((prev) => [...prev, userMsg, { id: loadingId, role: 'assistant', text: '…' }])
    setInput('')
    setPending(true)
    try {
      const data = await apiPost<{ answer: string; mode: string }>('/api/ai/help', {
        topic, moduleKey, question: text, history, context: docContext(doc),
      })
      setMessages((prev) => prev.map((m) => (m.id === loadingId ? { ...m, text: data.answer } : m)))
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Не удалось получить ответ'
      setMessages((prev) => prev.map((m) => (m.id === loadingId ? { ...m, text: `⚠️ ${msg}. Проверьте, что запущен API (npm run dev).` } : m)))
    } finally {
      setPending(false)
    }
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
              <div className="flex items-center gap-2">
                <h3 className="font-display text-lg font-bold text-fg">Help Center</h3>
                {aiActive !== null && (
                  <span className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase', aiActive ? 'border-spark-500/30 bg-spark-500/12 text-spark-300' : 'border-amber-500/30 bg-amber-500/12 text-amber-300')}>
                    <Sparkles size={10} /> {aiActive ? 'ИИ активен' : 'Шаблоны'}
                  </span>
                )}
              </div>
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

          {messages.length <= 1 && !pending && (
            <div className="mt-4">
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Быстрые вопросы</div>
              <div className="flex flex-wrap gap-2">
                {QUICK_QUESTIONS.map((qq) => (
                  <button key={qq} type="button" onClick={() => void send(qq)}
                    className="rounded-lg border border-line bg-elevated px-2.5 py-1.5 text-left text-xs text-fg transition-colors hover:border-spark-500/40 hover:text-spark-300">
                    {qq}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-line p-4">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
                rows={2}
                disabled={pending}
                className="input min-h-[44px] resize-none text-sm disabled:opacity-60"
                placeholder="Напишите вопрос про настройки…"
              />
            </div>
            <button
              type="button"
              onClick={() => void send()}
              className="btn-primary h-10 w-10"
              aria-label="Отправить"
              disabled={!input.trim() || pending}
            >
              {pending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
          <div className="mt-2 text-xs text-muted">Ответы — ИИ по документации раздела. Без OPENAI_API_KEY отвечает по фактам системы.</div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

