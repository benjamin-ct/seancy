import { useEffect, useState, type ClipboardEvent } from "react";
import {
  deleteFile,
  deleteTicket,
  editTicket,
  fileUrl,
  moveTicket,
  ticketAction,
  uploadFile,
  type Effort,
  type Ticket,
} from "./api.ts";
import {
  EFFORT_NAMES,
  STEPS,
  ago,
  columnName,
  day,
  fresh,
  lines,
  modelName,
  prNumber,
  stepOf,
  when,
} from "./board.ts";
import styles from "./TicketsPage.module.css";

export type ReplyMode = "retouch" | "follow" | "reopen";
export type Run = (
  job: () => Promise<unknown>,
  ok: string | ((r: unknown) => string)
) => Promise<boolean>;
export type Ask = (text: string, okLabel: string, job: () => void) => void;

interface SheetProps {
  ticket: Ticket;
  mode: ReplyMode | "";
  run: Run;
  ask: Ask;
  onClose: () => void;
}

const BOX: Record<ReplyMode, { placeholder: string; label: string; send: string }> = {
  retouch: {
    placeholder: "Répondre à Claude : ce qu'il faut changer…",
    label: "Retouche",
    send: "Envoyer la retouche",
  },
  follow: {
    placeholder: "Après la fusion, dire à Claude… (ex. : fais aussi la version mobile)",
    label: "Commentaire",
    send: "Valider et envoyer",
  },
  reopen: {
    placeholder: "Écrire à Claude pour rouvrir le ticket…",
    label: "Réouverture",
    send: "Rouvrir",
  },
};
const EVENTS: Record<string, string> = {
  envoi: "Envoyé à Claude",
  relance: "Renvoyé à Claude",
  annule: "Envoi annulé",
  file: "Validé : en file pour la fusion",
  valide: "Validé, PR fusionnée",
};
const ACCEPT = "image/*,video/mp4,video/quicktime,video/webm,application/pdf";

function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)»<]+[^\s).,»<])/g);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer">
            {p}
          </a>
        ) : (
          p
        )
      )}
    </>
  );
}
function Text({ text }: { text: string }) {
  return (
    <div className={styles.text}>
      {lines(text).map((l, i) =>
        l.trim() ? (
          <p
            key={i}
            className={
              /^\s*[-•*]\s/.test(l)
                ? styles.bullet
                : /^[^:]{2,40} :$/.test(l.trim())
                  ? styles.subhead
                  : ""
            }
          >
            <Linkified text={l.replace(/^\s*[-•*]\s+/, "")} />
          </p>
        ) : (
          <br key={i} />
        )
      )}
    </div>
  );
}

