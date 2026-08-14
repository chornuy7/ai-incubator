/** MCP-дескриптор «Парсер пользователей». Основа общая — см. _parserParticipants.js. */
import { buildParticipantsParserDescriptor } from './_parserParticipants.js'

export default buildParticipantsParserDescriptor({
  key: 'parsing-users',
  title: 'Парсер пользователей',
  tags: ['участники', 'members', 'пересечение аудиторий'],
  summary: 'Собирает участников групп и каналов в базу с фильтрами по типу аккаунта.',
  does: [
    'вступает в источник, если аккаунт ещё не состоит в нём',
    'выгружает список участников и фильтрует его по заданным признакам',
    'умеет пересечение аудиторий: оставить только тех, кто состоит сразу в нескольких источниках',
    'убирает дубли между источниками',
  ],
  // Пересечение аудиторий реализовано ТОЛЬКО у этого парсера (`kind === 'parsing-users'`).
  supportsIntersection: true,
  examples: [
    {
      title: 'Живая аудитория одной группы',
      when: 'нужен список тех, кому можно написать',
      input: {
        accountIds: ['acc_1'],
        channels: ['@some_chat'],
        filters: { skipBots: true, skipDeleted: true, onlyUsername: true },
        limits: { participants: 2000 },
        resultLimit: 2000,
        protectionLevel: 1,
      },
    },
    {
      title: 'Ядро аудитории по пересечению',
      when: 'нужны те, кто сидит сразу в нескольких тематических чатах — это самая тёплая аудитория',
      input: {
        accountIds: ['acc_1', 'acc_2'],
        channels: ['@chat_one', '@chat_two', '@chat_three'],
        intersectionMode: true,
        intersectionMin: 2,
        filters: { skipBots: true, onlyUsername: true, onlyPremium: false },
        delayChat: 30,
        protectionLevel: 0,
      },
    },
  ],
})
