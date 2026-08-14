/** MCP-дескриптор «Парсер групп». Основа общая с парсером каналов — см. _parserChannels.js. */
import { buildChannelParserDescriptor } from './_parserChannels.js'

export default buildChannelParserDescriptor({
  key: 'parsing-groups',
  title: 'Парсер групп',
  what: 'группы',
  whatMany: 'группы',
})
