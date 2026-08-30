/**
 * Запрос сотрудника своему владельцу (MR-257).
 *
 * Заказчик 30.08: «в поддержке тебе скажут: свяжитесь с администратором. А нахера мне этот
 * круг?» Раньше у сотрудника был единственный канал — платформенная поддержка, то есть мы.
 * А просит он всегда одно и то же и всегда у владельца: токены, аккаунт, снять ограничение.
 *
 * Один компонент на все случаи: механика везде одна — нажал, написал сумму или пару слов,
 * владелец получил обращение внутри системы. Три отдельные кнопки в трёх местах означали бы
 * три разных поведения и три места, где чинить.
 *
 * Адресата выбирает СЕРВЕР по родителю сотрудника: клиент его не передаёт, иначе можно было
 * бы написать «в поддержку» чужому владельцу.
 */
import { useState } from 'react'
import { Send, X } from 'lucide-react'
import { Modal } from '@/shared/ui'
import { createTicket } from '@/api/ticketsApi'
import { useApp } from '@/mocks/store'

export type RequestKind = 'tokens' | 'accounts' | 'access'

const ТЕКСТЫ: Record<RequestKind, { title: string; subject: string; hint: string; placeholder: string; withAmount: boolean }> = {
  tokens: {
    title: 'Запросить токены у администратора',
    subject: 'Запрос токенов',
    hint: 'Токены выдаёт владелец пространства — они списываются с его баланса и появляются у вас.',
    placeholder: 'Для чего нужны: например, добить кампанию до конца недели',
    withAmount: true,
  },
  accounts: {
    title: 'Запросить аккаунт у администратора',
    subject: 'Запрос аккаунтов',
    hint: 'Аккаунты заводит владелец пространства и выдаёт их вам — сами вы их не добавляете.',
    placeholder: 'Сколько нужно и для чего: например, два аккаунта под комментинг',
    withAmount: true,
  },
  access: {
    title: 'Связаться с администратором',
    subject: 'Запрос доступа',
    hint: 'Это ограничение выставил владелец вашего пространства, а не платформа — снять его может только он.',
    placeholder: 'Что нужно открыть и зачем',
    withAmount: false,
  },
}

export function RequestToOwnerModal({ kind, open, onClose }: { kind: RequestKind; open: boolean; onClose: () => void }) {
  const т = ТЕКСТЫ[kind]
  const [amount, setAmount] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const pushToast = useApp((s) => s.pushToast)

  const send = async () => {
    setBusy(true)
    try {
      // Сумма и причина уходят одним текстом: владельцу нужно видеть просьбу целиком,
      // а не собирать её из полей карточки.
      const строки = [
        т.withAmount && amount.trim() ? `Сколько: ${amount.trim()}` : '',
        text.trim(),
      ].filter(Boolean)
      await createTicket({ subject: т.subject, category: `request-${kind}`, body: строки.join('\n') || т.subject })
      pushToast({ type: 'success', title: 'Запрос отправлен администратору', desc: 'Ответ придёт в «Поддержку» — там же переписка.' })
      setAmount(''); setText('')
      onClose()
    } catch (e) {
      pushToast({ type: 'error', title: 'Не удалось отправить', desc: e instanceof Error ? e.message : '' })
    } finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={т.title} icon={<Send size={20} />}>
      <p className="mb-3 text-xs leading-relaxed text-muted">{т.hint}</p>
      {т.withAmount && (
        <div className="mb-3">
          <label className="label">Сколько нужно</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} className="input" placeholder={kind === 'tokens' ? 'например, 100 ⚡' : 'например, 2 аккаунта'} />
        </div>
      )}
      <label className="label">Комментарий</label>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="input resize-none" placeholder={т.placeholder} />
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="btn-ghost h-10"><X size={16} /> Отмена</button>
        <button onClick={() => void send()} disabled={busy} className="btn-primary h-10 disabled:opacity-40">
          <Send size={16} /> {busy ? 'Отправляем…' : 'Отправить администратору'}
        </button>
      </div>
    </Modal>
  )
}
