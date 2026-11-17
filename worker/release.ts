// Release develop → main depuis le tableau de bord de l'espace admin, sans
// ticket : « Lancer la release » crée une branche release/<date> depuis
// develop, y fusionne main (numéro de version et journal déjà publiés) et
// ouvre la PR vers main ; le serveur la fusionne (merge commit, comme à la
// main) dès que la CI est passée, quand le tableau de bord est ouvert ou au
// passage régulier des tickets. Ensuite, la CI de main compile le journal,
// monte la version et Workers Builds met en ligne.
//
// Les appels à GitHub, la mémoire et les notifications sont passés en
// paramètre (worker/tickets.ts) : vérifiable seul (scripts/verify-release.ts).
import { TicketError, testedOnBase, type Gh, type PullRequest } from "./tickets-logic.ts";

export const RELEASE_PREFIX = "release/";

export interface ReleaseDeps {
  gh: Gh;
  repo: string;
  getMeta: (k: string) => Promise<string | null>;
  setMeta: (k: string, v: string) => Promise<unknown>;
  /** Notification push et Discord (lien vers le tableau de bord). */
  notify: (text: string) => Promise<void>;
}

interface ReleasePr extends PullRequest {
  html_url: string;
}

export interface ReleaseState {
  /** Version en ligne (package.json de main). */
  version: string;
  /** Changements de develop pas encore dans main (titres des commits, sans les fusions). */
  pending: string[];
  /** Release en cours ; null sans release en cours. */
  pr: { number: number; url: string; state: "wait" | "fail" | "merged"; why: string } | null;
}

/** Jour et heure de Paris : nom de la branche et titre de la PR. */
export function parisStamp(now: number): { day: string; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value])
  );
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}h${p.minute}` };
}

export async function openRelease(d: ReleaseDeps): Promise<ReleasePr | null> {
  const prs = await d.gh<ReleasePr[]>(`/repos/${d.repo}/pulls?state=open&base=main&per_page=30`);
  return prs.find((p) => p.head.ref.startsWith(RELEASE_PREFIX)) ?? null;
}

/** Release en cours : fusionnée dans main si la CI est passée ; sinon son état. */
export async function finishRelease(
  d: ReleaseDeps,
  pr: ReleasePr | null
): Promise<ReleaseState["pr"]> {
  if (!pr) {
    return null;
  }
  const check = await testedOnBase(d.gh, d.repo, pr);
  const base = { number: pr.number, url: pr.html_url };
  if (check?.wait) {
    return { ...base, state: "wait", why: check.wait };
  }
  if (check?.fail) {
    // Une seule notification par échec (même code)
    if ((await d.getMeta("releaseFail")) !== pr.head.sha) {
      await d.setMeta("releaseFail", pr.head.sha);
      await d.notify(`🚨 Release #${pr.number} bloquée : ${check.fail}`);
    }
    return { ...base, state: "fail", why: check.fail };
  }
  if (pr.draft) {
    await d.gh("/graphql", {
      method: "POST",
      body: {
        query:
          "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }",
        variables: { id: pr.node_id },
      },
    });
  }
  await d.gh(`/repos/${d.repo}/pulls/${pr.number}/merge`, {
    method: "PUT",
    body: {
      merge_method: "merge",
      sha: pr.head.sha,
      commit_title: `Merge pull request #${pr.number} : ${pr.title.replace(/^chore\(release\):\s*/, "release ")}`,
    },
  });
  await d
    .gh(`/repos/${d.repo}/git/refs/heads/${encodeURIComponent(pr.head.ref)}`, {
      method: "DELETE",
    })
    .catch(() => {});
  await d.notify(
    `🚀 Release #${pr.number} fusionnée dans main : la nouvelle version part en ligne (quelques minutes)`
  );
  return { ...base, state: "merged", why: "Fusionnée dans main : mise en ligne en cours" };
}

export async function releaseState(d: ReleaseDeps): Promise<ReleaseState> {
  const [cmp, pkg, pr] = await Promise.all([
    d.gh<{ commits?: { commit: { message: string }; parents: unknown[] }[] }>(
      `/repos/${d.repo}/compare/main...develop`
    ),
    d
      .gh<{ content?: string }>(`/repos/${d.repo}/contents/package.json?ref=main`)
      .catch(() => ({ content: "" })),
    openRelease(d),
  ]);
  let version = "";
  try {
    version =
      (JSON.parse(atob((pkg.content ?? "").replace(/\s/g, ""))) as { version?: string }).version ??
      "";
  } catch {
    // package.json illisible : version non montrée
  }
  return {
    version,
    pending: (cmp.commits ?? [])
      .filter((c) => c.parents.length < 2)
      .map((c) => c.commit.message.split("\n")[0])
      .reverse()
      .slice(0, 30),
    pr: await finishRelease(d, pr),
  };
}

export async function startRelease(d: ReleaseDeps, now: number): Promise<ReleaseState> {
  const running = await openRelease(d);
  if (running) {
    throw new TicketError(`Une release est déjà en cours (#${running.number})`, 409);
  }
  const state = await releaseState(d);
  if (!state.pending.length) {
    throw new TicketError("Rien de nouveau sur develop depuis la dernière release", 409);
  }
  const { day, time } = parisStamp(now);
  const branch = `${RELEASE_PREFIX}${day}-${time}`;
  const dev = await d.gh<{ object: { sha: string } }>(`/repos/${d.repo}/git/ref/heads/develop`);
  await d.gh(`/repos/${d.repo}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: dev.object.sha },
  });
  try {
    await d.gh(`/repos/${d.repo}/merges`, {
      method: "POST",
      body: { base: branch, head: "main", commit_message: `Merge branch 'main' into ${branch}` },
    });
  } catch {
    await d
      .gh(`/repos/${d.repo}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "DELETE" })
      .catch(() => {});
    throw new TicketError(
      "develop et main sont en conflit : la release est à faire dans une session Claude",
      409
    );
  }
  await d.setMeta("releaseFail", "");
  await d.gh(`/repos/${d.repo}/pulls`, {
    method: "POST",
    body: {
      title: `chore(release): develop → main (${day} ${time})`,
      head: branch,
      base: "main",
      // Dépôt public : seulement les titres des commits, déjà publics
      body: [
        "## Release",
        "",
        "Lancée depuis le tableau de bord de l'espace admin : `develop` avec `main` refusionné, fusionnée dans `main` dès que la CI est passée.",
        "",
        ...state.pending.map((t) => `- ${t}`),
      ].join("\n"),
    },
  });
  return releaseState(d);
}
