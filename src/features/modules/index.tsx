import { MODULES } from '@/shared/config/modules'
import { LiveModule } from './LiveModule'
import { ChannelParserModule } from './ChannelParserModule'
import { ParticipantsParserModule } from './ParticipantsParserModule'
import { ParsingModeSwitch } from './ParsingModeSwitch'
import { NeuroDialogsModule } from '@/features/neuro-dialogs/NeuroDialogsModule'

/** Все модули панели с реальным API-бэкендом. */
const LIVE_KEYS = new Set(Object.keys(MODULES))

const PARTICIPANT_KEYS = new Set(['parsing-users', 'parsing-messages', 'parsing-comments'])

export function ModuleLiveRouter({ moduleKey }: { moduleKey: string }) {
  if (moduleKey === 'neuro-dialogs') return <NeuroDialogsModule />
  // «Парсер каналов»: два режима — прямой TG + TGStat.
  if (moduleKey === 'parsing') return <ParsingModeSwitch moduleKey={moduleKey} />
  // «Парсер групп»: только прямой поиск по ключевым словам.
  if (moduleKey === 'parsing-groups') return <ChannelParserModule moduleKey={moduleKey} />
  // Парсеры участников: пользователи / сообщения / комментарии.
  if (PARTICIPANT_KEYS.has(moduleKey)) return <ParticipantsParserModule moduleKey={moduleKey} />
  if (!LIVE_KEYS.has(moduleKey)) return null
  return <LiveModule moduleKey={moduleKey} />
}

export function isLiveModule(moduleKey: string) {
  return LIVE_KEYS.has(moduleKey)
}

export { LiveModule } from './LiveModule'
