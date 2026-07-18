import { useRef } from 'react'
import { Bold, Italic, Code, Link2, Image as ImageIcon, Film, Plus, X } from 'lucide-react'

/**
 * §11: редактор сообщения для мейлинга/автопостинга — форматирование в стиле Telegram
 * (жирный/курсив/код/ссылка) + вложения медиа (фото/видео) и ссылок.
 * Формат — Markdown, который бэкенд отдаёт в Telegram parse_mode=Markdown.
 */

export type MediaKind = 'image' | 'video' | 'link'

export function mediaKind(url: string): MediaKind {
  const u = url.toLowerCase().split('?')[0]
  if (/\.(jpe?g|png|webp|gif|bmp|heic)$/.test(u)) return 'image'
  if (/\.(mp4|mov|webm|mkv|avi|m4v)$/.test(u)) return 'video'
  return 'link'
}

function wrapSelection(el: HTMLTextAreaElement, before: string, after: string, onChange: (v: string) => void) {
  const { selectionStart: s, selectionEnd: e, value } = el
  const sel = value.slice(s, e) || 'текст'
  const next = value.slice(0, s) + before + sel + after + value.slice(e)
  onChange(next)
  // Вернуть фокус и выделить вставленное содержимое.
  requestAnimationFrame(() => {
    el.focus()
    el.setSelectionRange(s + before.length, s + before.length + sel.length)
  })
}

export function MessageComposer({
  value, onChange, media, onMedia, placeholder, minHeight = 110, label = 'Текст сообщения',
}: {
  value: string
  onChange: (v: string) => void
  media: string[]
  onMedia: (m: string[]) => void
  placeholder?: string
  minHeight?: number
  label?: string
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const mediaInputRef = useRef<HTMLInputElement>(null)

  const fmt = (before: string, after: string) => {
    const el = taRef.current
    if (el) wrapSelection(el, before, after, onChange)
  }

  const addMedia = () => {
    const el = mediaInputRef.current
    if (!el) return
    const parsed = el.value.split(/[\n,\s]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s))
    if (!parsed.length) return
    onMedia([...new Set([...media, ...parsed])])
    el.value = ''
  }

  const TOOLS: { icon: React.ReactNode; title: string; run: () => void }[] = [
    { icon: <Bold size={14} />, title: 'Жирный', run: () => fmt('**', '**') },
    { icon: <Italic size={14} />, title: 'Курсив', run: () => fmt('__', '__') },
    { icon: <Code size={14} />, title: 'Моноширинный', run: () => fmt('`', '`') },
    { icon: <Link2 size={14} />, title: 'Ссылка', run: () => fmt('[', '](https://)') },
  ]

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-white/50">{label}</span>
        <div className="flex items-center gap-1">
          {TOOLS.map((t) => (
            <button key={t.title} type="button" title={t.title} onClick={t.run}
              className="grid h-7 w-7 place-items-center rounded-md border border-line bg-elevated text-muted transition-colors hover:border-spark-500/40 hover:text-fg">
              {t.icon}
            </button>
          ))}
        </div>
      </div>
      <textarea
        ref={taRef}
        className="input"
        style={{ minHeight }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? 'Здравствуйте! …\n\n**жирный**, __курсив__, [ссылка](https://…)'}
      />
      <p className="mt-1 text-[11px] text-white/35">Форматирование Telegram: **жирный**, __курсив__, `код`, [текст](ссылка).</p>

      {/* Медиа и ссылки */}
      <div className="mt-3">
        <div className="mb-1 flex items-center gap-2 text-xs text-white/50">
          <ImageIcon size={13} /> Медиа и ссылки <span className="text-white/30">(фото/видео по URL, ссылки)</span>
        </div>
        <div className="flex gap-2">
          <input
            ref={mediaInputRef}
            className="input h-9 font-mono text-xs"
            placeholder="https://…jpg / …mp4 / любая ссылка"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addMedia() } }}
          />
          <button type="button" onClick={addMedia} className="btn-ghost h-9 shrink-0 text-sm"><Plus size={15} /> Добавить</button>
        </div>
        {media.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {media.map((url) => {
              const kind = mediaKind(url)
              return (
                <span key={url} className="group inline-flex items-center gap-1.5 rounded-lg border border-line bg-elevated/60 py-1 pl-1.5 pr-1 text-xs text-fg">
                  {kind === 'image' ? (
                    <img src={url} alt="" className="h-7 w-7 rounded object-cover" onError={(e) => { (e.currentTarget.style.display = 'none') }} />
                  ) : kind === 'video' ? (
                    <span className="grid h-7 w-7 place-items-center rounded bg-iris-500/15 text-iris-300"><Film size={14} /></span>
                  ) : (
                    <span className="grid h-7 w-7 place-items-center rounded bg-spark-500/15 text-spark-300"><Link2 size={14} /></span>
                  )}
                  <span className="max-w-[160px] truncate font-mono text-[11px] text-white/60">{url.replace(/^https?:\/\//, '')}</span>
                  <button type="button" onClick={() => onMedia(media.filter((m) => m !== url))} className="grid h-5 w-5 place-items-center rounded text-faint hover:bg-rose-500/12 hover:text-rose-300"><X size={12} /></button>
                </span>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
