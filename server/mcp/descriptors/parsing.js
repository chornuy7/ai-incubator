/** MCP-дескриптор «Парсинг каналов». Основа общая с парсером групп — см. _parserChannels.js. */
import { buildChannelParserDescriptor } from './_parserChannels.js'

export default buildChannelParserDescriptor({
  key: 'parsing',
  // ИИ не участвует: генерации нет, токены модели не тратятся (см. costModel).
  usesAi: false,
  title: 'Channel parsing',
  what: 'channels',
  whatMany: 'channels',
})