function Progress({ t, run, ask }: { t: Ticket; run: Run; ask: Ask }) {
  const live = fresh(t);
  const relaunch = () =>
    ask(`Relancer « ${t.title} » chez Claude ?`, "Relancer", () =>
      run(() => ticketAction(t.id, "send"), "Ticket relancé")
    );
  if (live && t.stage === "fail") {
    return (
      <div className={`${styles.prog} ${styles.progFail}`} role="status">
        <b>Arrêté</b>
        <p>
          <Linkified text={t.progress || "Le travail de Claude s'est arrêté sur une erreur."} />
        </p>
        <div className={styles.row}>
          {t.run && (
            <a href={t.run} target="_blank" rel="noopener noreferrer">
              Voir l'erreur sur GitHub
            </a>
          )}
          <button type="button" className={styles.primary} onClick={relaunch}>
            Relancer
          </button>
        </div>
      </div>
    );
  }
  if (live && t.stage === "quota") {
    const at = new Date(t.progressAt + 3600_000).toLocaleTimeString("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Paris",
    });
    return (
      <div className={`${styles.prog} ${styles.progWait}`} role="status">
        <b>En pause</b>
        <p>Quota de Claude atteint : relance automatique vers {at}, toute seule.</p>
        <div className={styles.row}>
          {t.run && (
            <a href={t.run} target="_blank" rel="noopener noreferrer">
              Voir sur GitHub
            </a>
          )}
          <button type="button" className={styles.btn} onClick={relaunch}>
            Relancer maintenant
          </button>
        </div>
      </div>
    );
  }
  const cur = stepOf(t);
  const late = !live && t.sent && Date.now() - t.sent > 5 * 60_000;
  const msg = live
    ? t.progress
    : late
      ? "Toujours pas démarré sur GitHub : vérifie le workflow « Tickets (Claude) » et ses secrets"
      : "En attente du démarrage sur GitHub…";
  return (
    <div className={styles.prog}>
      <ol className={styles.steps} aria-label="Avancement">
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={i < cur ? styles.stepOk : i === cur ? styles.stepOn : ""}
            aria-current={i === cur ? "step" : undefined}
          >
            {s}
          </li>
        ))}
      </ol>
      <p className={styles.progText}>
        <Linkified text={msg} />
        {live && <small> · {ago(t.progressAt)}</small>}
      </p>
      {t.run && (
        <a href={t.run} target="_blank" rel="noopener noreferrer">
          Suivre sur GitHub
        </a>
      )}
    </div>
  );
}

