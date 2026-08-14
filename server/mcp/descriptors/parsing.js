/** MCP-дескриптор «Парсинг каналов». Основа общая с парсером групп — см. _parserChannels.js. */
import { buildChannelParserDescriptor } from './_parserChannels.js'

export default buildChannelParserDescriptor({
  key: 'parsing',
  title: 'Парсинг каналов',
  what: 'каналы',
  whatMany: 'каналы',
})
