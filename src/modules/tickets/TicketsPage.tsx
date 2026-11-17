// Page Tickets (/tickets) : demandes de développement envoyées à Claude, sur
// un tableau façon Trello (Idées, À faire, En cours, À valider, Faits).
// Réservée aux administrateurs (le serveur refuse les autres comptes) et non
// référencée. Une carte glissée d'une colonne à l'autre fait l'action de la
// colonne : envoi à Claude, annulation, validation (fusion de la PR),
// retouche, réouverture. Serveur : worker/tickets.ts ; Claude travaille dans
// le workflow « Tickets (Claude) » (.github/workflows/claude-tickets.yml).
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../core/context/AuthContext.tsx";
import { useDocumentTitle } from "../../shared/hooks/useDocumentTitle.ts";
import {
  ApiError,
  createTicket,
  fileUrl,
  listTickets,
  moveTicket,
  newKey,
  ticketAction,
  uploadFile,
  type Effort,
  type LabelDef,
  type Ticket,
  type TicketStatus,
  type TicketsConfig,
} from "./api.ts";
import {
  COLUMNS,
  EFFORT_NAMES,
  SORTABLE,
  STEPS,
  ago,
  canMove,
  columns,
  day,
  LabelsContext,
  fresh,
  modelName,
  prNumber,
  refusal,
  stepOf,
} from "./board.ts";
import Dialog from "./Dialog.tsx";
import { Label } from "./Labels.tsx";
import { MarkdownInput } from "./Markdown.tsx";
import TicketSheet, { type Ask, type ReplyMode, type Run } from "./TicketSheet.tsx";
import styles from "./TicketsPage.module.css";

const POLL_MS = 15_000;
const SMALL_KEY = "seancy.tickets.small";
// Flèches vers l'intérieur (réduire) ou vers l'extérieur (agrandir)
const ZOOM_IN = "M14 10l7-7M14 10h5M14 10V5M10 14l-7 7M10 14H5M10 14v5";
const ZOOM_OUT = "M21 3l-7 7M21 3h-5M21 3v5M3 21l7-7M3 21h5M3 21v-5";
const LONG_PRESS_MS = 350;

interface Drag {
  id: string;
  x: number;
  y: number;
  w: number;
  offX: number;
  offY: number;
}

