// Vérification de la logique pure des tickets envoyés à Claude
// (worker/tickets-logic.ts) et de la conversion des cartes Trello
// (scripts/trelloLib.ts). Pas de framework de test dans ce repo : script
// autonome, même principe que verify-changeset-parsing.ts.

import {
  EMPTY_DATA,
  TicketError,
  applyAction,
  cleanData,
  issueBody,
  positionBefore,
  previewFromComments,
  testedOnBase,
  type Gh,
  type PullRequest,
  type TicketData,
  type TicketStatus,
} from "../worker/tickets-logic.ts";
import {
  boardToTickets,
  cardToTicket,
  isImportableFile,
  statusOfList,
  type TrelloCard,
} from "./trelloLib.ts";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    console.log(`     attendu: ${JSON.stringify(expected)}`);
    console.log(`     obtenu : ${JSON.stringify(actual)}`);
  }
  if (ok) {
    passed++;
  } else {
    failed++;
  }
}
function refused(name: string, run: () => unknown): void {
  try {
    run();
    check(name, "accepté", "refusé");
  } catch (err) {
    check(name, err instanceof TicketError ? "refusé" : String(err), "refusé");
  }
}

const T0 = 1_700_000_000_000;
const ticket = (status: TicketStatus, data: Partial<TicketData> = {}) => ({
  status,
  data: { ...EMPTY_DATA, title: "Filtre plateformes", ...data },
});

// ---------- Nettoyage ----------
const dirty = cleanData({
  title: "  x ".repeat(100),
  model: "gpt",
  effort: "extreme",
  pr: "https://evil.example/pull/1",
  issue: "12; rm",
  links: [{ url: "javascript:alert(1)" }, { url: "https://seancy.com", title: "Site" }],
  labels: ["Bug", "", 3],
  stage: "boom",
  urgent: "1",
});
check("Titre borné à 200 caractères", dirty.title.length <= 200, true);
check("Modèle inconnu → opus", dirty.model, "opus");
check("Effort inconnu → high", dirty.effort, "high");
check("PR hors GitHub refusée", dirty.pr, "");
check("Numéro d'issue invalide refusé", dirty.issue, "");
check("Liens : seulement http(s)", dirty.links, [{ url: "https://seancy.com", title: "Site" }]);
check("Étiquettes vides retirées", dirty.labels, ["Bug", "3"]);
check("Étape inconnue vidée", dirty.stage, "");
check("Hotfix lu", dirty.urgent, true);

// ---------- Actions ----------
const sent = applyAction(ticket("todo"), { type: "send" }, T0);
check("Envoi : À faire → En cours", sent.status, "work");
check("Envoi : date notée", sent.data.sent, T0);
check(
  "Envoi : historique « envoi »",
  sent.data.history.map((e) => e.kind),
  ["envoi"]
);
refused("Envoi refusé depuis À valider", () => applyAction(ticket("review"), { type: "send" }, T0));
const relaunch = applyAction(ticket("work", { sent: T0 - 1, stage: "fail" }), { type: "send" }, T0);
check(
  "Relance d'un ticket arrêté",
  [relaunch.status, relaunch.data.history.at(-1)?.kind],
  ["work", "relance"]
);
refused("Envoi refusé pendant que Claude travaille", () =>
  applyAction(ticket("work", { sent: T0 - 1, stage: "work" }), { type: "send" }, T0)
);

const answered = applyAction(
  { status: sent.status, data: sent.data },
  {
    type: "answer",
    text: "Fait.",
    pr: "https://github.com/benjamin-ct/seancy/pull/42",
    notes: "n",
  },
  T0 + 1
);
check("Compte rendu : → À valider", answered.status, "review");
check(
  "Compte rendu : PR et notes gardées",
  [answered.data.pr, answered.data.notes, answered.data.sent],
  ["https://github.com/benjamin-ct/seancy/pull/42", "n", 0]
);
check("Compte rendu : historique « reponse »", answered.data.history.at(-1)?.kind, "reponse");
refused("Compte rendu vide refusé", () =>
  applyAction(ticket("work"), { type: "answer", text: " " }, T0)
);

