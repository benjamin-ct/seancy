#!/usr/bin/env node
// Import unique du board Trello dans les tickets de Seancy (page /tickets) :
// toutes les cartes ouvertes, avec leur colonne, description, checklists,
// étiquettes (et leurs couleurs), commentaires et pièces jointes (fichiers de 1,5 Mo au plus
// recopiés dans le ticket, les autres gardés en liens). Conversion :
// scripts/trelloLib.ts. Rejouable : une carte déjà importée est sautée.
// Rien n'est envoyé à Claude : les cartes « En cours » arrivent dans « À faire ».
//
// Lancé par le workflow « Import Trello » (onglet Actions), ou à la main :
//   TRELLO_KEY=… TRELLO_TOKEN=… SEANCY_TICKETS_KEY=… node scripts/trello-import.ts <board> [--dry-run]
// <board> : identifiant ou adresse du board (https://trello.com/b/<id>/…).
// Serveur des tickets : SEANCY_TICKETS_URL (https://seancy.creusatbenjamin.workers.dev/api/tickets
// par défaut : hors de la zone seancy.com, dont le Bot Fight Mode bloque les machines de GitHub).
import { shrinkImage, storedName } from "./shrinkImage.ts";
import {
  boardToTickets,
  isImportableFile,
  labelDefsOf,
  type TrelloCard,
  type TrelloComment,
  type TrelloLabel,
} from "./trelloLib.ts";

const KEY = process.env.TRELLO_KEY || "";
const TOKEN = process.env.TRELLO_TOKEN || "";
const TICKETS = (
  process.env.SEANCY_TICKETS_URL || "https://seancy.creusatbenjamin.workers.dev/api/tickets"
).replace(/\/$/, "");
const TICKETS_KEY = process.env.SEANCY_TICKETS_KEY || "";
const argv = process.argv.slice(2);
const dry = argv.includes("--dry-run");
const board = (argv.find((a) => !a.startsWith("--")) || process.env.TRELLO_BOARD || "").replace(
  /^https?:\/\/trello\.com\/b\/([^/]+).*$/,
  "$1"
);

// Clé et jeton dans l'en-tête (jamais dans l'adresse, qui finirait dans les journaux)
const auth = { authorization: `OAuth oauth_consumer_key="${KEY}", oauth_token="${TOKEN}"` };