function Mini({
  t,
  onOpen,
  onDown,
  dragging,
}: {
  t: Ticket;
  onOpen: () => void;
  onDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  dragging: boolean;
}) {
  const live = fresh(t);
  const cover = t.status !== "done" ? t.files.find((f) => /^image\//.test(f.type)) : undefined;
  const labs: { text: string; tone?: string }[] = [];
  if (t.urgent) {
    labs.push({ text: "Hotfix", tone: styles.labHot });
  }
  if (t.status === "work" && live && t.stage === "fail") {
    labs.push({ text: "Arrêté", tone: styles.labBad });
  } else if (t.status === "work" && live && t.stage === "quota") {
    labs.push({ text: "En pause", tone: styles.labWait });
  } else if (t.status === "work" && t.queued) {
    labs.push({ text: "Correction avant fusion" });
  } else if (t.status === "work" && t.feedback) {
    labs.push({ text: "Retouche" });
  }
  if (t.status === "review" && t.queued) {
    labs.push({ text: "En file pour la fusion", tone: styles.labOk });
  }
  if (t.status !== "done" && t.status !== "idea") {
    labs.push({ text: `${modelName(t.model)} · ${EFFORT_NAMES[t.effort]}` });
  }
  const cur = stepOf(t);
  const bar = t.status === "work" && !(live && (t.stage === "fail" || t.stage === "quota"));
  const prNo = prNumber(t.pr);
  const date =
    t.status === "done"
      ? day(t.doneAt)
      : t.status === "work"
        ? live
          ? ago(t.progressAt)
          : t.sent
            ? `envoyé ${ago(t.sent)}`
            : ""
        : "";
  return (
    <button
      type="button"
      className={`${styles.mini} ${dragging ? styles.miniGhosted : ""}`}
      data-card={t.id}
      aria-haspopup="dialog"
      onClick={onOpen}
      onPointerDown={onDown}
    >
      {cover && (
        <img
          className={styles.cover}
          src={fileUrl(cover)}
          alt=""
          loading="lazy"
          draggable={false}
        />
      )}
      {labs.length + t.labels.length > 0 && (
        <span className={styles.labels}>
          {t.labels.map((l) => (
            <Label key={l} name={l} />
          ))}
          {labs.map((l) => (
            <span key={l.text} className={`${styles.lab} ${l.tone ?? ""}`}>
              {l.text}
            </span>
          ))}
        </span>
      )}
      <span className={styles.miniTitle}>{t.title}</span>
      {bar && (
        <span className={styles.bar} role="img" aria-label={`Avancement : ${STEPS[cur]}`}>
          {STEPS.map((s, i) => (
            <i key={s} className={i < cur ? styles.stepOk : i === cur ? styles.stepOn : ""} />
          ))}
        </span>
      )}
      <span className={styles.meta}>
        {t.detail.trim() && <span aria-label="Avec une description">≡</span>}
        {t.files.length > 0 && (
          <span aria-label={`${t.files.length} fichier(s)`}>📎 {t.files.length}</span>
        )}
        {t.trello && t.trello.comments.length > 0 && (
          <span aria-label={`${t.trello.comments.length} commentaire(s) Trello`}>
            💬 {t.trello.comments.length}
          </span>
        )}
        {prNo && <span>#{prNo}</span>}
        {date && <small>{date}</small>}
        {t.author && (
          <span
            className={styles.who}
            title={`Ticket de ${t.author}`}
            aria-label={`Ticket de ${t.author}`}
          >
            {t.author.slice(0, 1).toUpperCase()}
          </span>
        )}
      </span>
    </button>
  );
}

function NewTicket({
  onClose,
  run,
  config,
}: {
  onClose: () => void;
  run: Run;
  config: TicketsConfig | null;
}) {
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [model, setModel] = useState<"opus" | "sonnet">("opus");
  const [effort, setEffort] = useState<Effort>("high");
  const [urgent, setUrgent] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const submit = async (send: boolean) => {
    if (!title.trim() && !detail.trim()) {
      return;
    }
    setBusy(true);
    const ok = await run(
      async () => {
        const { ticket } = await createTicket({
          title: title.trim(),
          detail,
          model,
          effort,
          urgent,
          status: "todo",
        });
        for (const f of files) {
          await uploadFile(ticket.id, f);
        }
        if (send) {
          await ticketAction(ticket.id, "send");
        }
      },
      send ? "Envoyé à Claude" : "Gardé dans « À faire »"
    );
    setBusy(false);
    if (ok) {
      onClose();
    }
  };
  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        void submit(true);
      }}
      onPaste={(e) => {
        const pasted = [...e.clipboardData.files].filter((f) => /^image\//.test(f.type));
        if (pasted.length) {
          e.preventDefault();
          setFiles((l) => [...l, ...pasted]);
        }
      }}
    >
      <h2>Nouveau ticket</h2>
      <input
        value={title}
        maxLength={200}
        placeholder="Titre (facultatif : sinon la 1re ligne de la description)"
        aria-label="Titre"
        onChange={(e) => setTitle(e.target.value)}
      />
      <MarkdownInput
        value={detail}
        rows={6}
        placeholder="Ce qui se passe, où, ce que tu voudrais à la place…"
        aria-label="Description"
        onChange={setDetail}
        autoFocus
      />
      <fieldset className={styles.models}>
        <legend>Modèle</legend>
        <label className={styles.check}>
          <input
            type="radio"
            name="model"
            checked={model === "opus"}
            onChange={() => setModel("opus")}
          />
          <span>
            <b>Opus</b> <span className={styles.muted}>gros ticket, le plus soigné</span>
          </span>
        </label>
        <label className={styles.check}>
          <input
            type="radio"
            name="model"
            checked={model === "sonnet"}
            onChange={() => setModel("sonnet")}
          />
          <span>
            <b>Sonnet</b>{" "}
            <span className={styles.muted}>petit ticket, plus rapide et plus économe</span>
          </span>
        </label>
        <label>
          Effort
          <select value={effort} onChange={(e) => setEffort(e.target.value as Effort)}>
            <option value="medium">Moyen : rapide</option>
            <option value="high">Élevé (conseillé)</option>
            <option value="xhigh">Très élevé : ticket difficile</option>
            <option value="max">Maximum : le plus long et le plus coûteux</option>
          </select>
        </label>
      </fieldset>
      <label className={styles.check}>
        <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
        <span>
          <b>Hotfix</b>{" "}
          <span className={styles.muted}>
            bug urgent en prod : corrigé depuis main, sans attendre la prochaine release
          </span>
        </span>
      </label>
      <div className={styles.row}>
        <label className={styles.btn}>
          Photos, vidéos
          <input
            type="file"
            accept="image/*,video/mp4,video/quicktime,video/webm,application/pdf"
            multiple
            hidden
            onChange={(e) => {
              const list = [...(e.target.files ?? [])];
              e.target.value = "";
              setFiles((l) => [...l, ...list]);
            }}
          />
        </label>
        <span className={styles.muted}>
          {files.length
            ? `${files.length} fichier${files.length > 1 ? "s" : ""}`
            : "ou colle une capture ici"}
        </span>
        {files.length > 0 && (
          <button type="button" className={styles.link} onClick={() => setFiles([])}>
            Retirer
          </button>
        )}
      </div>
      <div className={styles.row}>
        <button
          type="submit"
          className={styles.primary}
          disabled={busy || (!title.trim() && !detail.trim()) || config?.github === false}
        >
          Envoyer à Claude
        </button>
        <button
          type="button"
          className={styles.btn}
          disabled={busy || (!title.trim() && !detail.trim())}
          onClick={() => submit(false)}
        >
          Garder dans « À faire »
        </button>
      </div>
      {config?.github === false && (
        <p className={styles.hint}>
          Envoi à Claude pas encore réglé (secret GITHUB_TICKETS_TOKEN du Worker) : garde le ticket
          dans « À faire » pour l'instant.
        </p>
      )}
    </form>
  );
}

