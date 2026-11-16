#!/usr/bin/env node
// Tickets de la page /tickets, lus et tenus par les sessions Claude (workflow
// « Tickets (Claude) », sentry-triage…). Clé : variable SEANCY_TICKETS_KEY
// (créée sur la page Tickets → Réglages ; jamais dans une conversation ni un
// fichier). Serveur : SEANCY_TICKETS_URL (https://seancy.com/api/tickets par
// défaut).
//
//   node scripts/tickets.ts inbox <id>                     le ticket à traiter : description, liens, fichiers
//                                                          (copiés dans .cache/tickets/<id>/), carte Trello et
//                                                          ses commentaires, retouche demandée, PR, notes
//   node scripts/tickets.ts answer <id> --text "…" [--pr URL] [--notes "…"]   compte rendu : ticket à valider
//   node scripts/tickets.ts progress <id> --text "…" [--stage start|work|fail|quota] [--run URL] [--issue N]
//   node scripts/tickets.ts file <id> capture.png …         pièces jointes (images, PDF, vidéos ; 1,5 Mo au plus)
//   node scripts/tickets.ts add --title "…" [--detail "…"] [--status idea|todo] [--labels "Bug,Sentry"]
//   node scripts/tickets.ts list [idea|todo|work|review|done]
//   node scripts/tickets.ts get <id>                        ticket complet (JSON)
import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.SEANCY_TICKETS_URL || "https://seancy.com/api/tickets").replace(
  /\/$/,
  ""
);
const KEY = process.env.SEANCY_TICKETS_KEY || "";
const [cmd = "", ...rest] = process.argv.slice(2);

interface Ticket {
  id: string;
  status: string;
  title: string;
  detail: string;
  labels: string[];
  links: { url: string; title: string }[];
  model: string;
  effort: string;
  urgent: boolean;
  answer: string;
  pr: string;
  feedback: string;
  notes: string;
  history: { at: number; who: string; kind: string; text?: string }[];
  trello: {
    url: string;
    list: string;
    comments: { at: number; author: string; text: string }[];
  } | null;
  files: { id: string; name: string; type: string; size: number }[];
}

function args(list: string[]) {
  const pos: string[] = [];
  const opt: Record<string, string> = {};
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith("--")) {
      opt[list[i].slice(2)] = list[++i] ?? "";
    } else {
      pos.push(list[i]);
    }
  }
  return { pos, opt };
}

async function call<T>(
  p: string,
  init: { method?: string; body?: unknown; raw?: Buffer; type?: string } = {}
): Promise<T> {
  if (!KEY) {
    throw new Error(
      "SEANCY_TICKETS_KEY absente : clé à créer sur la page Tickets → Réglages, puis à mettre dans le secret du dépôt"
    );
  }
  const res = await fetch(`${BASE}${p}`, {
    method: init.method ?? (init.body || init.raw ? "POST" : "GET"),
    headers: {
      "x-tickets-key": KEY,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.type ? { "content-type": init.type } : {}),
    },
    body: init.raw ? new Uint8Array(init.raw) : init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const d = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(d.error || `HTTP ${res.status}`);
  }
  return d;
}

const day = (ms: number) =>
  ms
    ? new Date(ms).toLocaleString("fr-FR", {
        timeZone: "Europe/Paris",
        dateStyle: "short",
        timeStyle: "short",
      })
    : "";
const indent = (text: string, by = "    ") =>
  String(text || "")
    .split("\n")
    .map((l) => by + l)
    .join("\n");

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

