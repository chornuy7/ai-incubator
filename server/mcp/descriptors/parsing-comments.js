/** MCP-дескриптор «Парсер комментариев». Основа общая — см. _parserParticipants.js. */
import { buildParticipantsParserDescriptor } from './_parserParticipants.js'

export default buildParticipantsParserDescriptor({
  key: 'parsing-comments',
  title: 'Парсер комментариев',
  tags: ['комментарии', 'comments', 'вовлечённые'],
  summary: 'Собирает людей, комментирующих посты каналов, — самую вовлечённую часть аудитории.',
  does: [
    'проходит по последним постам канала на заданную глубину',
    'читает комментарии под каждым постом и собирает их авторов',
    'фильтрует по ключевым словам и длине комментария',
  ],
  examples: [
    {
      title: 'Вовлечённая аудитория канала',
      when: 'нужны не подписчики, а те, кто реально пишет под постами',
      input: {
        accountIds: ['acc_1'],
        channels: ['@some_channel'],
        limits: { posts: 50, commentsPerPost: 100, minCommentLen: 10 },
        filters: { skipBots: true, skipDeleted: true, onlyUsername: true },
        resultLimit: 1000,
        delayChat: 20,
        protectionLevel: 1,
      },
    },
  ],
})
