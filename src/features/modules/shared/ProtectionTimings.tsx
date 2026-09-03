import { Settings2 } from 'lucide-react'
import { SectionCard } from './index'
import { TimingSection, type TimingSectionProps } from './TimingSection'

/**
 * «Защита и тайминги» — одна карточка на все модули (правка 19.08).
 *
 * Внутри — ряд пресетов (Агрессивный / Сбалансированный / Консервативный / Custom),
 * расчёт полного времени, «Расширенные настройки» с точными задержками и модуль-
 * специфичные поля (`children`).
 *
 * Чего здесь БОЛЬШЕ НЕТ и почему:
 *  - три карточки уровней защиты. Это был тот же выбор темпа, записанный вторым рядом и
 *    в обратном порядке; хуже того, сервер перемножал оба множителя
 *    (`delayMultiplier` = LEVEL_MUL × PRESET_MUL), и «консервативный» в двух рядах давал
 *    ×3.24 вместо ×1.8. Теперь темп задаёт ОДИН ряд — пресет задержек;
 *  - строка-переключатель «Защита аккаунтов» (решение владельца 19.08). Сама защита
 *    работает как работала: FloodWait → пауза → карантин, пропуск quarantine/spamblock/
 *    frozen. В задачу по-прежнему уходит `aiProtection`, просто выключателя на экране нет.
 */
export function ProtectionTimings({
  badge, timing, children,
}: {
  badge?: string
  /** Параметры таймингов. Не переданы — карточка рисует только `children` (парсеры). */
  timing?: TimingSectionProps
  children?: React.ReactNode
}) {
  return (
    <SectionCard icon={<Settings2 size={18} />} title="Защита и тайминги" badge={badge}>
      {timing && <TimingSection {...timing} bare part="delays" />}
      {children}
    </SectionCard>
  )
}