async function trello<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.trello.com/1${path}`, {
    headers: auth,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(
      `Trello ${path.split("?")[0]} : HTTP ${res.status} ${await res.text().catch(() => "")}`.slice(
        0,
        300
      )
    );
  }
  return (await res.json()) as T;
}

async function tickets<T>(
  path: string,
  init: { method?: string; body?: unknown; raw?: Uint8Array; type?: string } = {}
): Promise<T> {
  const res = await fetch(`${TICKETS}${path}`, {
    method: init.method ?? "POST",
    headers: { "x-tickets-key": TICKETS_KEY, "content-type": init.type ?? "application/json" },
    body: init.raw ? init.raw : init.method === "GET" ? undefined : JSON.stringify(init.body ?? {}),
    signal: AbortSignal.timeout(120_000),
  });
  const d = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(`Tickets ${path} : ${d.error || `HTTP ${res.status}`}`);
  }
  return d;
}

interface Action {
  id: string;
  type: string;
  date: string;
  data: { text?: string; card?: { id: string } };
  memberCreator?: { fullName?: string; username?: string };
}

// Commentaires des cartes et créateur de chaque carte (création, copie, carte faite d'un élément de checklist)
async function allActions(): Promise<{ comments: TrelloComment[]; creators: Map<string, string> }> {
  const comments: TrelloComment[] = [];
  const creators = new Map<string, string>();
  let before = "";
  for (let page = 0; page < 50; page++) {
    const batch = await trello<Action[]>(
      `/boards/${board}/actions?filter=commentCard,createCard,copyCard,convertToCardFromCheckItem,emailCard&limit=1000&memberCreator_fields=fullName,username${before ? `&before=${before}` : ""}`
    );
    for (const a of batch) {
      const who = a.memberCreator?.fullName || a.memberCreator?.username || "";
      if (a.type === "commentCard" && a.data.card?.id && a.data.text) {
        comments.push({
          cardId: a.data.card.id,
          at: Date.parse(a.date) || 0,
          author: who,
          text: a.data.text,
        });
      } else if (a.type !== "commentCard" && a.data.card?.id && who) {
        creators.set(a.data.card.id, who);
      }
    }
    if (batch.length < 1000) {
      break;
    }
    before = batch.at(-1)!.id;
  }
  return { comments, creators };
}

async function main() {
  if (!KEY || !TOKEN || !board) {
    throw new Error(
      "TRELLO_KEY, TRELLO_TOKEN et le board (identifiant ou adresse) sont nécessaires"
    );
  }
  if (!dry && !TICKETS_KEY) {
    throw new Error("SEANCY_TICKETS_KEY absente (clé créée sur la page Tickets → Réglages)");
  }
  const info = await trello<{ name: string; url: string }>(`/boards/${board}?fields=name,url`);
  console.log(`Board « ${info.name} » (${info.url})`);
  const lists = await trello<{ id: string; name: string; pos: number; closed: boolean }[]>(
    `/boards/${board}/lists?filter=all&fields=name,pos,closed`
  );
  const cards = await trello<TrelloCard[]>(
    `/boards/${board}/cards/open?fields=name,desc,idList,pos,shortUrl,dateLastActivity,labels&attachments=true&attachment_fields=id,name,url,mimeType,bytes,isUpload&checklists=all&checklist_fields=name`
  );
  const { comments, creators } = await allActions();
  const labels = labelDefsOf(
    await trello<TrelloLabel[]>(`/boards/${board}/labels?fields=name,color&limit=1000`)
  );
  const list = boardToTickets(
    lists.filter((l) => !l.closed),
    cards,
    comments,
    creators
  );
  const count: Record<string, number> = {};
  for (const t of list) {
    count[t.status] = (count[t.status] ?? 0) + 1;
  }
  console.log(
    `${cards.length} cartes, ${comments.length} commentaires → ${list.length} tickets : ${JSON.stringify(count)}`
  );
  for (const l of lists) {
    console.log(
      `  liste « ${l.name} »${l.closed ? " (archivée, ignorée)" : ""} : ${cards.filter((c) => c.idList === l.id).length} cartes`
    );
  }
  console.log(
    `${labels.length} étiquettes : ${labels.map((l) => `${l.name} (${l.color || "sans couleur"})`).join(", ")}`
  );
  if (dry) {
    console.log("Essai à blanc (--dry-run) : rien n'a été envoyé.");
    for (const t of list.slice(0, 15)) {
      console.log(
        `  [${t.status}] ${t.title}${t.labels.length ? ` (${t.labels.join(", ")})` : ""}${t.author ? ` · par ${t.author}` : ""}${t.pr ? ` · ${t.pr}` : ""}`
      );
    }
    return;
  }
  // Couleurs des étiquettes : reprises à chaque lancement (celles changées sur la page Tickets sont remplacées)
  await tickets("/labels", { method: "PUT", body: { labels } });
  // Tickets créés et déjà importés : les pièces jointes manquantes sont envoyées dans les deux cas (relancer l'import
  // complète les fichiers en échec d'un lancement précédent, sans doublon)
  const created = new Map<string, string>();
  const known = new Map<string, string>();
  let skipped = 0;
  for (let i = 0; i < list.length; i += 50) {
    const r = await tickets<{
      created: { trelloId: string; id: string }[];
      skipped: { trelloId: string; id: string }[];
    }>("/import", {
      body: { tickets: list.slice(i, i + 50) },
    });
    for (const c of r.created) {
      created.set(c.trelloId, c.id);
    }
    for (const c of r.skipped) {
      known.set(c.trelloId, c.id);
    }
    skipped += r.skipped.length;
    console.log(`  ${Math.min(i + 50, list.length)}/${list.length} envoyés`);
  }
  let files = 0;
  let failed = 0;
  let present = 0;
  for (const card of cards) {
    const id = created.get(card.id) ?? known.get(card.id);
    const wanted = id ? (card.attachments ?? []).filter(isImportableFile) : [];
    if (!id || !wanted.length) {
      continue;
    }
    // Déjà recopiée : même nom et même taille (envoyée telle quelle), ou son nom converti (WebP, identifiant inclus)
    const have = known.has(card.id)
      ? (
          await tickets<{ ticket: { files: { name: string; size: number }[] } }>(`/${id}`, {
            method: "GET",
          })
        ).ticket.files
      : [];
    for (const a of wanted) {
      const suffix = `-${a.id.slice(-6)}`;
      const converted = storedName(`${a.name.replace(/\.\w+$/, "")}${suffix}.webp`);
      if (
        have.some(
          (f) => (f.name === storedName(a.name) && f.size === a.bytes) || f.name === converted
        )
      ) {
        present++;
        continue;
      }
      try {
        const res = await fetch(a.url, { headers: auth, signal: AbortSignal.timeout(60_000) });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const file = await shrinkImage(
          { bytes: new Uint8Array(await res.arrayBuffer()), type: a.mimeType ?? "", name: a.name },
          suffix
        );
        await tickets(`/${id}/files?name=${encodeURIComponent(file.name)}`, {
          method: "PUT",
          raw: file.bytes,
          type: file.type,
        });
        files++;
      } catch (err) {
        failed++;
        console.log(
          `  pièce jointe « ${a.name} » de « ${card.name} » non recopiée : ${(err as Error).message}`
        );
      }
    }
  }
  console.log(
    `Import terminé : ${created.size} tickets créés, ${skipped} déjà importés (sautés), ${files} fichiers recopiés, ${present} déjà présents${failed ? `, ${failed} fichiers en échec` : ""}.`
  );
}

main().catch((err: Error) => {
  console.error(`Import Trello : ${err.message}`);
  process.exit(1);
});
