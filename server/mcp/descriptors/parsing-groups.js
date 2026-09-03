/** MCP-дескриптор «Парсер групп». Основа общая с парсером каналов — см. _parserChannels.js. */
import { buildChannelParserDescriptor } from './_parserChannels.js'

export default buildChannelParserDescriptor({
  key: 'parsing-groups',
  // ИИ не участвует: генерации нет, токены модели не тратятся (см. costModel).
  usesAi: false,
  title: 'Group parser',
  what: 'groups',
  whatMany: 'groups',
})
