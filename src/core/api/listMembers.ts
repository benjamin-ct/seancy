// Client des routes "listes communes" du Worker (voir worker/index.ts,
// handleGetListMembers/handlePostListMember/handleDeleteListMember/
// handleSearchInviteCandidates) — ticket Trello "Ma liste commune".
import { syncClientHeaders } from "../sync/liveSync.ts";

export interface ListMember {
  id: number;
  username: string | null;
  displayName: string | null;
}

export interface InviteCandidate {
  id: number;
  username: string;
  displayName: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

function membersPath(listId: string, ownerId?: number): string {
  const base = `/api/custom-lists/${encodeURIComponent(listId)}/members`;
  return ownerId ? `${base}?ownerId=${ownerId}` : base;
}

/** Membres d'une liste (la sienne, ou celle d'un propriétaire dont on est membre). */
export async function getListMembers(
  listId: string,
  ownerId?: number
): Promise<{ ownerId: number; members: ListMember[] }> {
  return request(membersPath(listId, ownerId));
}

/** Réservé au propriétaire : recherche par pseudo des comptes à inviter. */
export async function searchInviteCandidates(
  listId: string,
  query: string
): Promise<InviteCandidate[]> {
  const { candidates } = await request<{ candidates: InviteCandidate[] }>(
    `/api/custom-lists/${encodeURIComponent(listId)}/invite-search?q=${encodeURIComponent(query)}`
  );
  return candidates;
}

/** Réservé au propriétaire. */
export async function addListMember(listId: string, userId: number): Promise<ListMember[]> {
  const { members } = await request<{ members: ListMember[] }>(
    `/api/custom-lists/${encodeURIComponent(listId)}/members`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...syncClientHeaders() },
      body: JSON.stringify({ userId }),
    }
  );
  return members;
}

/** Réservé au propriétaire : retire un membre précis. */
export async function removeListMember(listId: string, memberId: number): Promise<void> {
  await request(`/api/custom-lists/${encodeURIComponent(listId)}/members/${memberId}`, {
    method: "DELETE",
    headers: syncClientHeaders(),
  });
}

/** Se retirer soi-même d'une liste commune (jamais le propriétaire). */
export async function leaveList(listId: string, ownerId: number): Promise<void> {
  await request(`/api/custom-lists/${encodeURIComponent(listId)}/leave?ownerId=${ownerId}`, {
    method: "DELETE",
    headers: syncClientHeaders(),
  });
}
