// Vérification de la release depuis le tableau de bord (worker/release.ts),
// contre un faux GitHub en mémoire : rien n'est envoyé au vrai dépôt.
// Pas de framework de test dans ce repo : script autonome, même principe que
// verify-tickets.ts.

import {
  RELEASE_PREFIX,
  finishRelease,
  openRelease,
  parisStamp,
  releaseState,
  startRelease,
  type ReleaseDeps,
} from "../worker/release.ts";
import { TicketError } from "../worker/tickets-logic.ts";

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
}

/** Faux GitHub : quelques routes de l'API utilisées par la release, appels notés dans `log`. */
function fakeGitHub(opts: {
  commits?: string[];
  prs?: FakePr[];
  ci?: "success" | "failure" | "in_progress" | "none";
  conflict?: boolean;
  behindBy?: number;
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
          ...(opts.commits ?? []).map((t) => ({
            commit: { message: `${t}\n\ndétail` },
            parents: [1],
          })),
          { commit: { message: "Merge branch 'main' into release" }, parents: [1, 2] },
        ],
      });
    }
    if (m === "GET" && path.includes("/compare/main...")) {
      return ok({ behind_by: opts.behindBy ?? 0 });
    }
    if (m === "GET" && path.includes("/contents/package.json")) {
      return ok({ content: pkg });
    }
    if (m === "GET" && path.includes("/pulls?state=open")) {
      return ok(prs);
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

  console.log(`\n${passed} OK, ${failed} en échec`);
  process.exit(failed ? 1 : 0);
};
void main();
