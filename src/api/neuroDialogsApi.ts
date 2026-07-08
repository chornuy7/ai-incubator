import { apiGet, apiPost } from './client'

export interface InboxDialog {
  key: string
  accountId: string
  accountName: string
  peerId: string
  accessHash?: string
  name: string
  username: string
  last: string
  time: string
  unread: number
  isBot?: boolean
  error?: boolean
}

export interface PeerRef {
  peerId: string
  accessHash?: string
  username?: string
}

function peerQuery(peer: PeerRef) {
  const q = new URLSearchParams()
  if (peer.accessHash) q.set('accessHash', peer.accessHash)
  if (peer.username) q.set('username', peer.username)
  const suffix = q.toString()
  return suffix ? `?${suffix}` : ''
}

export interface DialogMessage {
  id: number
  text: string
  time: string
  out: boolean
  date: number
}

export async function fetchInbox(accountIds: string[], limit = 100) {
  const q = new URLSearchParams({
    accountIds: accountIds.join(','),
    limit: String(limit),
  })
  return apiGet<{ ok: true; dialogs: InboxDialog[]; unread: number; total: number }>(
    `/api/neuro-dialogs/inbox?${q}`,
  )
}

export async function fetchMessages(
  accountId: string,
  peer: PeerRef,
  limit = 60,
  beforeId = 0,
) {
  const q = new URLSearchParams({ limit: String(limit) })
  if (beforeId > 0) q.set('beforeId', String(beforeId))
  if (peer.accessHash) q.set('accessHash', peer.accessHash)
  if (peer.username) q.set('username', peer.username)
  return apiGet<{ ok: true; messages: DialogMessage[]; hasMore: boolean; peerId: string }>(
    `/api/neuro-dialogs/${accountId}/messages/${peer.peerId}?${q}`,
  )
}

export async function sendDialogMessage(accountId: string, peer: PeerRef, text: string) {
  return apiPost<{ ok: true; message: DialogMessage }>(
    `/api/neuro-dialogs/${accountId}/messages/${peer.peerId}`,
    { text, accessHash: peer.accessHash, username: peer.username },
  )
}

export async function markDialogRead(accountId: string, peer: PeerRef) {
  return apiPost<{ ok: true }>(
    `/api/neuro-dialogs/${accountId}/read/${peer.peerId}${peerQuery(peer)}`,
  )
}