const retouched = applyAction(answered, { type: "retouch", text: "Le bouton déborde" }, T0 + 2);
check(
  "Retouche : → En cours avec la demande",
  [retouched.status, retouched.data.feedback],
  ["work", "Le bouton déborde"]
);
check("Retouche : PR gardée (même branche)", retouched.data.pr, answered.data.pr);
refused("Retouche vide refusée", () => applyAction(answered, { type: "retouch", text: "" }, T0));

const queued = applyAction(answered, { type: "queue", followUp: "Note aussi l'idée" }, T0 + 3);
check(
  "Validation en file",
  [queued.status, queued.data.queued, queued.data.followUp],
  ["review", T0 + 3, "Note aussi l'idée"]
);
const fixing = applyAction(queued, { type: "autofix", text: "Conflit" }, T0 + 4);
check(
  "Correction automatique : reste en file",
  [fixing.status, fixing.data.queued, fixing.data.autofix],
  ["work", T0 + 3, 1]
);
const back = applyAction(fixing, { type: "answer", text: "Conflits réglés" }, T0 + 5);
check(
  "Correction rendue : à valider, toujours en file",
  [back.status, back.data.queued],
  ["review", T0 + 3]
);
const follow = applyAction(back, { type: "followup" }, T0 + 6);
check(
  "Suite après fusion : repart chez Claude sans PR",
  [follow.status, follow.data.pr, follow.data.feedback, follow.data.queued],
  ["work", "", "Note aussi l'idée", 0]
);
const done = applyAction(answered, { type: "done" }, T0 + 7);
check(
  "Validé : → Faits",
  [done.status, done.data.doneAt, done.data.history.at(-1)?.kind],
  ["done", T0 + 7, "valide"]
);
const reopened = applyAction(done, { type: "reopen", text: "Revenir dessus" }, T0 + 8);
check(
  "Réouverture : nouvelle PR, ancienne dans les notes",
  [reopened.status, reopened.data.pr, /pull\/42/.test(reopened.data.notes)],
  ["work", "", true]
);
refused("Réouverture refusée hors Faits", () =>
  applyAction(answered, { type: "reopen", text: "x" }, T0)
);
refused("Rangement refusé vers À valider", () =>
  applyAction(ticket("todo"), { type: "move", to: "review" }, T0)
);
check(
  "Idée → À faire",
  applyAction(ticket("idea"), { type: "move", to: "todo" }, T0).status,
  "todo"
);
const failedProg = applyAction(sent, { type: "progress", stage: "fail", text: "Erreur" }, T0 + 9);
check("Arrêt noté dans l'historique", failedProg.data.history.at(-1)?.kind, "arret");
check(
  "Modification : seuls les champs permis",
  applyAction(
    ticket("todo"),
    { type: "edit", fields: { title: "Nouveau", answer: "triche", status: "done" } },
    T0
  ).data.answer,
  ""
);
refused("Titre vidé refusé", () =>
  applyAction(ticket("todo"), { type: "edit", fields: { title: " " } }, T0)
);

const signed = applyAction(ticket("todo"), { type: "send" }, T0, "Benjamin");
check("Action signée du nom de l'administrateur", signed.data.history.at(-1)?.by, "Benjamin");
check(
  "Réponse de Claude jamais signée d'un administrateur",
  applyAction(signed, { type: "answer", text: "ok" }, T0, "Benjamin").data.history.at(-1)?.by,
  undefined
);
check(
  "Auteur jamais modifiable après coup",
  applyAction(
    ticket("todo", { author: "Benjamin" }),
    { type: "edit", fields: { author: "Autre" } },
    T0
  ).data.author,
  "Benjamin"
);
check(
  "Issue : réglages lisibles par le workflow",
  /Modèle : sonnet\. Effort : xhigh\. Hotfix : oui/.test(
    issueBody("a1b2c3d4e5f6", { ...EMPTY_DATA, model: "sonnet", effort: "xhigh", urgent: true })
  ),
  true
);
check(
  "Issue : base main pour un hotfix",
  /base `main`/.test(issueBody("a1b2c3d4e5f6", { ...EMPTY_DATA, urgent: true })),
  true
);

