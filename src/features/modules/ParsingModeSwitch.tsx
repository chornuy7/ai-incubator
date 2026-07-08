import { useState } from 'react'
import { Radar, Cookie } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { ChannelParserModule } from './ChannelParserModule'
import { TgStatParserModule } from './TgStatParserModule'

/**
 * Страница «Парсер каналов» с двумя режимами:
 *  1. Прямой парсер каналов TG (через аккаунты, зелёный).
 *  2. Парсер каналов TGStat (через cookies-сессию, жёлтый/амбер-блок).
 */
export function ParsingModeSwitch({ moduleKey }: { moduleKey: string }) {
  const [mode, setMode] = useState<'direct' | 'tgstat'>('direct')

  return (
    <div className="space-y-4">
      <div className="grid gap-2 rounded-2xl border border-line bg-surface p-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setMode('direct')}
          className={cn(
            'flex items-center gap-3 rounded-xl border p-3 text-left transition-all',
            mode === 'direct' ? 'border-spark-500/50 bg-spark-500/10' : 'border-line bg-elevated hover:border-spark-500/30',
          )}
        >
          <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', mode === 'direct' ? 'bg-spark-500/20 text-spark-300' : 'bg-elevated text-muted')}><Radar size={20} /></span>
          <span className="min-w-0">
            <span className={cn('block text-sm font-bold', mode === 'direct' ? 'text-fg' : 'text-muted')}>Прямой парсер каналов TG</span>
            <span className="block text-[11px] text-muted">Поиск по ключевым словам через ваши Telegram-аккаунты</span>
          </span>
        </button>

        <button
          type="button"
          onClick={() => setMode('tgstat')}
          className={cn(
            'flex items-center gap-3 rounded-xl border p-3 text-left transition-all',
            mode === 'tgstat' ? 'border-amber-500/60 bg-amber-500/12' : 'border-amber-500/25 bg-amber-500/5 hover:border-amber-500/40',
          )}
        >
          <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', mode === 'tgstat' ? 'bg-amber-500/25 text-amber-200' : 'bg-amber-500/10 text-amber-300')}><Cookie size={20} /></span>
          <span className="min-w-0">
            <span className={cn('block text-sm font-bold', mode === 'tgstat' ? 'text-amber-100' : 'text-amber-300')}>Парсер каналов TGStat</span>
            <span className="block text-[11px] text-muted">Массовый парсинг каталога TGStat по категориям (cookies-сессия)</span>
          </span>
        </button>
      </div>

      {mode === 'direct' ? <ChannelParserModule moduleKey={moduleKey} /> : <TgStatParserModule />}
    </div>
  )
}
