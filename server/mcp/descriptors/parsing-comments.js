/** MCP-дескриптор «Парсер комментариев». Основа общая — см. _parserParticipants.js. */
import { buildParticipantsParserDescriptor } from './_parserParticipants.js'

export default buildParticipantsParserDescriptor({
  key: 'parsing-comments',
  // ИИ не участвует: генерации нет, токены модели не тратятся (см. costModel).
  usesAi: false,
  title: 'Comment parser',
  tags: ['parsing', 'audience', 'comments', 'commenters', 'engaged users', 'lead list'],
  summary: 'Gathers people who comment on channel posts—the most involved part of the audience.',
  does: [
    'passes along the last posts of the channel to a given depth',
    'reads comments under each post and collects their authors',
    'filters by keywords and comment length',
  ],
  examples: [
    {
      title: 'Engaged channel audience',
      when: 'We don’t need subscribers, but those who actually write under posts',
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
