import { Settings2 } from 'lucide-react'
import { SectionCard } from './index'
import { ProtectionBlock } from './ProtectionBlock'
import { TimingSection, type TimingSectionProps } from './TimingSection'

/**
 * «Защита и тайминги» — ОДИН блок на все модули (правка 19.08).
 *
 * До этого защита и задержки жили порознь: в нейромодулях двумя карточками, в мейлинге
 * защита с задержками внутри, в парсерах — «Настройки задержек» отдельной секцией, в
 * автопостинге под именем «Публикация и темп». Выглядело как четыре разные настройки,
 * хотя это одна: уровень защиты УМНОЖАЕТ задержки (`delayMultiplier`), FloodWait ведёт
 * в карантин, а пресет темпа — вторая ручка того же риска. Разные экраны для одного
 * решения — верный способ настроить его по-разному в двух модулях и не заметить.
 *
 * Компонент собирает карточку из трёх частей:
 *   1. уровень защиты (общий `ProtectionBlock`);
 *   2. `children` — то, что специфично модулю (уведомления, режимы, лимиты);
 *   3. тайминги (`TimingSection` в режиме `bare`, без своей карточки) — если переданы.
 */
export function ProtectionTimings({
  enabled, onEnabled, level, onLevel, badge, timing, children,
}: {
  enabled: boolean
  onEnabled: (v: boolean) => void
  level: number
  onLevel: (n: number) => void
  badge?: string
  /** Параметры таймингов. Не переданы — блок рисуется без них (парсеры со своими полями). */
  timing?: TimingSectionProps
  children?: React.ReactNode
}) {
  return (
    <SectionCard icon={<Settings2 size={18} />} title="Защита и тайминги" badge={badge}>
      <ProtectionBlock enabled={enabled} onEnabled={onEnabled} level={level} onLevel={onLevel} />
      {children}
      {timing && <TimingSection {...timing} bare />}
    </SectionCard>
  )
}