export default function TicketSheet({
  ticket: t,
  mode: initialMode,
  run,
  ask,
  onClose,
}: SheetProps) {
  const editable = t.status === "idea" || t.status === "todo";
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const [detail, setDetail] = useState(t.detail);
  const [mode, setMode] = useState<ReplyMode | "">(
    initialMode || (t.status === "review" ? "retouch" : t.status === "done" ? "reopen" : "")
  );
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const [link, setLink] = useState<{ url: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!editing) {
      setTitle(t.title);
      setDetail(t.detail);
    }
  }, [t.title, t.detail, editing]);

  const go = async (job: () => Promise<unknown>, ok: string | ((r: unknown) => string)) => {
    setBusy(true);
    const done = await run(job, ok);
    setBusy(false);
    return done;
  };
  const upload = async (files: File[]) => {
    if (files.length) {
      await go(
        async () => {
          for (const f of files) {
            await uploadFile(t.id, f);
          }
        },
        files.length > 1 ? `${files.length} fichiers ajoutés` : "Fichier ajouté"
      );
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => /^image\//.test(f.type));
    if (files.length) {
      e.preventDefault();
      void upload(files);
    }
  };
  const send = () =>
    ask(
      `Envoyer « ${t.title} » à Claude (${modelName(t.model)}, effort ${EFFORT_NAMES[t.effort].toLowerCase()}${t.urgent ? ", hotfix depuis main" : ""}) ?`,
      "Envoyer",
      () => go(() => ticketAction(t.id, "send"), "Envoyé à Claude")
    );
  const validate = () =>
    ask(
      `Fusionner la PR de « ${t.title} » dans ${t.urgent ? "main (puis main dans develop)" : "develop"} ?`,
      "Valider",
      () =>
        go(
          () => ticketAction(t.id, "validate"),
          (r) =>
            (r as { queued?: boolean })?.queued
              ? "Validé : fusion automatique dès que la CI est passée"
              : "Ticket validé : PR fusionnée"
        )
    );
  const sendReply = () => {
    const text = reply.trim();
    if (!text || !mode) {
      return;
    }
    const job = async () => {
      const r = await ticketAction(t.id, mode === "follow" ? "validate" : mode, text);
      setReply("");
      return r;
    };
    const ok =
      mode === "reopen"
        ? "Ticket rouvert : Claude repart dessus avec une nouvelle PR"
        : mode === "follow"
          ? "Validé : ton commentaire part chez Claude après la fusion"
          : "Retouche envoyée : Claude reprend le ticket";
    if (mode === "follow") {
      ask(
        "Fusionner la PR, puis envoyer ton commentaire à Claude pour la suite ?",
        "Valider et envoyer",
        () => go(job, ok)
      );
    } else {
      void go(job, ok);
    }
  };

  const prNo = prNumber(t.pr);
  const desc = lines(t.detail);
  const long = desc.length > 10 || t.detail.length > 900;
  const head = [
    t.status === "idea" ? "Idée" : "Ticket",
    columnName(t.status),
    t.status === "done" ? `fait le ${day(t.doneAt)}` : "",
  ].filter(Boolean);

  const actions = (
    <div className={styles.acts}>
      {t.status === "idea" && (
        <>
          <button
            type="button"
            className={styles.primary}
            disabled={busy}
            onClick={() => go(() => moveTicket(t.id, "todo", ""), "Idée passée dans « À faire »")}
          >
            En faire un ticket
          </button>
          <button type="button" className={styles.btn} disabled={busy} onClick={send}>
            Envoyer à Claude
          </button>
        </>
      )}
      {t.status === "todo" && (
        <>
          <button type="button" className={styles.primary} disabled={busy} onClick={send}>
            Envoyer à Claude
          </button>
          <button
            type="button"
            className={styles.btn}
            disabled={busy}
            onClick={() => go(() => moveTicket(t.id, "idea", ""), "Remis dans les idées")}
          >
            Remettre en idée
          </button>
        </>
      )}
      {editable && !editing && (
        <button type="button" className={styles.btn} onClick={() => setEditing(true)}>
          Modifier
        </button>
      )}
      {t.status === "work" && (
        <button
          type="button"
          className={styles.btn}
          disabled={busy}
          onClick={() =>
            ask(
              "Annuler l'envoi ? Le ticket revient dans « À faire ». Si Claude a déjà commencé sur GitHub, il peut finir et répondre quand même.",
              "Annuler l'envoi",
              () =>
                go(
                  () => ticketAction(t.id, "unsend"),
                  "Envoi annulé : ticket revenu dans « À faire »"
                )
            )
          }
        >
          Annuler l'envoi
        </button>
      )}
      {t.status === "review" && !t.queued && (
        <>
          <button type="button" className={styles.primary} disabled={busy} onClick={validate}>
            Valider et fusionner
          </button>
          <button type="button" className={styles.btn} onClick={() => setMode("follow")}>
            Valider et commenter
          </button>
          <button type="button" className={styles.btn} onClick={() => setMode("retouch")}>
            Retouche
          </button>
        </>
      )}
      {t.status === "review" && /^https:\/\//.test(t.preview) && (
        <a className={styles.btn} href={t.preview} target="_blank" rel="noopener noreferrer">
          Preview
        </a>
      )}
      {t.pr && (
        <a className={styles.btn} href={t.pr} target="_blank" rel="noopener noreferrer">
          PR{prNo ? ` #${prNo}` : ""}
        </a>
      )}
    </div>
  );

  const settings = t.status !== "done" && (
    <section className={styles.sec}>
      <h3>{editable ? "Réglages" : "Réglages · prochain passage de Claude"}</h3>
      <div className={styles.settings}>
        <label>
          Modèle
          <select
            value={t.model}
            disabled={busy}
            onChange={(e) =>
              go(
                () => editTicket(t.id, { model: e.target.value as Ticket["model"] }),
                "Modèle enregistré"
              )
            }
          >
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
          </select>
        </label>
        <label>
          Effort
          <select
            value={t.effort}
            disabled={busy}
            onChange={(e) =>
              go(() => editTicket(t.id, { effort: e.target.value as Effort }), "Effort enregistré")
            }
          >
            {(["low", "medium", "high", "xhigh", "max"] as const).map((v) => (
              <option key={v} value={v}>
                {EFFORT_NAMES[v]}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={t.urgent}
            disabled={busy || !editable}
            onChange={(e) =>
              go(
                () => editTicket(t.id, { urgent: e.target.checked }),
                e.target.checked ? "Hotfix : oui" : "Hotfix : non"
              )
            }
          />
          <span>
            <b>Hotfix</b>{" "}
            <span className={styles.muted}>
              bug urgent en prod : branche depuis main, PR vers main, puis main refusionné dans
              develop
            </span>
          </span>
        </label>
      </div>
    </section>
  );

  const description = (
    <section className={styles.sec}>
      <h3>Description</h3>
      {editing ? (
        <div className={styles.form}>
          <label>
            Titre
            <input
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </label>
          <label>
            Description
            <textarea value={detail} rows={8} onChange={(e) => setDetail(e.target.value)} />
          </label>
          <div className={styles.row}>
            <button
              type="button"
              className={styles.primary}
              disabled={busy || !title.trim()}
              onClick={async () => {
                if (
                  await go(() => editTicket(t.id, { title: title.trim(), detail }), "Enregistré")
                ) {
                  setEditing(false);
                }
              }}
            >
              Enregistrer
            </button>
            <button type="button" className={styles.link} onClick={() => setEditing(false)}>
              Annuler
            </button>
          </div>
        </div>
      ) : desc.length ? (
        <>
          <div className={long && !showAll ? styles.clip : ""}>
            <Text text={t.detail} />
          </div>
          {long && (
            <button
              type="button"
              className={styles.link}
              aria-expanded={showAll}
              onClick={() => setShowAll(!showAll)}
            >
              {showAll ? "Replier" : "Voir tout"}
            </button>
          )}
        </>
      ) : (
        <p className={styles.muted}>Pas de description.</p>
      )}
    </section>
  );

  const attachments = (
    <section className={styles.sec}>
      <h3>
        Pièces jointes{" "}
        {t.files.length + t.links.length > 0 && <small>{t.files.length + t.links.length}</small>}
      </h3>
      {t.files.length > 0 && (
        <div className={styles.files}>
          {t.files.map((f) => (
            <span key={f.id} className={styles.file}>
              <a href={fileUrl(f)} target="_blank" rel="noopener noreferrer">
                {/^image\//.test(f.type) ? (
                  <img src={fileUrl(f)} alt={f.name} loading="lazy" />
                ) : (
                  <span>{f.name}</span>
                )}
              </a>
              {editable && (
                <button
                  type="button"
                  aria-label={`Retirer ${f.name}`}
                  onClick={() =>
                    ask(`Retirer ${f.name} ?`, "Retirer", () =>
                      go(() => deleteFile(t.id, f.id), "Fichier retiré")
                    )
                  }
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {t.links.length > 0 && (
        <ul className={styles.links}>
          {t.links.map((l) => (
            <li key={l.url}>
              <a href={l.url} target="_blank" rel="noopener noreferrer">
                {l.title || l.url.replace(/^https?:\/\/(www\.)?/, "")}
              </a>
            </li>
          ))}
        </ul>
      )}
      {link ? (
        <div className={styles.row}>
          <input
            placeholder="https://…"
            value={link.url}
            aria-label="Adresse du lien"
            onChange={(e) => setLink({ ...link, url: e.target.value })}
            autoFocus
          />
          <input
            placeholder="Titre (facultatif)"
            value={link.title}
            aria-label="Titre du lien"
            onChange={(e) => setLink({ ...link, title: e.target.value })}
          />
          <button
            type="button"
            className={styles.btn}
            disabled={!/^https?:\/\/\S+$/.test(link.url.trim())}
            onClick={async () => {
              if (
                await go(
                  () =>
                    editTicket(t.id, {
                      links: [...t.links, { url: link.url.trim(), title: link.title.trim() }],
                    }),
                  "Lien ajouté"
                )
              ) {
                setLink(null);
              }
            }}
          >
            Ajouter
          </button>
          <button type="button" className={styles.link} onClick={() => setLink(null)}>
            Annuler
          </button>
        </div>
      ) : (
        <div className={styles.row}>
          <label className={styles.btn}>
            Photos, vidéos
            <input
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                void upload(files);
              }}
            />
          </label>
          <button
            type="button"
            className={styles.btn}
            onClick={() => setLink({ url: "", title: "" })}
          >
            Lien
          </button>
          <span className={styles.hint}>ou colle une capture ici</span>
        </div>
      )}
    </section>
  );

  const trello = t.trello && (
    <section className={styles.sec}>
      <h3>Carte Trello d'origine</h3>
      <p className={styles.muted}>
        Liste « {t.trello.list} »
        {t.trello.url && (
          <>
            {" · "}
            <a href={t.trello.url} target="_blank" rel="noopener noreferrer">
              ouvrir sur Trello
            </a>
          </>
        )}
      </p>
      {t.trello.comments.length > 0 && (
        <details className={styles.more}>
          <summary>
            {t.trello.comments.length} commentaire{t.trello.comments.length > 1 ? "s" : ""}
          </summary>
          <ol className={styles.hist}>
            {t.trello.comments.map((c, i) => (
              <li
                key={i}
                className={`${styles.bubble} ${/^🤖/.test(c.text) ? styles.claude : styles.me}`}
              >
                <b>
                  {c.author || "Trello"} <small>{when(c.at)}</small>
                </b>
                <Text text={c.text} />
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );

  const history = (t.history.length > 0 || t.status !== "idea") && (
    <section className={styles.sec}>
      <h3>Historique</h3>
      <ol className={styles.hist}>
        {t.history.map((e, i) => {
          const n = prNumber(e.pr ?? "");
          const pr = n && e.pr && (
            <a href={e.pr} target="_blank" rel="noopener noreferrer">
              {" "}
              PR #{n}
            </a>
          );
          if (e.kind === "reponse") {
            const last = t.history.map((x) => x.kind).lastIndexOf("reponse") === i;
            return (
              <li key={i} className={`${styles.bubble} ${styles.claude}`}>
                <b>
                  Claude <small>{when(e.at)}</small>
                </b>
                <Text text={e.text ?? ""} />
                {pr && <p>{pr}</p>}
                {last && t.notes && (
                  <details className={styles.more}>
                    <summary>Notes de travail de Claude</summary>
                    <Text text={t.notes} />
                  </details>
                )}
              </li>
            );
          }
          if (e.kind === "message") {
            return (
              <li
                key={i}
                className={`${styles.bubble} ${e.who === "auto" ? styles.auto : styles.me}`}
              >
                <b>
                  {e.who === "auto" ? "Validation automatique" : "Toi"} <small>{when(e.at)}</small>
                </b>
                <Text text={e.text ?? ""} />
              </li>
            );
          }
          if (e.kind === "arret") {
            return (
              <li key={i} className={`${styles.event} ${styles.bad}`}>
                Arrêté{e.text ? ` : ${e.text}` : ""} · {when(e.at)}
              </li>
            );
          }
          return (
            <li key={i} className={`${styles.event} ${e.kind === "valide" ? styles.good : ""}`}>
              {EVENTS[e.kind] ?? e.kind} · {when(e.at)}
              {pr}
            </li>
          );
        })}
        {!t.history.length && <li className={styles.event}>Pas encore envoyé à Claude</li>}
      </ol>
    </section>
  );

  const replyBox =
    mode && (t.status === "review" || (t.status === "done" && mode === "reopen")) ? (
      <div className={styles.reply}>
        {t.status === "review" && !t.queued && (
          <div className={styles.segs} role="group" aria-label="Type de réponse">
            {(["retouch", "follow"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                className={styles.seg}
                onClick={() => setMode(m)}
              >
                {BOX[m].label}
              </button>
            ))}
          </div>
        )}
        <textarea
          rows={3}
          value={reply}
          placeholder={BOX[mode].placeholder}
          aria-label={BOX[mode].label}
          onChange={(e) => setReply(e.target.value)}
        />
        <div className={styles.row}>
          <button
            type="button"
            className={reply.trim() ? styles.primary : styles.btn}
            disabled={busy || !reply.trim()}
            onClick={sendReply}
          >
            {BOX[mode].send}
          </button>
        </div>
      </div>
    ) : editable ? (
      <div className={styles.reply}>
        <textarea
          rows={2}
          value={note}
          placeholder="Ajouter une note à la description…"
          aria-label="Note"
          onChange={(e) => setNote(e.target.value)}
        />
        <div className={styles.row}>
          <button
            type="button"
            className={styles.btn}
            disabled={busy || !note.trim()}
            onClick={async () => {
              const stamp = new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });
              if (
                await go(
                  () =>
                    editTicket(t.id, {
                      detail: [t.detail.trimEnd(), `Note du ${stamp} : ${note.trim()}`]
                        .filter(Boolean)
                        .join("\n"),
                    }),
                  "Note ajoutée"
                )
              ) {
                setNote("");
              }
            }}
          >
            Ajouter la note
          </button>
        </div>
      </div>
    ) : t.status === "work" && !(fresh(t) && (t.stage === "fail" || t.stage === "quota")) ? (
      <p className={styles.hint}>Claude travaille : tu pourras lui répondre quand il aura fini.</p>
    ) : null;

  return (
    <article className={`${styles.sheet} ${styles[`col_${t.status}`]}`} onPaste={onPaste}>
      <header className={styles.sheetHead}>
        <h2>{t.title}</h2>
        <p className={styles.labels}>
          {t.urgent && <span className={`${styles.lab} ${styles.labHot}`}>Hotfix</span>}
          {t.labels.map((l) => (
            <span key={l} className={styles.lab}>
              {l}
            </span>
          ))}
          <small>{head.join(" · ")}</small>
        </p>
      </header>
      {actions}
      {t.status === "work" && (
        <>
          {t.queued > 0 && (
            <p className={styles.hint}>
              <b>Validé :</b> Claude règle un conflit ou la CI avec les derniers changements de la
              base, puis la PR est fusionnée toute seule.
            </p>
          )}
          <Progress t={t} run={go} ask={ask} />
        </>
      )}
      {t.status === "review" && t.queued > 0 && (
        <div className={styles.prog} role="status">
          <b>Validé : en file pour la fusion</b>
          <p className={styles.progText}>
            Fusion automatique dès que la PR est à jour et que sa CI est passée (quelques minutes)
            {t.followUp ? ", puis ton commentaire part chez Claude" : ""}.
          </p>
          <button
            type="button"
            className={styles.link}
            onClick={() => go(() => ticketAction(t.id, "unqueue"), "Validation annulée")}
          >
            Annuler la validation
          </button>
        </div>
      )}
      {editable ? (
        <>
          {settings}
          {description}
          {attachments}
          {trello}
          {history}
        </>
      ) : (
        <>
          {history}
          {description}
          {attachments}
          {trello}
          {settings}
        </>
      )}
      {replyBox}
      {(editable || t.status === "done") && (
        <div className={styles.row}>
          {deleting ? (
            <>
              <span>
                Supprimer {t.status === "idea" ? "l'idée" : "le ticket"} et ses fichiers ?
              </span>
              <button
                type="button"
                className={styles.danger}
                onClick={async () => {
                  if (
                    await go(
                      () => deleteTicket(t.id),
                      t.status === "idea" ? "Idée supprimée" : "Ticket supprimé"
                    )
                  ) {
                    onClose();
                  }
                }}
              >
                Supprimer
              </button>
              <button type="button" className={styles.link} onClick={() => setDeleting(false)}>
                Garder
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`${styles.link} ${styles.del}`}
              onClick={() => setDeleting(true)}
            >
              Supprimer {t.status === "idea" ? "l'idée" : "le ticket"}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
