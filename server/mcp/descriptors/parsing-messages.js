/** MCP-дескриптор «Парсер по сообщениям». Основа общая — см. _parserParticipants.js. */
import { buildParticipantsParserDescriptor } from './_parserParticipants.js'

export default buildParticipantsParserDescriptor({
  key: 'parsing-messages',
  title: 'Парсер по сообщениям',
  tags: ['сообщения', 'messages', 'активные', 'намерение'],
  summary: 'Находит людей по тому, ЧТО они писали в группах: собирает авторов сообщений с нужными словами.',
  does: [
    'читает сообщения источника на заданную глубину по числу и по дням',
    'отбирает авторов сообщений, содержащих ключевые слова',
    'отбрасывает слишком короткие реплики вроде «+» и «спасибо»',
    'по желанию сохраняет сам текст, по которому человек попал в список',
  ],
  examples: [
    {
      title: 'Люди с намерением купить',
      when: 'нужны не все участники, а те, кто прямо писал о потребности',
      input: {
        accountIds: ['acc_1'],
        channels: ['@some_chat'],
        keywords: ['куплю', 'ищу', 'посоветуйте'],
        limits: { messages: 5000, days: 30, minCommentLen: 15 },
        filters: { skipBots: true, onlyUsername: true, keepText: true },
        resultLimit: 300,
        delayItem: 1,
        protectionLevel: 0,
      },
    },
  ],
})
