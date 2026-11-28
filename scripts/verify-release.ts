// Vérification de la release depuis le tableau de bord (worker/release.ts),
// contre un faux GitHub en mémoire : rien n'est envoyé au vrai dépôt.
// Pas de framework de test dans ce repo : script autonome, même principe que
// verify-tickets.ts.

import {
  versionOnly,
  RELEASE_PREFIX,
  dependencies,
  finishRelease,
  mergeDependency,
  nextVersion,
  openRelease,
  parisStamp,
  parseFragment,
  releaseState,
  startRelease,
  type ReleaseDeps,
} from "../worker/release.ts";
import { changeNeedsRelease } from "../worker/release-scope.ts";
import { TicketError } from "../worker/tickets-logic.ts";
import { aggregateBump, bumpVersion } from "./changelogRelease.ts";
import { isChangesetError, parseChangeset } from "./changesetLib.ts";

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

interface FakePr {
  number: number;
  title: string;
  draft: boolean;
  merged: boolean;
  state: string;
  node_id: string;
  html_url: string;
  base: { ref: string };
  head: { ref: string; sha: string };
  user?: { login: string };
}

/** Faux GitHub : quelques routes de l'API utilisées par la release, appels notés dans `log`. */
function fakeGitHub(opts: {
  commits?: string[];
  prs?: FakePr[];
  ci?: "success" | "failure" | "in_progress" | "none";
  conflict?: boolean;
  behindBy?: number;
  /** Fragments du journal ajoutés sur develop : nom → contenu. */
  fragments?: Record<string, string>;
  /** develop ne diffère de main que par le numéro de version (resynchronisation). */
  versionOnly?: boolean;
  /** Fichiers d'un commit (par titre) ; src/a.ts sinon. */
  commitFiles?: Record<string, string[]>;
}) {
  const log: string[] = [];
  const meta = new Map<string, string>();
  const notes: string[] = [];
  const prs = [...(opts.prs ?? [])];
  const pkg = Buffer.from(JSON.stringify({ version: "0.1.14" })).toString("base64");
  const gh = async <T>(
    path: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<T> => {
    const m = init.method ?? "GET";
    log.push(`${m} ${path}`);
    const ok = (v: unknown) => v as T;
    if (m === "GET" && path.includes("/compare/main...develop")) {
      return ok({
        commits: [
          ...(opts.commits ?? []).map((t, i) => ({
            sha: `c${i}`,
            commit: {
              message: `${t}\n\ndétail`,
              committer: { date: `2026-11-1${i}T10:00:00Z` },
            },
            parents: [1],
          })),
          { commit: { message: "Merge branch 'main' into release" }, parents: [1, 2] },
        ],
        files: opts.versionOnly
          ? [
              {
                filename: "package.json",
                status: "modified",
                patch:
                  '@@ -1,4 +1,4 @@\n {\n   "name": "seancy",\n-  "version": "0.1.18",\n+  "version": "0.1.0",',
              },
              {
                filename: "package-lock.json",
                status: "modified",
                patch:
                  '@@ -3 +3 @@\n-  "version": "0.1.18",\n+  "version": "0.1.0",\n@@ -9 +9 @@\n-      "version": "0.1.18",\n+      "version": "0.1.0",',
              },
            ]
          : [
              ...Object.keys(opts.fragments ?? {}).map((n) => ({
                filename: `.changeset/${n}`,
                status: "added",
              })),
              { filename: ".changeset/ancien.md", status: "removed" },
              { filename: "src/a.ts", status: "added" },
            ],
      });
    }
    const commitSha = /\/commits\/(c\d+)$/.exec(path)?.[1];
    if (m === "GET" && commitSha) {
      const t = (opts.commits ?? [])[Number(commitSha.slice(1))] ?? "";
      return ok({
        files: (opts.commitFiles?.[t] ?? ["src/a.ts"]).map((filename) => ({ filename })),
      });
    }
    if (m === "GET" && path.includes("/contents/.changeset/")) {
      const name = path.split("/contents/.changeset/")[1].split("?")[0];
      return ok({ content: Buffer.from(opts.fragments?.[name] ?? "").toString("base64") });
    }
    if (m === "GET" && /\/pulls\/\d+$/.test(path)) {
      const n = Number(path.split("/").pop());
      return ok(prs.find((p) => p.number === n) ?? {});
    }
    if (m === "GET" && path.includes("/compare/main...")) {
      return ok({ behind_by: opts.behindBy ?? 0 });
    }
    if (m === "GET" && path.includes("/contents/package.json")) {
      return ok({ content: pkg });
    }
    if (m === "GET" && path.includes("/pulls?state=open")) {
      const base = /base=(\w+)/.exec(path)?.[1];
      return ok(prs.filter((p) => !base || p.base.ref === base));
    }
    if (m === "GET" && path.includes("/actions/workflows/ci.yml/runs")) {
      const ci = opts.ci ?? "success";
      return ok({
        workflow_runs:
          ci === "none"
            ? []
            : [
                {
                  status: ci === "in_progress" ? "in_progress" : "completed",
                  conclusion: ci === "in_progress" ? null : ci,
                  html_url: "https://github.com/run/1",
                },
              ],
      });
    }
    if (m === "GET" && path.endsWith("/git/ref/heads/develop")) {
      return ok({ object: { sha: "dev123" } });
    }
    if (m === "POST" && path.endsWith("/merges")) {
      if (opts.conflict) {
        throw new Error("GitHub : Merge conflict");
      }
      return ok({});
    }
    if (m === "POST" && path.endsWith("/pulls")) {
      const b = init.body as { title: string; head: string };
      prs.push({
        number: 500,
        title: b.title,
        draft: false,
        merged: false,
        state: "open",
        node_id: "N500",
        html_url: "https://github.com/pull/500",
        base: { ref: "main" },
        head: { ref: b.head, sha: "rel456" },
      });
      return ok({ number: 500 });
    }
    return ok({});
  };
  const d: ReleaseDeps = {
    gh,
    repo: "o/r",
    getMeta: async (k) => meta.get(k) ?? null,
    setMeta: async (k, v) => meta.set(k, v),
    notify: async (t) => {
      notes.push(t);
    },
  };
  return { d, log, notes, prs };
}

const releasePr = (over: Partial<FakePr> = {}): FakePr => ({
  number: 42,
  title: "chore(release): develop → main (2026-11-17 18h40)",
  draft: false,
  merged: false,
  state: "open",
  node_id: "N42",
  html_url: "https://github.com/pull/42",
  base: { ref: "main" },
  head: { ref: `${RELEASE_PREFIX}2026-11-17-18h40`, sha: "abc" },
  ...over,
});

async function refusedAsync(name: string, run: () => Promise<unknown>, why: RegExp) {
  try {
    await run();
    check(name, "accepté", "refusé");
  } catch (err) {
    check(
      name,
      err instanceof TicketError && why.test(err.message) ? "refusé" : String(err),
      "refusé"
    );
  }
}

const main = async () => {
  // Heure de Paris (hiver : UTC+1)
  check("Nom de la branche : jour et heure de Paris", parisStamp(Date.UTC(2026, 10, 17, 17, 5)), {
    day: "2026-11-17",
    time: "18h05",
  });

  // État : version de main, changements de develop sans les fusions, dans l'ordre
  {
    const { d } = fakeGitHub({ commits: ["fix(a): un", "feat(b): deux"] });
    const s = await releaseState(d);
    check("État : version en ligne lue sur main", s.version, "0.1.14");
    check("État : changements de develop, fusions retirées, plus récent d'abord", s.pending, [
      "feat(b): deux",
      "fix(a): un",
    ]);
    check("État : pas de release en cours", s.pr, null);
  }

  // Lancement : branche depuis develop, main fusionné dedans, PR vers main
  {
    const { d, log } = fakeGitHub({ commits: ["fix: x"], ci: "in_progress" });
    const s = await startRelease(d, Date.UTC(2026, 10, 17, 17, 40));
    check(
      "Lancement : branche release/<jour>-<heure> créée depuis develop",
      log.includes("POST /repos/o/r/git/refs"),
      true
    );
    check(
      "Lancement : main fusionné dans la branche",
      log.includes("POST /repos/o/r/merges"),
      true
    );
    check("Lancement : PR ouverte vers main", log.includes("POST /repos/o/r/pulls"), true);
    check("Lancement : la release en cours attend la CI", s.pr?.state, "wait");
  }
  {
    const { d } = fakeGitHub({ commits: [] });
    await refusedAsync(
      "Lancement refusé sans rien de nouveau sur develop",
      () => startRelease(d, 0),
      /Rien de nouveau/
    );
  }
  {
    const { d, log } = fakeGitHub({ commits: ["fix: x"], prs: [releasePr()], ci: "in_progress" });
    await refusedAsync(
      "Lancement refusé pendant une release en cours",
      () => startRelease(d, 0),
      /déjà en cours/
    );
    check(
      "Release en cours : aucune branche créée",
      log.includes("POST /repos/o/r/git/refs"),
      false
    );
  }
  {
    const { d, log } = fakeGitHub({ commits: ["fix: x"], conflict: true });
    await refusedAsync(
      "Conflit develop / main : refusé avec la raison",
      () => startRelease(d, 0),
      /conflit/
    );
    check(
      "Conflit : la branche créée est supprimée, pas de PR",
      [
        log.some((l) => l.startsWith("DELETE /repos/o/r/git/refs/heads/release")),
        log.includes("POST /repos/o/r/pulls"),
      ],
      [true, false]
    );
  }

  // Suivi : fusion dès que la CI est passée, une notification par échec
  {
    const { d, log, notes } = fakeGitHub({ prs: [releasePr()], ci: "success" });
    const r = await finishRelease(d, await openRelease(d));
    check("CI passée : PR fusionnée en merge commit", r?.state, "merged");
    check("CI passée : fusion « merge »", log.includes("PUT /repos/o/r/pulls/42/merge"), true);
    check(
      "CI passée : branche de la release supprimée",
      log.some((l) => l.startsWith("DELETE /repos/o/r/git/refs/heads/release")),
      true
    );
    check(
      "CI passée : notification « fusionnée »",
      notes.length === 1 && /fusionnée/.test(notes[0]),
      true
    );
  }
  {
    const { d, log } = fakeGitHub({ prs: [releasePr()], ci: "in_progress" });
    const r = await finishRelease(d, await openRelease(d));
    check(
      "CI en cours : pas de fusion",
      [r?.state, log.some((l) => l.startsWith("PUT"))],
      ["wait", false]
    );
  }
  {
    const { d, notes } = fakeGitHub({ prs: [releasePr()], ci: "failure" });
    const pr = await openRelease(d);
    const r = await finishRelease(d, pr);
    await finishRelease(d, pr);
    check("CI en échec : état « bloquée »", r?.state, "fail");
    check("CI en échec : une seule notification pour le même code", notes.length, 1);
  }
  {
    const { d, log } = fakeGitHub({ prs: [releasePr()], behindBy: 1 });
    const r = await finishRelease(d, await openRelease(d));
    check(
      "main a bougé : PR remise à jour, pas de fusion",
      [
        r?.state,
        log.includes("PUT /repos/o/r/pulls/42/update-branch"),
        log.includes("PUT /repos/o/r/pulls/42/merge"),
      ],
      ["wait", true, false]
    );
  }
  {
    const { d } = fakeGitHub({
      prs: [releasePr({ number: 7, head: { ref: "ticket/autre", sha: "x" } })],
    });
    check("PR vers main qui n'est pas une release : ignorée", await openRelease(d), null);
  }

  // Journal et version à venir : mêmes règles que la compilation de la release (scripts/)
  {
    const samples = [
      "---\nbump: patch\n---\n\nCorrection.\n",
      "---\nbump: minor\n---\nNouveauté.",
      "---\nbump: major\n---\nGros changement.",
      "---\nbump: oups\n---\nTexte",
      "sans en-tête",
      "---\nbump: patch\n---\n   \n",
    ];
    check(
      "Fragments : même lecture que scripts/changesetLib.ts",
      samples.map((c) => parseFragment(c)),
      samples.map((c) => {
        const r = parseChangeset("x.md", c);
        return isChangesetError(r) ? null : { bump: r.bump, summary: r.summary };
      })
    );
    for (const bumps of [["patch"], ["patch", "minor"], ["major", "patch"], []] as const) {
      const notes = bumps.map((b) => ({ bump: b, summary: "s" }));
      check(
        `Version à venir (${bumps.join(", ") || "sans fragment"}) : même calcul que changelogRelease.ts`,
        nextVersion("1.2.3", notes),
        bumpVersion("1.2.3", aggregateBump(notes.map((n) => ({ file: "f", ...n }))))
      );
    }
  }
  {
    const { d } = fakeGitHub({
      commits: ["fix: a", "feat: b"],
      fragments: {
        "a.md": "---\nbump: patch\n---\nAméliorations internes.",
        "b.md": "---\nbump: minor\n---\nNouvelle page.",
        "c.md": "---\nbump: patch\n---\nAméliorations internes.",
      },
    });
    const s = await releaseState(d);
    check("État : prochaine version d'après les fragments (minor)", s.next, "0.2.0");
    check("État : entrées du journal sans doublon", s.notes, [
      { bump: "patch", summary: "Améliorations internes." },
      { bump: "minor", summary: "Nouvelle page." },
    ]);
    check("État : date du plus ancien changement", s.since, Date.parse("2026-11-10T10:00:00Z"));
  }
  {
    const { d } = fakeGitHub({ commits: [] });
    const s = await releaseState(d);
    check("État sans changement : ni version à venir ni date", [s.next, s.since], ["", 0]);
  }
  {
    // main ramené dans develop : seul le commit qui garde la version de develop diffère
    const { d } = fakeGitHub({
      commits: ["chore: version de develop gardée lors de la resynchronisation avec main"],
      versionOnly: true,
    });
    const s = await releaseState(d);
    check(
      "Seul le numéro de version diffère : rien à publier",
      [s.pending, s.next, s.since],
      [[], "", 0]
    );
  }

  // Admin et tickets : en ligne dès la fusion dans develop (Worker de l'admin), pas d'attente de release
  for (const [files, expected] of [
    [["src/modules/tickets/TicketsPage.tsx", ".changeset/x.md"], false],
    [["src/modules/admin/Release.tsx", "worker/release.ts", "worker/tickets.ts"], false],
    [
      ["migrations/0030_x.sql", "scripts/verify-tickets.ts", ".claude/skills/ticket/SKILL.md"],
      false,
    ],
    [["wrangler.admin.jsonc", "README.md"], false],
    [["src/modules/tickets/api.ts", "src/sw.ts"], true],
    [["worker/tickets.ts", "worker/index.ts"], true],
    [["src/shared/components/Icon/Icon.tsx"], true],
    [["package.json", "package-lock.json"], true],
    [[".github/workflows/claude-tickets.yml"], true],
    [["public/manifest.webmanifest"], true],
  ] as const) {
    check(
      `Release ${expected ? "requise" : "inutile"} : ${files.join(", ")}`,
      changeNeedsRelease(files),
      expected
    );
  }
  {
    const { d, log } = fakeGitHub({
      commits: ["fix(tickets): a", "feat(detail): b", "feat(admin): c"],
      commitFiles: {
        "fix(tickets): a": ["src/modules/tickets/TicketSheet.tsx"],
        "feat(admin): c": ["src/modules/admin/Tools.tsx", "worker/admin.ts"],
      },
    });
    const s = await releaseState(d);
    check("État : seuls les changements du site attendent la release", s.pending, [
      "feat(detail): b",
    ]);
    check("État : admin et tickets déjà en ligne", s.live, ["feat(admin): c", "fix(tickets): a"]);
    check(
      "État : date du changement du site seulement",
      s.since,
      Date.parse("2026-11-11T10:00:00Z")
    );
    const calls = log.filter((l) => l.includes("/commits/c")).length;
    await releaseState(d);
    check(
      "Fichiers d'un commit lus une seule fois (gardés en mémoire)",
      log.filter((l) => l.includes("/commits/c")).length,
      calls
    );
  }
  {
    const { d } = fakeGitHub({
      commits: ["fix(tickets): a"],
      commitFiles: { "fix(tickets): a": ["src/modules/tickets/TicketSheet.tsx"] },
    });
    const s = await releaseState(d);
    check(
      "Seulement l'admin sur develop : rien à mettre en ligne, pas de version à venir",
      [s.pending, s.next, s.since],
      [[], "", 0]
    );
    await refusedAsync(
      "Seulement l'admin sur develop : release refusée (déjà en ligne)",
      () => startRelease(d, Date.UTC(2026, 10, 17, 17, 40)),
      /déjà en ligne/
    );
  }
  {
    const { d } = fakeGitHub({
      commits: ["fix: x"],
      commitFiles: { "fix: x": [] },
    });
    const s = await releaseState(d);
    check("Fichiers d'un commit illisibles : compté comme attendant la release", s.pending, [
      "fix: x",
    ]);
  }
  check(
    "Version seule : une autre ligne changée dans package.json compte",
    versionOnly({
      filename: "package.json",
      patch: '-  "version": "0.1.18",\n+  "version": "0.1.0",\n+    "x": "1",',
    }),
    false
  );

  // Dépendances : PR de Dependabot vers develop
  const depPr = (n: number, over: Partial<FakePr> = {}): FakePr => ({
    ...releasePr({
      number: n,
      title: `chore(deps): bump x ${n}`,
      base: { ref: "develop" },
      head: { ref: `dependabot/npm/x-${n}`, sha: `s${n}` },
      user: { login: "dependabot[bot]" },
    }),
    ...over,
  });
  {
    const { d } = fakeGitHub({
      prs: [depPr(1), depPr(2, { user: { login: "quelqu-un" } }), releasePr()],
      ci: "success",
    });
    check(
      "Dépendances : seulement les PR de Dependabot vers develop",
      (await dependencies(d)).map((p) => [p.number, p.state]),
      [[1, "ok"]]
    );
  }
  {
    const { d, log } = fakeGitHub({ prs: [depPr(1)], ci: "success" });
    const msg = await mergeDependency(d, 1);
    check(
      "Dépendance à CI passée : fusionnée en squash",
      [/fusionnée/.test(msg), log.includes("PUT /repos/o/r/pulls/1/merge")],
      [true, true]
    );
  }
  {
    const { d, log } = fakeGitHub({ prs: [depPr(1)], ci: "in_progress" });
    const msg = await mergeDependency(d, 1);
    check(
      "Dépendance à CI en cours : pas fusionnée, message d'attente",
      [/réessaie/.test(msg), log.includes("PUT /repos/o/r/pulls/1/merge")],
      [true, false]
    );
  }
  {
    const { d } = fakeGitHub({ prs: [depPr(1)], ci: "failure" });
    await refusedAsync("Dépendance à CI en échec : refusée", () => mergeDependency(d, 1), /échec/);
  }
  {
    const { d } = fakeGitHub({ prs: [depPr(2, { user: { login: "quelqu-un" } })] });
    await refusedAsync(
      "Fusion refusée pour une PR qui n'est pas de Dependabot",
      () => mergeDependency(d, 2),
      /Dependabot/
    );
  }

  console.log(`\n${passed} OK, ${failed} en échec`);
  process.exit(failed ? 1 : 0);
};
void main();