function Settings({ config, run }: { config: TicketsConfig | null; run: Run }) {
  const [key, setKey] = useState("");
  const [sure, setSure] = useState(false);
  const item = (ok: boolean | undefined, label: string, help: string) => (
    <li className={ok ? styles.good : styles.bad}>
      <b>
        {ok ? "✓" : "✗"} {label}
      </b>{" "}
      <span className={styles.muted}>{help}</span>
    </li>
  );
  return (
    <div className={styles.form}>
      <h2>Réglages des tickets</h2>
      <ul className={styles.config}>
        {item(
          config?.github,
          "Envoi à Claude",
          `secret GITHUB_TICKETS_TOKEN du Worker (dépôt ${config?.repo ?? "benjamin-ct/seancy"})`
        )}
        {item(
          config?.discord,
          "Notifications Discord",
          "secret DISCORD_TICKETS_WEBHOOK_URL du Worker (facultatif)"
        )}
        {item(
          config?.key,
          "Clé des sessions Claude",
          "secret SEANCY_TICKETS_KEY du dépôt GitHub (workflow « Tickets (Claude) »)"
        )}
      </ul>
      <h3>Clé des sessions Claude</h3>
      <p className={styles.muted}>
        Le workflow « Tickets (Claude) » lit et répond aux tickets avec cette clé. Elle n'est
        montrée qu'une fois : colle-la dans le secret <code>SEANCY_TICKETS_KEY</code> du dépôt
        (GitHub → Settings → Secrets and variables → Actions). En créer une nouvelle rend l'ancienne
        inutilisable.
      </p>
      {key ? (
        <div className={styles.row}>
          <input
            readOnly
            value={key}
            aria-label="Nouvelle clé"
            onFocus={(e) => e.target.select()}
          />
          <button
            type="button"
            className={styles.btn}
            onClick={() => navigator.clipboard?.writeText(key).catch(() => {})}
          >
            Copier
          </button>
        </div>
      ) : sure || !config?.key ? (
        <button
          type="button"
          className={styles.primary}
          onClick={() =>
            run(async () => {
              const r = await newKey();
              setKey(r.key);
            }, "Nouvelle clé créée")
          }
        >
          Créer {config?.key ? "une nouvelle" : "la"} clé
        </button>
      ) : (
        <button type="button" className={styles.btn} onClick={() => setSure(true)}>
          Remplacer la clé…
        </button>
      )}
    </div>
  );
}

