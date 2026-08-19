/** MCP-дескриптор «Парсер пользователей». Основа общая — см. _parserParticipants.js. */
import { buildParticipantsParserDescriptor } from './_parserParticipants.js'

export default buildParticipantsParserDescriptor({
  key: 'parsing-users',
  title: 'User parser',
  tags: ['participants', 'members', 'intersection of audiences'],
  summary: 'Collects group and channel members into a database with filters by account type.',
  does: [
    'joins the source if the account is not already a member of it',
    'uploads a list of participants and filters it according to specified criteria',
    'knows how to cross audiences: leave only those who are members of several sources at once',
    'removes duplicates between sources',
  ],
  // Пересечение аудиторий реализовано ТОЛЬКО у этого парсера (`kind === 'parsing-users'`).
  supportsIntersection: true,
  examples: [
    {
      title: 'Live audience of one group',
      when: 'I need a list of people to write to',
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
      title: 'Core audience by intersection',
      when: 'We need those who sit in several thematic chats at once - this is the warmest audience',
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
