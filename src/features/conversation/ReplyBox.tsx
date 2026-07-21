import { useCallback, useEffect, useRef } from 'react'
import { Bold, Italic, Link2, Send, Loader2 } from 'lucide-react'

/**
 * §9.9/§9.3: ОБЩЕЕ поле ответа для всех экранов переписки — панель форматирования
 * Telegram-разметкой + растущая многострочная textarea.
 *
 * Почему не `<input>`, как было раньше на обоих экранах: многострочный ответ в него
 * физически нельзя набрать, хотя Shift+Enter уже обрабатывался — то есть подсказка
 * обещала то, чего поле не умело.
 *
 * Enter — отправить, Shift+Enter — перенос строки.
 */
export function ReplyBox({
  value, onChange, onSend, sending = false, toolbar = true,
  placeholder = 'Написать сообщение…  Enter — отправить, Shift+Enter — новая строка',
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  sending?: boolean
  /** Панель форматирования. Выключается там, где она только мешает (узкие колонки). */
  toolbar?: boolean
  placeholder?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  /** Обернуть выделение в разметку и вернуть выделение на текст, а не на маркеры. */
  const fmt = useCallback((before: string, after: string) => {
    const el = ref.current
    if (!el) return
    const s = el.selectionStart ?? value.length
    const e = el.selectionEnd ?? value.length
    const sel = value.slice(s, e) || 'текст'
    onChange(value.slice(0, s) + before + sel + after + value.slice(e))
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + before.length, s + before.length + sel.length) })
  }, [value, onChange])

  // Растим поле под текст и сжимаем обратно после отправки: textarea с rows=1 сама не растёт.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [value])

  return (
    <div>
      {toolbar && (
        <div className="mb-2 flex items-center gap-1">
          {([
            [<Bold size={13} key="b" />, 'Жирный', '**', '**'],
            [<Italic size={13} key="i" />, 'Курсив', '__', '__'],
            [<Link2 size={13} key="l" />, 'Ссылка', '[', '](https://)'],
          ] as [React.ReactNode, string, string, string][]).map(([icon, title, b, a]) => (
            <button key={title} type="button" title={title} onClick={() => fmt(b, a)}
              className="grid h-7 w-7 place-items-center rounded-md border border-line bg-elevated text-muted transition-colors hover:border-spark-500/40 hover:text-fg">
              {icon}
            </button>
          ))}
          <span className="ml-1 text-[10px] text-faint">**жирный** · __курсив__ · [ссылка](url)</span>
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), onSend())}
          className="input min-h-[42px] min-w-0 flex-1 resize-none py-2.5 leading-snug"
          style={{ maxHeight: 160, overflowY: value.split('\n').length > 5 ? 'auto' : 'hidden' }}
          placeholder={placeholder}
          disabled={sending}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={sending || !value.trim()}
          className="btn-iris h-[42px] shrink-0 px-4 disabled:opacity-40"
        >
          {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </div>
    </div>
  )
}
