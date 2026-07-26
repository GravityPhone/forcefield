/**
 * Storage for the admin AI chat (/admin/chat) — `ai_chats` + `ai_chat_messages`,
 * owner-only at the database (migration 20260726170000).
 *
 * All of it is plain client reads and writes: netlify/functions/chat.ts is
 * stateless across turns (the view posts the full history on every send), so
 * nothing server-side knows these tables exist.
 *
 * NOTE the `ai_` prefix. `chats` / `chat_messages` are the user-to-user chat
 * feature and have nothing to do with this.
 */

import { supabase } from './supabase'

export interface AiChatRow {
  id: string
  title: string
  updated_at: string
}

export interface AiChatMessageRow {
  seq: number
  role: 'user' | 'assistant'
  text: string
  /** Tool-trace chips. jsonb, so guard the shape on the way back in. */
  activity: string[] | null
  /** The three tap-to-send follow-ups. Stored apart from `text` because the
   * text we keep is the stripped one — see extractFollowups. */
  suggestions: string[] | null
}

/** A picker, not an archive. Fifty is further back than anyone scrolls and
 * well under PostgREST's silent 1000-row cap, so no paging machinery. */
const LIST_LIMIT = 50
const TITLE_MAX = 80

/** Chats are named after the question that started them — no second AI call
 * to write a title, which would spend a request against the admin's own key. */
export function titleFrom(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return 'New chat'
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…` : flat
}

export async function listChats(ownerId: string): Promise<AiChatRow[]> {
  const { data, error } = await supabase
    .from('ai_chats')
    .select('id, title, updated_at')
    .eq('owner_id', ownerId)
    .order('updated_at', { ascending: false })
    .limit(LIST_LIMIT)
  if (error) throw new Error(error.message)
  return (data ?? []) as AiChatRow[]
}

/** Every turn of one chat, in order. Uncapped on purpose: each turn costs a
 * real API call, so a conversation long enough to hit the 1000-row cap is not
 * a thing that happens. */
export async function loadMessages(chatId: string): Promise<AiChatMessageRow[]> {
  const { data, error } = await supabase
    .from('ai_chat_messages')
    .select('seq, role, text, activity, suggestions')
    .eq('chat_id', chatId)
    .order('seq')
  if (error) throw new Error(error.message)
  return (data ?? []).map((r) => {
    const row = r as AiChatMessageRow
    return {
      seq: row.seq,
      role: row.role,
      text: row.text,
      activity: Array.isArray(row.activity) ? row.activity : null,
      suggestions: Array.isArray(row.suggestions) ? row.suggestions : null,
    }
  })
}

export async function createChat(ownerId: string, title: string): Promise<string> {
  const { data, error } = await supabase
    .from('ai_chats')
    .insert({ owner_id: ownerId, title })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  return (data as { id: string }).id
}

export async function appendMessage(
  chatId: string,
  m: { seq: number; role: 'user' | 'assistant'; text: string; activity?: string[]; suggestions?: string[] },
): Promise<void> {
  const { error } = await supabase.from('ai_chat_messages').insert({
    chat_id: chatId,
    seq: m.seq,
    role: m.role,
    text: m.text,
    activity: m.activity?.length ? m.activity : null,
    suggestions: m.suggestions?.length ? m.suggestions : null,
  })
  if (error) throw new Error(error.message)
  // ai_chats.updated_at is bumped by a trigger, so the list re-sorts itself.
}

export async function renameChat(chatId: string, title: string): Promise<void> {
  const { error } = await supabase.from('ai_chats').update({ title }).eq('id', chatId)
  if (error) throw new Error(error.message)
}

export async function deleteChat(chatId: string): Promise<void> {
  const { error } = await supabase.from('ai_chats').delete().eq('id', chatId)
  if (error) throw new Error(error.message)
  // Messages go with it: ai_chat_messages.chat_id is ON DELETE CASCADE.
}

/** The stored half of the view's edit-and-re-run rewind: drop this message and
 * everything after it, so the next send branches from here. Without it, an
 * edited chat reloads with the abandoned branch still in it. */
export async function deleteFrom(chatId: string, seq: number): Promise<void> {
  const { error } = await supabase
    .from('ai_chat_messages')
    .delete()
    .eq('chat_id', chatId)
    .gte('seq', seq)
  if (error) throw new Error(error.message)
}
