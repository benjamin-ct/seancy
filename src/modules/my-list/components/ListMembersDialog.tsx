import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../../shared/components/index.ts";
import {
  addListMember,
  getListMembers,
  memberLabel,
  removeListMember,
  searchInviteCandidates,
  type InviteCandidate,
  type ListMember,
} from "../../../core/api/listMembers.ts";
import styles from "./ListMembersDialog.module.css";

interface ListMembersDialogProps {
  open: boolean;
  onClose: () => void;
  listId: string;
  listName: string;
  /** `undefined` = ma propre liste (je suis propriétaire, je peux inviter/
   * retirer qui je veux) ; sinon id du propriétaire réel (je suis membre, je
   * peux seulement consulter et quitter). */
  ownerId?: number;
  /** Appelé juste après avoir quitté la liste (ferme l'onglet, comme onDeleted). */
  onLeft?: () => void;
}

const MAX_MEMBERS = 10;
const SEARCH_MIN_LENGTH = 2;
const SEARCH_DEBOUNCE_MS = 300;

// Membres d'une liste perso devenue commune (ticket "Ma liste commune") :
// invitation par pseudo (propriétaire uniquement), retrait par le
// propriétaire ou par le membre lui-même ("quitter"). Même structure que
// ListShareDialog (modale desktop / feuille du bas mobile).
export default function ListMembersDialog({
  open,
  onClose,
  listId,
  listName,
  ownerId,
  onLeft,
}: ListMembersDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const isOwner = ownerId === undefined;
  const [members, setMembers] = useState<ListMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<InviteCandidate[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      setError(null);
      setQuery("");
      setCandidates([]);
      dialog.showModal();
      setLoading(true);
      getListMembers(listId, ownerId)
        .then(({ members: data }) => setMembers(data))
        .catch(() => setError(t("listMembers.loadError")))
        .finally(() => setLoading(false));
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, listId, ownerId, t]);

  const trimmedQuery = query.trim();
  useEffect(() => {
    if (!isOwner || trimmedQuery.length < SEARCH_MIN_LENGTH) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      searchInviteCandidates(listId, trimmedQuery)
        .then((data) => {
          if (!cancelled) {
            setCandidates(data);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setCandidates([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setSearching(false);
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isOwner, listId, trimmedQuery]);

  async function invite(candidate: InviteCandidate) {
    setBusyId(candidate.id);
    setError(null);
    try {
      const next = await addListMember(listId, candidate.id);
      setMembers(next);
      setCandidates((prev) => prev.filter((c) => c.id !== candidate.id));
      setQuery("");
    } catch {
      setError(t("listMembers.addError"));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(member: ListMember) {
    setBusyId(member.id);
    setError(null);
    try {
      await removeListMember(listId, member.id);
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
    } catch {
      setError(t("listMembers.removeError"));
    } finally {
      setBusyId(null);
    }
  }

  function leave() {
    onLeft?.();
    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="list-members-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      {open && (
        <div className={styles.content}>
          <span className={styles.sheetGrabber} aria-hidden />
          <div className={styles.head}>
            <div>
              <h2 id="list-members-title" className={styles.title}>
                {t("listMembers.title", { name: listName })}
              </h2>
              <p className={styles.subtitle}>
                {t(isOwner ? "listMembers.subtitleOwner" : "listMembers.subtitleMember")}
              </p>
            </div>
            <button
              type="button"
              className={styles.closeBtn}
              onClick={onClose}
              aria-label={t("listMembers.close")}
            >
              <Icon name="close" />
            </button>
          </div>

          <h3 className={styles.sectionTitle}>{t("listMembers.membersHeading")}</h3>
          {loading ? (
            <p className={styles.hint}>{t("common.loading")}</p>
          ) : members.length === 0 ? (
            <p className={styles.hint}>{t("listMembers.noMembers")}</p>
          ) : (
            <ul className={styles.memberList}>
              {members.map((member) => (
                <li key={member.id} className={styles.memberRow}>
                  <span className={styles.memberName}>{memberLabel(member)}</span>
                  {isOwner && (
                    <button
                      type="button"
                      className={styles.removeBtn}
                      onClick={() => remove(member)}
                      disabled={busyId === member.id}
                    >
                      <Icon name="ban" /> {t("listMembers.removeButton")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {isOwner && (
            <>
              <h3 className={styles.sectionTitle}>{t("listMembers.inviteHeading")}</h3>
              {members.length >= MAX_MEMBERS ? (
                <p className={styles.hint}>{t("listMembers.maxReached", { max: MAX_MEMBERS })}</p>
              ) : (
                <>
                  <input
                    type="search"
                    className={styles.search}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("listMembers.invitePlaceholder")}
                    maxLength={15}
                    autoComplete="off"
                  />
                  {searching && <p className={styles.hint}>{t("common.loading")}</p>}
                  {!searching && trimmedQuery.length >= SEARCH_MIN_LENGTH && (
                    <ul className={styles.candidateList}>
                      {candidates.length === 0 ? (
                        <p className={styles.hint}>{t("listMembers.noResults")}</p>
                      ) : (
                        candidates.map((candidate) => (
                          <li key={candidate.id} className={styles.candidateRow}>
                            <span className={styles.memberName}>{memberLabel(candidate)}</span>
                            <button
                              type="button"
                              className={styles.addBtn}
                              onClick={() => invite(candidate)}
                              disabled={busyId === candidate.id}
                            >
                              <Icon name="plus" /> {t("listMembers.addButton")}
                            </button>
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </>
              )}
            </>
          )}

          {!isOwner && (
            <div className={styles.leaveZone}>
              <button type="button" className={styles.leaveBtn} onClick={leave}>
                <Icon name="ban" /> {t("listMembers.leaveButton")}
              </button>
            </div>
          )}

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </dialog>
  );
}
