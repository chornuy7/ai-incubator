import { memo, useState } from 'react'
import { cn } from '@/shared/lib/utils'
import { dialogMediaUrl, type DialogMessage, type InboxDialog } from '@/api/neuroDialogsApi'

/**
 * §9.3/§8.7: ОБЩИЙ пузырь сообщения для всех экранов переписки.
 *
 * До этого «Обзор аккаунта» (`/panel/inbox`) и НейроДиалоги держали свои копии
 * разметки, и правки уезжали только в одну: обзор рендерил голый `m.text` и не
 * показывал превью, хотя бэкенд его уже отдавал. Теперь логика одна.
 *
 * Превью (§9.3) тянется из живой Telegram-сессии в момент показа и нигде не
 * хранится — поэтому это `<img src=…>`, а не данные в ответе со списком сообщений.
 */
export const ConversationBubble = memo(function ConversationBubble({
  m, dialog, tone = 'iris',
}: {
  m: DialogMessage
  dialog: InboxDialog | null
  /** Палитра исходящего пузыря — у экранов исторически разная, ломать не стали. */
  tone?: 'iris' | 'spark'
}) {
  // Превью может не отдаться (файл, голосовое, истёкшая сессия) — тогда прячем
  // картинку и оставляем текстовую пометку вида «📷 Фото».
  const [thumbFailed, setThumbFailed] = useState(false)
  const thumbUrl = m.hasThumb && dialog && !thumbFailed
    ? dialogMediaUrl(dialog.accountId, dialog.peerId, m.id, { accessHash: dialog.accessHash, username: dialog.username })
    : null

  return (
    <div className={cn('flex', m.out ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[78%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
          m.out
            ? tone === 'spark' ? 'bg-spark-500/20 text-white' : 'bg-iris-gradient text-white'
            : tone === 'spark' ? 'bg-white/10 text-white/90' : 'border border-line bg-surface text-fg',
        )}
      >
        {thumbUrl && (
          <img
            src={thumbUrl}
            alt={m.media === 'video' ? 'Превью видео' : 'Превью изображения'}
            loading="lazy"
            onError={() => setThumbFailed(true)}
            className="mb-1.5 max-h-52 w-full rounded-xl object-cover"
          />
        )}
        <span className="whitespace-pre-wrap break-words">{m.text}</span>
        <span className={cn('mt-1 block text-[10px]', m.out ? 'text-white/70' : 'text-faint')}>{m.time}</span>
      </div>
    </div>
  )
})