// ---------- Rangement ----------
const col = [
  { id: "a", position: 1024 },
  { id: "b", position: 2048 },
];
check("Rangement en fin de colonne", positionBefore(col, ""), 3072);
check("Rangement entre deux cartes", positionBefore(col, "b"), 1536);
check("Rangement en tête", positionBefore(col, "a") < 1024, true);

// ---------- Preview ----------
check(
  "Preview lue dans le commentaire de la CI",
  previewFromComments([
    { body: "autre" },
    {
      body: "🚀 **Preview deployed** for this commit\n\n👉 https://ticket-x-seancy.acme.workers.dev\n",
    },
  ]),
  "https://ticket-x-seancy.acme.workers.dev"
);
check("Pas de preview", previewFromComments([{ body: "rien" }]), "");

// ---------- Validation : PR prête ? ----------
const pr: PullRequest = {
  number: 42,
  title: "feat: x",
  draft: true,
  merged: false,
  state: "open",
  node_id: "n",
  base: { ref: "develop" },
  head: { ref: "ticket/x", sha: "abc" },
};
function fakeGh(
  behind: number,
  runs: { status: string; conclusion: string | null }[],
  conflict = false
): { gh: Gh; calls: string[] } {
  const calls: string[] = [];
  const gh = (async (path: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${path.split("?")[0]}`);
    if (path.includes("/compare/")) {
      return { behind_by: behind };
    }
    if (path.endsWith("/update-branch")) {
      if (conflict) {
        throw new Error("conflit");
      }
      return {};
    }
    return { workflow_runs: runs.map((r) => ({ ...r, html_url: "https://ci" })) };
  }) as Gh;
  return { gh, calls };
}
const main = async () => {
  const behind = fakeGh(2, []);
  check(
    "PR en retard : base fusionnée dedans, attente",
    (await testedOnBase(behind.gh, "o/r", pr))?.wait !== undefined,
    true
  );
  check(
    "PR en retard : update-branch appelé",
    behind.calls.includes("PUT /repos/o/r/pulls/42/update-branch"),
    true
  );
  check(
    "Conflit : correction automatique demandée",
    (await testedOnBase(fakeGh(1, [], true).gh, "o/r", pr))?.fix,
    "conflict"
  );
  check(
    "CI pas lancée : attente",
    (await testedOnBase(fakeGh(0, []).gh, "o/r", pr))?.wait,
    "CI pas encore lancée sur la PR"
  );
  check(
    "CI en cours : attente",
    (await testedOnBase(fakeGh(0, [{ status: "in_progress", conclusion: null }]).gh, "o/r", pr))
      ?.wait,
    "CI en cours sur la PR"
  );
  check(
    "CI verte : fusion possible",
    await testedOnBase(fakeGh(0, [{ status: "completed", conclusion: "success" }]).gh, "o/r", pr),
    null
  );
  check(
    "CI rouge : correction demandée",
    (await testedOnBase(fakeGh(0, [{ status: "completed", conclusion: "failure" }]).gh, "o/r", pr))
      ?.fix,
    "tests"
  );
  check(
    "CI annulée ignorée",
    (
      await testedOnBase(
        fakeGh(0, [{ status: "completed", conclusion: "cancelled" }]).gh,
        "o/r",
        pr
      )
    )?.wait,
    "CI pas encore lancée sur la PR"
  );

  // ---------- Trello ----------
  check("Liste Idées", statusOfList("Idées").status, "idea");
  check("Liste A faire", statusOfList("A faire").status, "todo");
  check("Liste En cours → À faire, étiquetée", statusOfList("En cours"), {
    status: "todo",
    label: "Était en cours sur Trello",
    rank: 0,
  });
  check("Liste A valider", statusOfList("À valider").status, "review");
  check("Liste To merge → À valider", statusOfList("To merge").status, "review");
  check("Liste Done", statusOfList("Done").status, "done");
  check("Liste inconnue → idée étiquetée", statusOfList("Backlog"), {
    status: "idea",
    label: "Liste Backlog",
    rank: 1,
  });

  const card: TrelloCard = {
    id: "c1",
    name: "Bug du filtre",
    desc: "Le filtre casse.\nEffort: xhigh",
    idList: "l4",
    pos: 3,
    shortUrl: "https://trello.com/c/abc",
    dateLastActivity: "2026-11-01T10:00:00.000Z",
    labels: [
      { name: "Bug", color: "red" },
      { name: "model:sonnet", color: null },
      { name: "Hotfix", color: "orange" },
    ],
    checklists: [
      {
        name: "À vérifier",
        checkItems: [
          { name: "Mobile", state: "complete", pos: 2 },
          { name: "Desktop", state: "incomplete", pos: 1 },
        ],
      },
    ],
    attachments: [
      {
        id: "a1",
        name: "capture.png",
        url: "https://trello.com/1/cards/c1/attachments/a1/download/capture.png",
        mimeType: "image/png",
        bytes: 1000,
        isUpload: true,
      },
      {
        id: "a2",
        name: "maquette",
        url: "https://figma.com/x",
        mimeType: null,
        bytes: null,
        isUpload: false,
      },
    ],
  };
  const t = cardToTicket(card, "A valider", [
    {
      cardId: "c1",
      at: 2,
      author: "Claude",
      text: "🤖 [Claude] PR : https://github.com/benjamin-ct/seancy/pull/7 prête",
    },
    { cardId: "c1", at: 1, author: "Benjamin", text: "Vu sur mobile" },
  ]);
  check("Carte : réglages repris", [t.model, t.effort, t.urgent], ["sonnet", "xhigh", true]);
  check(
    "Carte : créateur Trello = auteur du ticket",
    cardToTicket(card, "Idées", [], "Benjamin C.").author,
    "Benjamin C."
  );
  check("Carte : étiquettes de réglage retirées", t.labels, ["Bug"]);
  check(
    "Carte : checklist dans la description",
    t.detail.includes("- [ ] Desktop\n- [x] Mobile"),
    true
  );
  check("Carte : PR retrouvée", t.pr, "https://github.com/benjamin-ct/seancy/pull/7");
  check(
    "Carte : compte rendu = dernier commentaire de Claude",
    t.answer,
    "PR : https://github.com/benjamin-ct/seancy/pull/7 prête"
  );
  check(
    "Carte : commentaires dans l'ordre",
    t.trello.comments.map((c) => c.author),
    ["Benjamin", "Claude"]
  );
  check(
    "Carte : lien externe gardé, fichier recopié à part",
    t.links.map((l) => l.url),
    ["https://figma.com/x"]
  );
  check(
    "Fichier trop gros gardé en lien",
    isImportableFile({ ...card.attachments![0], bytes: 5_000_000 }),
    false
  );

  const ordered = boardToTickets(
    [
      { id: "l1", name: "A faire", pos: 1 },
      { id: "l2", name: "En cours", pos: 2 },
    ],
    [
      { ...card, id: "x", idList: "l1", pos: 1, labels: [], attachments: [] },
      { ...card, id: "y", idList: "l2", pos: 1, labels: [], attachments: [] },
      { ...card, id: "z", idList: "l9", pos: 1, labels: [], attachments: [] },
    ],
    []
  );
  check(
    "Board : « En cours » avant « A faire », carte sans liste ignorée",
    ordered.map((x) => [x.trelloId, x.status, x.position]),
    [
      ["y", "todo", 1024],
      ["x", "todo", 2048],
    ]
  );

  console.log(`\n${passed} OK, ${failed} en échec`);
  process.exit(failed ? 1 : 0);
};
void main();