const { pos, opt } = args(rest);
const commands: Record<string, () => Promise<void>> = {
  async inbox() {
    if (!pos[0]) {
      throw new Error("usage : inbox <id>");
    }
    const { ticket: t } = await call<{ ticket: Ticket }>(`/${pos[0]}`);
    console.log(
      `Ticket ${t.id} · ${t.status} · modèle ${t.model}, effort ${t.effort}${t.urgent ? " · HOTFIX (base main)" : ""}`
    );
    console.log(`Titre : ${t.title}`);
    if (t.labels.length) {
      console.log(`Étiquettes : ${t.labels.join(", ")}`);
    }
    console.log(`Description :\n${indent(t.detail || "(vide)")}`);
    for (const l of t.links) {
      console.log(`  lien : ${l.title ? `${l.title} ` : ""}${l.url}`);
    }
    const dir = path.join(".cache", "tickets", t.id);
    for (const f of t.files) {
      const file = path.join(dir, path.basename(f.name));
      try {
        if (!fs.existsSync(file)) {
          const res = await fetch(`${BASE}/files/${f.id}`, { headers: { "x-tickets-key": KEY } });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
        }
        console.log(`  fichier : ${f.name} → copie locale ${file} (à regarder avec l'outil Read)`);
      } catch (err) {
        console.log(`  fichier : ${f.name} (copie impossible : ${(err as Error).message})`);
      }
    }
    if (t.trello) {
      console.log(`Carte Trello d'origine (liste « ${t.trello.list} ») : ${t.trello.url}`);
      for (const c of t.trello.comments) {
        console.log(
          `  commentaire Trello de ${c.author || "?"} le ${day(c.at)} :\n${indent(c.text, "      ")}`
        );
      }
    }
    const msgs = t.history.filter((e) => e.kind === "message" || e.kind === "reponse");
    if (msgs.length) {
      console.log("Échanges précédents (du plus ancien au plus récent) :");
      for (const e of msgs) {
        console.log(
          `  ${e.who === "claude" ? "Claude" : e.who === "auto" ? "Validation automatique" : "Utilisateur"} le ${day(e.at)} :\n${indent(e.text ?? "", "      ")}`
        );
      }
    }
    if (t.feedback) {
      console.log(`RETOUCHE DEMANDÉE :\n${indent(t.feedback)}`);
    }
    if (t.pr) {
      console.log(`PR existante (à reprendre, jamais redévelopper de zéro) : ${t.pr}`);
    }
    if (t.notes) {
      console.log(`Notes de travail (session précédente) :\n${indent(t.notes)}`);
    }
  },
  async answer() {
    if (!pos[0] || !opt.text) {
      throw new Error(
        'usage : answer <id> --text "compte rendu" [--pr adresse de la PR] [--notes "notes de travail"]'
      );
    }
    await call(`/${pos[0]}/answer`, {
      body: { text: opt.text, pr: opt.pr ?? "", notes: opt.notes ?? "" },
    });
    console.log("Compte rendu enregistré : ticket à valider sur la page Tickets");
  },
  async progress() {
    const stage = opt.stage || "work";
    if (!pos[0] || !["start", "work", "fail", "quota"].includes(stage)) {
      throw new Error(
        'usage : progress <id> --text "étape en cours" [--stage start|work|fail|quota] [--run URL] [--issue N]'
      );
    }
    await call(`/${pos[0]}/progress`, {
      body: { stage, text: opt.text ?? "", run: opt.run ?? "", issue: opt.issue ?? "" },
    });
    console.log("Avancement noté");
  },
  async file() {
    if (!pos[0] || pos.length < 2) {
      throw new Error("usage : file <id> fichier…");
    }
    for (const f of pos.slice(1)) {
      const type = TYPES[path.extname(f).toLowerCase()];
      if (!type) {
        throw new Error(`${f} : type non pris en charge (${Object.keys(TYPES).join(" ")})`);
      }
      await call(`/${pos[0]}/files?name=${encodeURIComponent(path.basename(f))}`, {
        method: "PUT",
        raw: fs.readFileSync(f),
        type,
      });
      console.log(`${path.basename(f)} joint au ticket`);
    }
  },
  async add() {
    if (!opt.title) {
      throw new Error(
        'usage : add --title "…" [--detail "…"] [--status idea|todo] [--labels "a,b"]'
      );
    }
    const { ticket } = await call<{ ticket: Ticket }>("", {
      body: {
        title: opt.title,
        detail: opt.detail ?? "",
        status: opt.status === "idea" ? "idea" : "todo",
        labels: (opt.labels ?? "")
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean),
      },
    });
    console.log(`Ticket ajouté : ${ticket.id}`);
  },
  async list() {
    const { tickets } = await call<{ tickets: Ticket[] }>("");
    for (const t of tickets.filter((x) => (pos[0] ? x.status === pos[0] : x.status !== "done"))) {
      console.log(`${t.id}\t${t.status}\t${t.title}`);
    }
  },
  async get() {
    console.log(JSON.stringify(await call(`/${pos[0] ?? ""}`), null, 2));
  },
};

const run = commands[cmd];
if (!run) {
  console.log(
    fs
      .readFileSync(new URL(import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("//"))
      .map((l) => l.slice(3))
      .join("\n")
  );
  process.exit(cmd ? 1 : 0);
}
run().catch((err: Error) => {
  console.error(`Tickets : ${err.message}`);
  process.exit(1);
});
