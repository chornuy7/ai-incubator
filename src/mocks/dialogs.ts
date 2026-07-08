export interface DialogMsg {
  id: string
  from: 'them' | 'me'
  text: string
  time: string
  ai?: boolean
}

export interface Dialog {
  id: string
  name: string
  initials: string
  color: string
  last: string
  time: string
  unread: number
  account: string
  messages: DialogMsg[]
}

export const DIALOGS: Dialog[] = [
  {
    id: 'd1', name: 'Telegram', initials: 'T', color: '#229ED9',
    last: 'Код для входа в Telegram: 53504. Н…', time: 'вт', unread: 0, account: 'zubastik',
    messages: [
      { id: 'm1', from: 'them', text: 'Код для входа в Telegram: 53504. Никому не сообщайте этот код, даже если его требуют от имени Telegram!', time: 'вт 10:24' },
    ],
  },
  {
    id: 'd2', name: 'Annitha Bens', initials: 'AB', color: '#0ea5e9',
    last: 'Do you have some minutes for c…', time: 'чт', unread: 1, account: 'zubastik',
    messages: [
      { id: 'm1', from: 'them', text: 'Hi! Do you have some minutes for consultation about crypto investment?', time: 'чт 14:02' },
      { id: 'm2', from: 'me', text: 'Здравствуйте! Да, расскажите подробнее, чем могу помочь 🙂', time: 'чт 14:05', ai: true },
    ],
  },
  {
    id: 'd3', name: '资金来往请语音确认 阿超', initials: '资阿', color: '#ef4444',
    last: '还在接bc料吗? 兄弟', time: '14 июн.', unread: 1, account: 'zubastik',
    messages: [{ id: 'm1', from: 'them', text: '还在接bc料吗? 兄弟', time: '14 июн. 09:11' }],
  },
  {
    id: 'd4', name: '奥迪', initials: '奥', color: '#8b5cf6',
    last: 'bro你好👋请问一下你认识有可以…', time: '29 мая', unread: 1, account: 'zubastik',
    messages: [{ id: 'm1', from: 'them', text: 'bro你好👋请问一下你认识有可以帮忙的人吗', time: '29 мая 18:40' }],
  },
  {
    id: 'd5', name: 'Elin 🏝️ ZoeLog', initials: 'EZ', color: '#14b8a6',
    last: '首先问候一下妮~', time: '28 апр.', unread: 1, account: 'zubastik',
    messages: [{ id: 'm1', from: 'them', text: '首先问候一下妮~ 最近怎么样？', time: '28 апр. 12:00' }],
  },
  {
    id: 'd6', name: 'ID: 8422360538', initials: '?', color: '#64748b',
    last: 'Медиафайл', time: '11 мар.', unread: 1, account: 'zubastik',
    messages: [{ id: 'm1', from: 'them', text: '📎 Медиафайл', time: '11 мар. 20:15' }],
  },
  {
    id: 'd7', name: 'Marta Nelly', initials: 'MN', color: '#ec4899',
    last: 'Hi', time: '7 мар.', unread: 1, account: 'zubastik',
    messages: [
      { id: 'm1', from: 'them', text: 'Hi', time: '7 мар. 08:30' },
      { id: 'm2', from: 'me', text: 'Привет! Чем могу помочь?', time: '7 мар. 08:32', ai: true },
      { id: 'm3', from: 'them', text: 'I saw your channel, very interesting 😊', time: '7 мар. 08:40' },
    ],
  },
]