export default function TicketsPage() {
  useDocumentTitle("Tickets");
  const { status: authStatus, email } = useAuth();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [config, setConfig] = useState<TicketsConfig | null>(null);
  const [labelDefs, setLabelDefs] = useState<LabelDef[]>([]);
  const [denied, setDenied] = useState<{ status: number; message: string } | null>(null);
  const [query, setQuery] = useState("");
  // « Les miens » : tickets créés par le compte connecté (les deux administrateurs partagent le tableau)
  const [mine, setMine] = useState(false);
  const [sheet, setSheet] = useState<{ id: string; mode: ReplyMode | "" } | null>(null);
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState(false);
  const [confirm, setConfirm] = useState<{ text: string; ok: string; job: () => void } | null>(
    null
  );
  const [toast, setToast] = useState<{ text: string; bad: boolean } | null>(null);
  const [idea, setIdea] = useState("");
  const [drag, setDrag] = useState<Drag | null>(null);
  const [target, setTarget] = useState<{ col: TicketStatus; before: string } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  // Tableau réduit (bouton rond en bas à droite, ou pincement à deux doigts) :
  // choix gardé sur cet appareil
  const [small, setSmallState] = useState(() => {
    try {
      return localStorage.getItem(SMALL_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setSmall = useCallback((on: boolean) => {
    setSmallState(on);
    try {
      localStorage.setItem(SMALL_KEY, on ? "1" : "0");
    } catch {
      // stockage bloqué : le choix vaut pour cette visite
    }
  }, []);
  // Pincement à deux doigts sur le tableau : écarter agrandit, rapprocher réduit
  // (le tableau n'existe qu'une fois les tickets chargés)
  const boardReady = tickets !== null;
  useEffect(() => {
    const b = boardRef.current;
    if (!b) {
      return;
    }
    let start = 0;
    const span = (e: TouchEvent) =>
      Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    const begin = (e: TouchEvent) => {
      start = e.touches.length === 2 ? span(e) : 0;
    };
    const move = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) {
        return;
      }
      const ratio = span(e) / start;
      if (ratio < 0.75 || ratio > 1.33) {
        setSmall(ratio < 1);
        start = 0;
      }
    };
    b.addEventListener("touchstart", begin, { passive: true });
    b.addEventListener("touchmove", move, { passive: true });
    return () => {
      b.removeEventListener("touchstart", begin);
      b.removeEventListener("touchmove", move);
    };
  }, [setSmall, boardReady]);
  const dragEnd = useRef(0);

  const load = useCallback(async () => {
    try {
      const r = await listTickets();
      setTickets(r.tickets);
      setConfig(r.config);
      setLabelDefs(r.labels ?? []);
      setDenied(null);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setDenied({ status: err.status, message: err.message });
      } else {
        setToast({ text: `Tickets non chargés : ${(err as Error).message}`, bad: true });
      }
    }
  }, []);

  useEffect(() => {
    if (authStatus === "loading") {
      return;
    }
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void load();
      }
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void load();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authStatus, load]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), toast.bad ? 7000 : 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const run: Run = useCallback(
    async (job, ok) => {
      try {
        const r = await job();
        setToast({ text: typeof ok === "function" ? ok(r) : ok, bad: false });
        await load();
        return true;
      } catch (err) {
        setToast({ text: `Non fait : ${(err as Error).message}`, bad: true });
        await load();
        return false;
      }
    },
    [load]
  );
  const ask: Ask = useCallback((text, ok, job) => setConfirm({ text, ok, job }), []);

  const cols = useMemo(
    () =>
      columns(
        (tickets ?? []).filter((t) => !mine || t.authorEmail === (email ?? "").toLowerCase()),
        query
      ),
    [tickets, query, mine, email]
  );
  // Étiquettes définies (dans leur ordre), puis celles des tickets qui n'ont pas encore de couleur
  const labelsInfo = useMemo(() => {
    const names = labelDefs.map((d) => d.name);
    const seen = new Set(names.map((n) => n.toLowerCase()));
    for (const t of tickets ?? []) {
      for (const l of t.labels) {
        if (!seen.has(l.toLowerCase())) {
          seen.add(l.toLowerCase());
          names.push(l);
        }
      }
    }
    return { defs: labelDefs, names };
  }, [labelDefs, tickets]);
  const byId = useMemo(() => new Map((tickets ?? []).map((t) => [t.id, t])), [tickets]);
  const open = sheet ? byId.get(sheet.id) : undefined;

  const moveTo = useCallback(
    (t: Ticket, to: TicketStatus, before: string) => {
      if (t.status === to) {
        if (SORTABLE.has(to)) {
          void run(() => moveTicket(t.id, undefined, before), "Carte rangée");
        }
        return;
      }
      if (!canMove(t, to)) {
        setToast({ text: refusal(t, to), bad: true });
        return;
      }
      const key = `${t.status}>${to}`;
      if (key === "idea>todo" || key === "todo>idea") {
        void run(
          () => moveTicket(t.id, to, before),
          to === "todo" ? "Idée passée dans « À faire »" : "Remise dans les idées"
        );
      } else if (to === "work" && (t.status === "idea" || t.status === "todo")) {
        ask(
          `Envoyer « ${t.title} » à Claude (${modelName(t.model)}, effort ${EFFORT_NAMES[t.effort].toLowerCase()}${t.urgent ? ", hotfix depuis main" : ""}) ?`,
          "Envoyer",
          () => run(() => ticketAction(t.id, "send"), "Envoyé à Claude")
        );
      } else if (key === "work>todo") {
        ask(
          "Annuler l'envoi ? Le ticket revient dans « À faire ». Si Claude a déjà commencé sur GitHub, il peut finir et répondre quand même.",
          "Annuler l'envoi",
          () =>
            run(() => ticketAction(t.id, "unsend"), "Envoi annulé : ticket revenu dans « À faire »")
        );
      } else if (key === "review>done") {
        ask(
          `Valider « ${t.title} » et fusionner sa PR dans ${t.urgent ? "main" : "develop"} ?`,
          "Valider",
          () =>
            run(
              () => ticketAction(t.id, "validate"),
              (r) =>
                (r as { queued?: boolean })?.queued
                  ? "Validé : fusion automatique dès que la CI est passée"
                  : "Ticket validé : PR fusionnée"
            )
        );
      } else if (key === "review>work") {
        setSheet({ id: t.id, mode: "retouch" });
      } else if (key === "done>work") {
        setSheet({ id: t.id, mode: "reopen" });
      }
    },
    [ask, run]
  );

  // ---------- Glisser-déposer ----------
  // Souris : dès que le pointeur bouge un peu ; doigt : appui long (sinon le
  // doigt fait défiler). La carte suit le pointeur, la colonne visée est
  // marquée, les colonnes interdites sont grisées. Échap annule.
  const pointer = useRef<{
    id: string;
    sx: number;
    sy: number;
    touch: boolean;
    active: boolean;
    timer: number;
    offX: number;
    offY: number;
    w: number;
    target: { col: TicketStatus; before: string } | null;
  } | null>(null);

  const targetAt = (x: number, y: number, id: string) => {
    const col = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-col]");
    if (!col) {
      return null;
    }
    const cards = [...col.querySelectorAll<HTMLElement>("[data-card]")].filter(
      (c) => c.dataset.card !== id
    );
    const next = cards.find((c) => {
      const r = c.getBoundingClientRect();
      return r.top + r.height / 2 > y;
    });
    return { col: col.dataset.col as TicketStatus, before: next?.dataset.card ?? "" };
  };

  const onDown = (t: Ticket) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || pointer.current) {
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const p = {
      id: t.id,
      sx: e.clientX,
      sy: e.clientY,
      touch: e.pointerType !== "mouse",
      active: false,
      timer: 0,
      offX: e.clientX - r.left,
      offY: e.clientY - r.top,
      w: r.width,
      target: null as { col: TicketStatus; before: string } | null,
    };
    pointer.current = p;
    const start = (x: number, y: number) => {
      p.active = true;
      document.body.classList.add(styles.dragging);
      navigator.vibrate?.(8);
      setDrag({ id: p.id, x, y, w: p.w, offX: p.offX, offY: p.offY });
    };
    const stop = (drop: boolean) => {
      window.clearTimeout(p.timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      window.removeEventListener("touchmove", block);
      document.body.classList.remove(styles.dragging);
      pointer.current = null;
      if (p.active) {
        dragEnd.current = Date.now();
        setDrag(null);
        setTarget(null);
        const tk = byId.get(p.id);
        if (drop && tk && p.target) {
          moveTo(tk, p.target.col, p.target.before);
        }
      }
    };
    const move = (ev: PointerEvent) => {
      if (!p.active) {
        if (Math.hypot(ev.clientX - p.sx, ev.clientY - p.sy) > 8) {
          if (p.touch) {
            stop(false); // le doigt fait défiler
          } else {
            start(ev.clientX, ev.clientY);
          }
        }
        return;
      }
      setDrag((d) => (d ? { ...d, x: ev.clientX, y: ev.clientY } : d));
      p.target = targetAt(ev.clientX, ev.clientY, p.id);
      setTarget(p.target);
      const b = boardRef.current;
      if (b) {
        const r = b.getBoundingClientRect();
        if (ev.clientX > r.right - 40) {
          b.scrollLeft += 14;
        } else if (ev.clientX < r.left + 40) {
          b.scrollLeft -= 14;
        }
      }
    };
    const up = () => stop(true);
    const cancel = () => stop(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        stop(false);
      }
    };
    const block = (ev: TouchEvent) => {
      if (p.active) {
        ev.preventDefault();
      }
    };
    if (p.touch) {
      p.timer = window.setTimeout(() => start(p.sx, p.sy), LONG_PRESS_MS);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    window.addEventListener("touchmove", block, { passive: false });
  };

  const dragged = drag ? byId.get(drag.id) : undefined;

  if (authStatus === "anonymous" || denied?.status === 401) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Tickets</h1>
        <p className={styles.muted}>
          Page réservée aux administrateurs de Seancy. <Link to="/connexion">Se connecter</Link>
        </p>
      </div>
    );
  }
  if (denied) {
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Tickets</h1>
        <p className={styles.muted}>
          {denied.message}. L'adresse e-mail du compte doit figurer dans le secret ADMIN_EMAILS du
          Worker.
        </p>
      </div>
    );
  }

  return (
    <LabelsContext.Provider value={labelsInfo}>
      <div className={styles.page}>
        <header className={styles.top}>
          <div>
            <p className={styles.eyebrow}>Développement · Claude</p>
            <h1 className={styles.title}>Tickets</h1>
          </div>
          <div className={styles.tools}>
            <input
              type="search"
              className={styles.search}
              value={query}
              placeholder="Chercher…"
              aria-label="Chercher un ticket"
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className={styles.segs} role="group" aria-label="Tickets montrés">
              <button
                type="button"
                className={styles.seg}
                aria-pressed={!mine}
                onClick={() => setMine(false)}
              >
                Tous
              </button>
              <button
                type="button"
                className={styles.seg}
                aria-pressed={mine}
                onClick={() => setMine(true)}
              >
                Les miens
              </button>
            </div>
            <button type="button" className={styles.btn} onClick={() => setSettings(true)}>
              Réglages
            </button>
            <button type="button" className={styles.primary} onClick={() => setCreating(true)}>
              Nouveau ticket
            </button>
          </div>
        </header>
        {config && !config.github && (
          <p className={styles.banner}>
            Envoi à Claude pas encore réglé : il manque le secret <code>GITHUB_TICKETS_TOKEN</code>{" "}
            du Worker. Les tickets se notent et se rangent quand même.
          </p>
        )}
        {!tickets ? (
          <p className={styles.muted}>Chargement…</p>
        ) : (
          <div className={`${styles.board} ${small ? styles.boardSmall : ""}`} ref={boardRef}>
            {COLUMNS.map((c) => {
              const list = cols[c.key];
              const off = dragged && !canMove(dragged, c.key);
              const over = target?.col === c.key && !off;
              const total =
                c.key === "done"
                  ? (tickets ?? []).filter((t) => t.status === "done").length
                  : list.length;
              return (
                <section
                  key={c.key}
                  data-col={c.key}
                  className={`${styles.col} ${styles[`col_${c.key}`]} ${off ? styles.colOff : ""} ${over ? styles.colOver : ""}`}
                  aria-labelledby={`col-${c.key}`}
                >
                  <header className={styles.colHead}>
                    <h2 id={`col-${c.key}`}>{c.name}</h2>
                    <span className={styles.count}>{total}</span>
                  </header>
                  <div className={styles.cards}>
                    {list.map((t) => (
                      <div
                        key={t.id}
                        className={
                          over &&
                          SORTABLE.has(c.key) &&
                          target?.before === t.id &&
                          drag?.id !== t.id
                            ? styles.dropBefore
                            : ""
                        }
                      >
                        <Mini
                          t={t}
                          dragging={drag?.id === t.id}
                          onDown={onDown(t)}
                          onOpen={() => {
                            if (Date.now() - dragEnd.current > 300) {
                              setSheet({ id: t.id, mode: "" });
                            }
                          }}
                        />
                      </div>
                    ))}
                    {over && SORTABLE.has(c.key) && target?.before === "" && (
                      <div className={styles.dropEnd} />
                    )}
                    {!list.length && (
                      <p className={styles.empty}>{query ? "Aucun ticket trouvé." : c.empty}</p>
                    )}
                    {c.key === "done" && !query && total > list.length && (
                      <p className={styles.empty}>
                        Les {list.length} derniers : cherche pour retrouver les autres.
                      </p>
                    )}
                  </div>
                  {c.key === "idea" && (
                    <form
                      className={styles.compose}
                      onSubmit={(e) => {
                        e.preventDefault();
                        const [title, ...rest] = idea.split("\n");
                        if (!title.trim()) {
                          return;
                        }
                        void run(async () => {
                          await createTicket({
                            status: "idea",
                            title: title.trim(),
                            detail: rest.join("\n").trim(),
                          });
                          setIdea("");
                        }, "Idée notée");
                      }}
                    >
                      <textarea
                        rows={2}
                        value={idea}
                        placeholder="Une idée (1re ligne : le titre)"
                        aria-label="Nouvelle idée : la première ligne sert de titre"
                        onChange={(e) => setIdea(e.target.value)}
                      />
                      {idea.trim() && (
                        <button type="submit" className={styles.btn}>
                          Noter l'idée
                        </button>
                      )}
                    </form>
                  )}
                  {c.key === "todo" && (
                    <button type="button" className={styles.add} onClick={() => setCreating(true)}>
                      + Nouveau ticket
                    </button>
                  )}
                </section>
              );
            })}
          </div>
        )}
        {tickets && (
          <button
            type="button"
            className={styles.zoom}
            aria-pressed={small}
            aria-label={small ? "Agrandir le tableau" : "Réduire le tableau"}
            title={small ? "Agrandir le tableau" : "Réduire le tableau"}
            onClick={() => setSmall(!small)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={small ? ZOOM_OUT : ZOOM_IN} />
            </svg>
          </button>
        )}
        {drag && dragged && (
          <div
            className={styles.ghost}
            style={{ left: drag.x - drag.offX, top: drag.y - drag.offY, width: drag.w }}
            aria-hidden="true"
          >
            <span className={styles.miniTitle}>{dragged.title}</span>
          </div>
        )}

        <Dialog open={!!open} onClose={() => setSheet(null)} label={open?.title ?? "Ticket"} wide>
          {open && (
            <TicketSheet
              key={`${open.id}-${sheet?.mode}`}
              ticket={open}
              mode={sheet?.mode ?? ""}
              run={run}
              ask={ask}
              onClose={() => setSheet(null)}
            />
          )}
        </Dialog>
        <Dialog open={creating} onClose={() => setCreating(false)} label="Nouveau ticket">
          <NewTicket onClose={() => setCreating(false)} run={run} config={config} />
        </Dialog>
        <Dialog open={settings} onClose={() => setSettings(false)} label="Réglages des tickets">
          <Settings config={config} run={run} />
        </Dialog>
        <Dialog open={!!confirm} onClose={() => setConfirm(null)} label="Confirmation">
          {confirm && (
            <div className={styles.form}>
              <p className={styles.confirmText}>{confirm.text}</p>
              <div className={styles.row}>
                <button
                  type="button"
                  className={styles.primary}
                  autoFocus
                  onClick={() => {
                    const job = confirm.job;
                    setConfirm(null);
                    job();
                  }}
                >
                  {confirm.ok}
                </button>
                <button type="button" className={styles.btn} onClick={() => setConfirm(null)}>
                  Annuler
                </button>
              </div>
            </div>
          )}
        </Dialog>
        {toast && (
          <div
            className={`${styles.toast} ${toast.bad ? styles.toastBad : ""}`}
            role={toast.bad ? "alert" : "status"}
          >
            {toast.text}
          </div>
        )}
      </div>
    </LabelsContext.Provider>
  );
}
