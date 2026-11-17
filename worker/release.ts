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

type Bump = "patch" | "minor" | "major";
/** Entrée du journal (fragment .changeset/*.md ajouté sur develop depuis la dernière release). */
export interface Note {
  bump: Bump;
  summary: string;
}

export interface ReleaseState {
  /** Version en ligne (package.json de main). */
  version: string;
  /** Version qu'aura la release (bump le plus fort des fragments, comme scripts/changelogRelease.ts). */
  next: string;
  /** Entrées du journal qui partiront avec la release (sans doublons). */
  notes: Note[];
  /** Changements de develop pas encore dans main (titres des commits, sans les fusions). */
  pending: string[];
  /** Date du plus ancien changement en attente (ms) ; 0 sans changement. */
  since: number;
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

// Même lecture des fragments et même calcul de version que scripts/changesetLib.ts et
// scripts/changelogRelease.ts (qui lisent le disque, inutilisables ici) : comparés dans verify-release.ts
const SEVERITY: Record<Bump, number> = { patch: 1, minor: 2, major: 3 };

/** Fragment de journal (« ---\nbump: patch\n---\n<texte> ») ; null s'il est mal formé. */
export function parseFragment(content: string): Note | null {
  const m = content.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const bump = m?.[1].match(/^bump:\s*(\S+)\s*$/m)?.[1];
  const summary = m?.[2].trim();
  return bump && bump in SEVERITY && summary ? { bump: bump as Bump, summary } : null;
}

export function nextVersion(current: string, notes: Note[]): string {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) {
    return "";
  }
  const bump = notes.reduce<Bump>((a, n) => (SEVERITY[n.bump] > SEVERITY[a] ? n.bump : a), "patch");
  const [major, minor, patch] = m.slice(1).map(Number);
  return bump === "major"
    ? `${major + 1}.0.0`
    : bump === "minor"
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;
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
    d.gh<{
      commits?: {
        commit: { message: string; committer?: { date?: string } };
        parents: unknown[];
      }[];
      files?: { filename: string; status: string }[];
    }>(`/repos/${d.repo}/compare/main...develop`),
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
  const own = (cmp.commits ?? []).filter((c) => c.parents.length < 2);
  // Fragments du journal ajoutés sur develop depuis la dernière release
  const fragments = (cmp.files ?? [])
    .filter(
      (f) =>
        f.status === "added" &&
        /^\.changeset\/[^/]+\.md$/.test(f.filename) &&
        !/README/i.test(f.filename)
    )
    .slice(0, 20);
  const notes: Note[] = [];
  for (const f of fragments) {
    const file = await d
      .gh<{ content?: string }>(`/repos/${d.repo}/contents/${f.filename}?ref=develop`)
      .catch(() => ({ content: "" }));
    let note: Note | null = null;
    try {
      note = parseFragment(
        new TextDecoder().decode(
          Uint8Array.from(atob((file.content ?? "").replace(/\s/g, "")), (c) => c.charCodeAt(0))
        )
      );
    } catch {
      // fragment illisible : ignoré ici (la CI le refuse de toute façon)
    }
    if (note && !notes.some((n) => n.summary === note.summary && n.bump === note.bump)) {
      notes.push(note);
    }
  }
  return {
    version,
    next: own.length ? nextVersion(version, notes) : "",
    notes,
    pending: own
      .map((c) => c.commit.message.split("\n")[0])
      .reverse()
      .slice(0, 30),
    since: own.reduce((min, c) => {
      const t = Date.parse(c.commit.committer?.date ?? "") || 0;
      return t && (!min || t < min) ? t : min;
    }, 0),
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

// ---------- Dépendances : PR de Dependabot vers develop ----------

export interface DepPr {
  number: number;
  title: string;
  url: string;
  /** ok : CI passée, fusionnable ; wait : CI en cours ; fail : CI en échec. */
  state: "ok" | "wait" | "fail";
}

interface OpenPr extends PullRequest {
  html_url: string;
  user?: { login?: string };
}

const isDependabot = (p: OpenPr) => p.user?.login === "dependabot[bot]" && p.base.ref === "develop";

/** État de la CI sur le dernier commit d'une PR (sans rien changer à la PR). */
export async function ciState(d: ReleaseDeps, sha: string): Promise<DepPr["state"]> {
  const { workflow_runs: all = [] } = await d.gh<{
    workflow_runs?: { status: string; conclusion: string | null }[];
  }>(`/repos/${d.repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=10`);
  const runs = all.filter(
    (r) => !["action_required", "cancelled", "skipped", "stale"].includes(r.conclusion ?? "")
  );
  if (runs.some((r) => r.conclusion === "success")) {
    return "ok";
  }
  return !runs.length || runs.some((r) => r.status !== "completed") ? "wait" : "fail";
}

export async function dependencies(d: ReleaseDeps): Promise<DepPr[]> {
  const prs = (
    await d.gh<OpenPr[]>(`/repos/${d.repo}/pulls?state=open&base=develop&per_page=50`)
  ).filter(isDependabot);
  return Promise.all(
    prs.map(async (p) => ({
      number: p.number,
      title: p.title,
      url: p.html_url,
      state: await ciState(d, p.head.sha),
    }))
  );
}

/** PR de Dependabot fusionnée (squash) si elle contient tout develop et que sa CI est passée. */
export async function mergeDependency(d: ReleaseDeps, number: number): Promise<string> {
  const pr = await d.gh<OpenPr>(`/repos/${d.repo}/pulls/${number}`);
  if (!isDependabot(pr) || pr.state !== "open") {
    throw new TicketError("Ce n'est pas une PR de Dependabot ouverte vers develop", 409);
  }
  const check = await testedOnBase(d.gh, d.repo, pr);
  if (check?.wait) {
    return `PR #${number} : ${check.wait} ; réessaie quand la CI est passée`;
  }
  if (check?.fail) {
    throw new TicketError(`PR #${number} : ${check.fail} (à régler dans une session Claude)`, 409);
  }
  await d.gh(`/repos/${d.repo}/pulls/${number}/merge`, {
    method: "PUT",
    body: { merge_method: "squash", sha: pr.head.sha, commit_title: `${pr.title} (#${number})` },
  });
  return `PR #${number} fusionnée dans develop`;
}
