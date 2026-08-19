/** MCP-дескриптор «Парсер по сообщениям». Основа общая — см. _parserParticipants.js. */
import { buildParticipantsParserDescriptor } from './_parserParticipants.js'

export default buildParticipantsParserDescriptor({
  key: 'parsing-messages',
  title: 'Parser by messages',
  tags: ['messages', 'messages', 'active', 'intention'],
  summary: 'Finds people by WHAT they wrote in groups: collects the authors of messages with the right words.',
  does: [
    'reads source messages to a specified depth by number and day',
    'selects authors of messages containing keywords',
    'discards too short remarks like “+” and “thank you”',
    'optionally saves the text itself that put the person on the list',
  ],
  examples: [
    {
      title: 'People with intent to buy',
      when: 'Not all participants are needed, but those who directly wrote about the need',
      input: {
        accountIds: ['acc_1'],
        channels: ['@some_chat'],
        keywords: ["I'll buy", 'looking for', 'please advise'],
        limits: { messages: 5000, days: 30, minCommentLen: 15 },
        filters: { skipBots: true, onlyUsername: true, keepText: true },
        resultLimit: 300,
        delayItem: 1,
        protectionLevel: 0,
      },
    },
  ],
})
