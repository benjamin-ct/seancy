import { useEffect, useState, type ClipboardEvent, type ReactNode } from "react";
import { useAuth } from "../../core/context/AuthContext.tsx";
import { adminPrefix } from "../../core/lib/adminHost.ts";
import Icon from "../../shared/components/Icon/Icon.tsx";
import {
  deleteFile,
  deleteTicket,
  editTicket,
  fileUrl,
  joinTicket,
  moveTicket,
  rewriteTicket,
  ticketAction,
  uploadFile,
  type Effort,
  type Ticket,
} from "./api.ts";
import {
  EFFORT_NAMES,
  STEPS,
  ago,
  archivable,
  columnName,
  day,
  fresh,
  lines,
  modelName,
  movedText,
  prNumber,
  stepOf,
  viewable,
  when,
} from "./board.ts";
import { Label, LabelPicker } from "./Labels.tsx";
import Markdown, { MarkdownInput } from "./Markdown.tsx";
import { TextBox } from "./TextBox.tsx";
import styles from "./TicketsPage.module.css";
import Viewer from "./Viewer.tsx";

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
  archive: "Archivé",
  desarchive: "Remis sur le tableau",
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
  const editable = t.status === "suggestion" || t.status === "idea" || t.status === "todo";
  // Pas encore un ticket : suggestion d'un utilisateur ou idée (noms au féminin)
  const fem = t.status === "suggestion" || t.status === "idea";
  const kind = t.status === "suggestion" ? "Suggestion" : t.status === "idea" ? "Idée" : "Ticket";
  const theKind =
    t.status === "suggestion" ? "la suggestion" : t.status === "idea" ? "l'idée" : "le ticket";
  const me = (useAuth().email ?? "").toLowerCase();
  const mine = !!me && t.authorEmail === me;
  const member = t.members.some((p) => p.email === me);
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
  const [picking, setPicking] = useState(false);
  const [labels, setLabels] = useState(t.labels);
  const [viewing, setViewing] = useState(-1);
  // « Partager » : le bouton dit lui-même que le lien est copié (le message de la page reste derrière la fiche)
  const [shared, setShared] = useState("");
  const media = t.files.filter(viewable);

  useEffect(() => {
    if (!editing) {
      setTitle(t.title);
      setDetail(t.detail);
    }
  }, [t.title, t.detail, editing]);
  const labelsKey = t.labels.join("\n");
  useEffect(() => {
    setLabels(labelsKey ? labelsKey.split("\n") : []);
  }, [labelsKey]);

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
      `Envoyer « ${t.title} » à Claude (${t.auto ? "choix automatique, revu à l'envoi : " : ""}${modelName(t.model)}, effort ${EFFORT_NAMES[t.effort].toLowerCase()}${t.urgent ? ", hotfix depuis main" : ""}) ?`,
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

  // Lien direct vers la fiche (admin.seancy.com/tickets/<id>) : copié, sinon partagé (téléphone), sinon montré
  const share = () =>
    go(
      async () => {
        const url = `${location.origin}${adminPrefix()}/tickets/${t.id}`;
        try {
          await navigator.clipboard.writeText(url);
          return "copied";
        } catch {
          if (navigator.share) {
            await navigator.share({ title: t.title, url });
            return "shared";
          }
          throw new Error(`copie impossible, voici le lien : ${url}`);
        }
      },
      (r) => {
        setShared(r === "shared" ? "Lien partagé" : "Lien copié");
        window.setTimeout(() => setShared(""), 2500);
        return r === "shared" ? "Lien partagé" : "Lien du ticket copié dans le presse-papiers";
      }
    );

  const prNo = prNumber(t.pr);
  const desc = lines(t.detail);
  const long = desc.length > 10 || t.detail.length > 900;
  const head = [
    kind,
    columnName(t.status),
    t.author
      ? `${t.status === "suggestion" ? "envoyée" : fem ? "notée" : "créé"} par ${t.author}${t.createdAt ? ` le ${day(t.createdAt)}` : ""}`
      : "",
    t.members.length ? `avec ${t.members.map((p) => p.name || p.email).join(", ")}` : "",
    t.status === "done" ? `fait le ${day(t.doneAt)}` : "",
    t.archived ? `archivé le ${day(t.archived)}` : "",
  ].filter(Boolean);

  const actions = (
    <div className={styles.acts}>
      {t.status === "suggestion" && (
        <>
          <button
            type="button"
            className={styles.primary}
            disabled={busy}
            onClick={() => go(() => moveTicket(t.id, "idea", ""), movedText(t.status, "idea"))}
          >
            Garder en idée
          </button>
          <button
            type="button"
            className={styles.btn}
            disabled={busy}
            onClick={() => go(() => moveTicket(t.id, "todo", ""), movedText(t.status, "todo"))}
          >
            En faire un ticket
          </button>
        </>
      )}
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
      {editable && !editing && (
        <button
          type="button"
          className={styles.btn}
          disabled={busy}
          title="Réécrire le titre et la description d'après tout le ticket : ajouts, liens et images"
          onClick={() =>
            ask(
              "Réécrire le titre et la description avec l'IA, d'après tout ce qu'il y a dans le ticket (ajouts, liens, images) ? L'idée d'origine reste en dessous.",
              "Réécrire",
              () => go(() => rewriteTicket(t.id), "Ticket réécrit par l'IA")
            )
          }
        >
          Réécrire avec l'IA
        </button>
      )}
      {me && !mine && (
        <button
          type="button"
          className={styles.btn}
          disabled={busy}
          aria-pressed={member}
          onClick={() =>
            go(
              () => joinTicket(t.id, !member),
              member ? "Tu n'es plus sur ce ticket" : "Tu es ajouté au ticket"
            )
          }
        >
          {member ? "Me retirer" : "Me rajouter"}
        </button>
      )}
      {archivable(t) && (
        <button
          type="button"
          className={styles.btn}
          disabled={busy}
          title="Sortir du tableau sans supprimer : la recherche le retrouve"
          onClick={() =>
            go(
              () => ticketAction(t.id, "archive"),
              `${kind} ${fem ? "archivée : la recherche la" : "archivé : la recherche le"} retrouve`
            )
          }
        >
          Archiver
        </button>
      )}
      {t.status === "work" && (
        <button
          type="button"
          className={styles.btn}
          disabled={busy}
          onClick={() =>
            ask(
              "Annuler l'envoi ? Le ticket revient dans « À faire ». Si Claude a déjà commencé, il est arrêté et sa réponse n'est pas prise.",
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
          {/* « Valider et commenter » et « Retouche » : choix de la zone de réponse, plus bas */}
          <button type="button" className={styles.primary} disabled={busy} onClick={validate}>
            Valider et fusionner
          </button>
        </>
      )}
      {t.status === "review" && /^https:\/\//.test(t.preview) && (
        <a
          className={styles.btn}
          href={t.preview}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Preview (nouvel onglet)"
        >
          Preview
          <Icon name="external" size={16} className={styles.btnIconEnd} />
        </a>
      )}
      {t.pr && (
        <a
          className={styles.btn}
          href={t.pr}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`PR${prNo ? ` #${prNo}` : ""} sur GitHub (nouvel onglet)`}
        >
          PR{prNo ? ` #${prNo}` : ""}
          <Icon name="external" size={16} className={styles.btnIconEnd} />
        </a>
      )}
      <button
        type="button"
        className={`${styles.btn} ${shared ? styles.btnDone : ""}`}
        onClick={share}
        aria-label={shared || "Partager : copier le lien du ticket"}
        title="Copier le lien du ticket"
      >
        {shared ? (
          <Icon name="check" size={18} strokeWidth={2.6} className={styles.btnIcon} />
        ) : (
          <svg className={styles.btnIcon} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
          </svg>
        )}
        <span aria-live="polite">{shared || "Partager"}</span>
      </button>
    </div>
  );

  const settings = t.status !== "done" && (
    <section className={styles.sec}>
      <h3>{editable ? "Réglages" : "Réglages · prochain passage de Claude"}</h3>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={t.auto}
          disabled={busy}
          onChange={(e) =>
            go(
              () => editTicket(t.id, { auto: e.target.checked }),
              e.target.checked ? "Choix automatique" : "Choix à la main"
            )
          }
        />
        <span>
          <b>Automatique</b>{" "}
          <span className={styles.muted}>
            {t.auto && t.autoWhy
              ? t.autoWhy
              : "modèle et effort choisis d'après le ticket, à chaque passage de Claude"}
          </span>
        </span>
      </label>
      <div className={styles.settings}>
        <label>
          Modèle
          <select
            value={t.model}
            disabled={busy || t.auto}
            onChange={(e) =>
              go(
                () => editTicket(t.id, { model: e.target.value as Ticket["model"], auto: false }),
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
            disabled={busy || t.auto}
            onChange={(e) =>
              go(
                () => editTicket(t.id, { effort: e.target.value as Effort, auto: false }),
                "Effort enregistré"
              )
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
          <div className={styles.field}>
            Titre
            <TextBox
              single
              value={title}
              maxLength={200}
              aria-label="Titre"
              onChange={setTitle}
              autoFocus
            />
          </div>
          {/* Pas de <label> : il viserait le premier bouton de la barre d'outils (« Gras ») */}
          <div className={styles.field}>
            Description
            <MarkdownInput value={detail} rows={10} aria-label="Description" onChange={setDetail} />
          </div>
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
            <Markdown text={t.detail} />
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

  // Aperçu d'une pièce jointe : image ou vidéo ouverte dans la visionneuse, autre fichier dans un onglet
  const fileView = (f: (typeof t.files)[number]) =>
    viewable(f) ? (
      <button
        type="button"
        className={styles.thumb}
        aria-label={`Voir ${f.name}`}
        onClick={() => setViewing(media.indexOf(f))}
      >
        {/^image\//.test(f.type) ? (
          <img src={fileUrl(f)} alt="" loading="lazy" />
        ) : (
          <span>▶ {f.name}</span>
        )}
      </button>
    ) : (
      <a href={fileUrl(f)} target="_blank" rel="noopener noreferrer">
        <span>{f.name}</span>
      </a>
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
              {fileView(f)}
              {editable && (
                <button
                  type="button"
                  className={styles.fileDel}
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
            type="url"
            autoComplete="off"
            placeholder="https://…"
            value={link.url}
            aria-label="Adresse du lien"
            onChange={(e) => setLink({ ...link, url: e.target.value })}
            autoFocus
          />
          <TextBox
            single
            placeholder="Titre (facultatif)"
            value={link.title}
            maxLength={200}
            aria-label="Titre du lien"
            onChange={(v) => setLink({ ...link, title: v })}
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
        {t.trello.comments.length > 0 &&
          ` · ${t.trello.comments.length} commentaire${t.trello.comments.length > 1 ? "s" : ""} dans l'activité`}
        {t.trello.url && (
          <>
            {" · "}
            <a href={t.trello.url} target="_blank" rel="noopener noreferrer">
              ouvrir sur Trello
            </a>
          </>
        )}
      </p>
    </section>
  );

  // Activité, la plus récente en haut (comme Trello) : historique du ticket et commentaires de la carte Trello
  const lastAnswer = t.history.map((x) => x.kind).lastIndexOf("reponse");
  const activity: { at: number; node: ReactNode }[] = t.history.map((e, i) => {
    const n = prNumber(e.pr ?? "");
    const pr = n && e.pr && (
      <a href={e.pr} target="_blank" rel="noopener noreferrer">
        {" "}
        PR #{n}
      </a>
    );
    let node: ReactNode;
    if (e.kind === "reponse") {
      node = (
        <li key={`h${i}`} className={`${styles.bubble} ${styles.claude}`}>
          <b>
            Claude <small>{when(e.at)}</small>
          </b>
          <Markdown text={e.text ?? ""} />
          {pr && <p>{pr}</p>}
          {i === lastAnswer && t.notes && (
            <details className={styles.more}>
              <summary>Notes de travail de Claude</summary>
              <Markdown text={t.notes} />
            </details>
          )}
        </li>
      );
    } else if (e.kind === "message") {
      node = (
        <li
          key={`h${i}`}
          className={`${styles.bubble} ${e.who === "auto" ? styles.auto : styles.me}`}
        >
          <b>
            {e.who === "auto" ? "Validation automatique" : e.by || "Vous"}{" "}
            <small>{when(e.at)}</small>
          </b>
          <Markdown text={e.text ?? ""} />
        </li>
      );
    } else if (e.kind === "arret") {
      node = (
        <li key={`h${i}`} className={`${styles.event} ${styles.bad}`}>
          Arrêté{e.text ? ` : ${e.text}` : ""} · {when(e.at)}
        </li>
      );
    } else {
      node = (
        <li key={`h${i}`} className={`${styles.event} ${e.kind === "valide" ? styles.good : ""}`}>
          {EVENTS[e.kind] ?? e.kind}
          {e.by ? ` par ${e.by}` : ""} · {when(e.at)}
          {pr}
        </li>
      );
    }
    return { at: e.at, node };
  });
  for (const [i, c] of (t.trello?.comments ?? []).entries()) {
    activity.push({
      at: c.at,
      node: (
        <li
          key={`t${i}`}
          className={`${styles.bubble} ${/^🤖/.test(c.text) ? styles.claude : styles.me}`}
        >
          <b>
            {c.author || "Trello"} <small>{when(c.at)} · sur Trello</small>
          </b>
          <Markdown text={c.text} />
        </li>
      ),
    });
  }
  // Pièces jointes dans le fil, à leur date d'ajout ; celles ajoutées ensemble (2 minutes) dans une seule bulle
  const added: (typeof t.files)[] = [];
  for (const f of [...t.files].filter((x) => x.at).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
    const last = added[added.length - 1];
    if (last && (f.at ?? 0) - (last[last.length - 1].at ?? 0) < 120_000) {
      last.push(f);
    } else {
      added.push([f]);
    }
  }
  for (const group of added) {
    const at = group[0].at ?? 0;
    activity.push({
      at,
      node: (
        <li key={`f${group[0].id}`} className={`${styles.bubble} ${styles.me}`}>
          <b>
            {group.length > 1 ? `${group.length} pièces jointes` : "Pièce jointe"}{" "}
            <small>{when(at)}</small>
          </b>
          <div className={styles.files}>
            {group.map((f) => (
              <span key={f.id} className={styles.file}>
                {fileView(f)}
              </span>
            ))}
          </div>
        </li>
      ),
    });
  }
  activity.sort((x, y) => y.at - x.at);
  const history = (
    <ol className={styles.hist}>
      {activity.map((x) => x.node)}
      {!t.history.length && !fem && <li className={styles.event}>Pas encore envoyé à Claude</li>}
      {!activity.length && fem && <li className={styles.event}>Pas encore d'activité</li>}
    </ol>
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
        <MarkdownInput
          rows={3}
          value={reply}
          placeholder={BOX[mode].placeholder}
          aria-label={BOX[mode].label}
          onChange={setReply}
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
        <MarkdownInput
          rows={2}
          value={note}
          placeholder="Ajouter une note à la description…"
          aria-label="Note"
          onChange={setNote}
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

  const saveLabels = (next: string[]) => {
    setLabels(next);
    void go(() => editTicket(t.id, { labels: next }), "Étiquettes enregistrées");
  };

  const remove = (editable || t.status === "done") && (
    <div className={styles.row}>
      {deleting ? (
        <>
          <span>Supprimer {theKind} et ses fichiers ?</span>
          <button
            type="button"
            className={styles.danger}
            onClick={async () => {
              if (await go(() => deleteTicket(t.id), `${kind} ${fem ? "supprimée" : "supprimé"}`)) {
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
          Supprimer {theKind}
        </button>
      )}
    </div>
  );

  // Ordinateur : deux colonnes façon Trello (le ticket à gauche, « Commentaires et activité » à droite).
  // Téléphone : une colonne ; l'activité passe en tête quand Claude a déjà travaillé dessus.
  return (
    <article
      className={`${styles.sheet} ${styles[`col_${t.status}`]} ${editable ? "" : styles.sheetTalk}`}
      onPaste={onPaste}
    >
      <div className={styles.sheetMain}>
        <header className={styles.sheetHead}>
          <h2>{t.title}</h2>
          <p className={styles.meta2}>{head.join(" · ")}</p>
        </header>
        <div className={styles.sheetLabels}>
          <h3>Étiquettes</h3>
          <div className={styles.labels}>
            {t.urgent && (
              <span className={`${styles.lab} ${styles.labBig} ${styles.labHot}`}>Hotfix</span>
            )}
            {labels.map((l) => (
              <Label key={l} name={l} big />
            ))}
            <button
              type="button"
              className={styles.labAdd}
              aria-expanded={picking}
              aria-label="Choisir les étiquettes"
              title="Choisir les étiquettes"
              onClick={() => setPicking(!picking)}
            >
              +
            </button>
          </div>
          {picking && (
            <LabelPicker
              value={labels}
              onChange={saveLabels}
              run={go}
              onClose={() => setPicking(false)}
            />
          )}
        </div>
        {actions}
        {t.archived > 0 && (
          <div className={styles.prog} role="status">
            <b>Archivé le {day(t.archived)}</b>
            <p className={styles.progText}>
              Hors du tableau : la recherche le retrouve. L'envoyer à Claude ou le changer de
              colonne le remet aussi sur le tableau.
            </p>
            <button
              type="button"
              className={styles.link}
              disabled={busy}
              onClick={() => go(() => ticketAction(t.id, "unarchive"), "Remis sur le tableau")}
            >
              Remettre sur le tableau
            </button>
          </div>
        )}
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
        {description}
        {attachments}
        {editable ? settings : null}
        {trello}
        {editable ? null : settings}
        {remove}
      </div>
      <aside className={styles.sheetSide} aria-label="Commentaires et activité">
        <h3>Commentaires et activité</h3>
        {replyBox}
        {history}
      </aside>
      {viewing >= 0 && <Viewer files={media} start={viewing} onClose={() => setViewing(-1)} />}
    </article>
  );
}
