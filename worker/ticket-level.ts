// Modèle et effort choisis automatiquement pour un ticket envoyé à Claude.
//
// L'IA ne décide pas : elle décrit le ticket (questions factuelles, FACTS_ASK),
// puis une grille fixe en déduit le niveau (levelOf). Grille calibrée le 19 nov.
// sur 230 tickets déjà faits de Seancy et de Paddock Live, en comparant le
// niveau choisi à la taille réelle de leur PR (fichiers et lignes) et à leurs
// retouches : 11 sous-estimés (presque tous d'un seul niveau, dont plusieurs
// faux écarts : fusion de release, PR plus large que le ticket), aucun petit
// ticket raté de plus de deux niveaux. En cas de doute, on monte : une
// sous-estimation coûte une retouche, une surestimation un peu de quota.
// Logique pure : vérifiée par scripts/verify-tickets.ts.

export type Level = 0 | 1 | 2 | 3;
export const LEVELS: readonly { model: "sonnet" | "opus"; effort: "medium" | "high" | "xhigh" }[] =
  [
    { model: "sonnet", effort: "medium" },
    { model: "sonnet", effort: "high" },
    { model: "opus", effort: "high" },
    { model: "opus", effort: "xhigh" },
  ];
const NAMES = ["Sonnet · moyen", "Sonnet · élevé", "Opus · élevé", "Opus · très élevé"];

export interface Facts {
  nature: "bug" | "nouveaute" | "amelioration" | "texte_ou_style" | "outillage";
  ampleur: "petite" | "moyenne" | "grande";
  zones: number;
  serveur: boolean;
  donnees: boolean;
  securite: boolean;
  cause_inconnue: boolean;
  incertain: boolean;
}

export const FACTS_ASK = `Tu évalues un ticket de développement pour Seancy, un site de suivi de films et de séries (React, Cloudflare Worker, base D1). Ne propose pas de solution : décris seulement le travail demandé.

Réponds uniquement par un objet JSON, sans texte autour, avec ces champs :
- "nature" : "bug" (quelque chose ne marche pas), "nouveaute" (fonction qui n'existe pas), "amelioration" (changer une fonction existante), "texte_ou_style" (libellé, couleur, icône, marge, alignement) ou "outillage" (scripts, tests, workflows, déploiement)
- "ampleur" : "petite" (un détail à un seul endroit), "moyenne" (une fonction ou un écran), "grande" (plusieurs écrans, une fonction complète, une refonte, une série de changements)
- "zones" : nombre de parties différentes à modifier (écrans, composants, serveur, base de données, workflow…), entier de 1 à 6
- "serveur" : true si le serveur, l'API, la base de données, les notifications, une tâche planifiée ou un workflow doit changer
- "donnees" : true si des données des utilisateurs, une migration de base ou une synchronisation entre appareils sont en jeu
- "securite" : true si la connexion, les droits, des secrets ou la sécurité sont en jeu
- "cause_inconnue" : true seulement pour un bug dont la cause n'est pas donnée et pas évidente (intermittent, « parfois », difficile à reproduire)
- "incertain" : true si le ticket est trop court ou trop vague pour juger

Ticket :
`;

const NATURES = ["bug", "nouveaute", "amelioration", "texte_ou_style", "outillage"] as const;
const AMPLEURS = ["petite", "moyenne", "grande"] as const;

/** Réponse du modèle → faits ; null si elle n'est pas lisible (le ticket garde alors ses réglages). */
export function parseFacts(out: string): Facts | null {
  try {
    const raw = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as Record<
      string,
      unknown
    >;
    const nature = NATURES.find((n) => n === raw.nature);
    const ampleur = AMPLEURS.find((a) => a === raw.ampleur);
    if (!nature || !ampleur) {
      return null;
    }
    const flag = (k: string) => raw[k] === true;
    return {
      nature,
      ampleur,
      zones: Math.min(6, Math.max(1, Math.round(Number(raw.zones) || 1))),
      serveur: flag("serveur"),
      donnees: flag("donnees"),
      securite: flag("securite"),
      cause_inconnue: flag("cause_inconnue"),
      incertain: flag("incertain"),
    };
  } catch {
    return null;
  }
}

/**
 * Grille : points d'ampleur (petite 0, moyenne 2, grande 4), +1 par partie au-delà de deux,
 * +1 serveur, +2 sécurité, +1 bug à la cause inconnue, +1 nouvelle fonction ; moins de 2 points :
 * Sonnet · moyen, 2 : Sonnet · élevé, 3 à 6 : Opus · élevé, 7 et plus : Opus · très élevé.
 */
export function levelOf(f: Facts): { level: Level; why: string } {
  let points = { petite: 0, moyenne: 2, grande: 4 }[f.ampleur];
  points += Math.max(0, f.zones - 2);
  points += (f.serveur ? 1 : 0) + (f.securite ? 2 : 0) + (f.cause_inconnue ? 1 : 0);
  points += f.nature === "nouveaute" ? 1 : 0;
  const level: Level = points < 2 ? 0 : points < 3 ? 1 : points < 7 ? 2 : 3;
  const kind = {
    bug: "bug",
    nouveaute: "nouvelle fonction",
    amelioration: "amélioration",
    texte_ou_style: "texte ou style",
    outillage: "outillage",
  }[f.nature];
  const reasons = [
    `${kind} ${f.ampleur === "petite" ? "à un seul endroit" : f.ampleur === "moyenne" ? "d'ampleur moyenne" : "de grande ampleur"}`,
    f.zones > 2 ? `${f.zones} parties à modifier` : "",
    f.serveur ? "serveur" : "",
    f.securite ? "sécurité" : "",
    f.cause_inconnue ? "cause inconnue" : "",
  ].filter(Boolean);
  return { level, why: reasons.join(", ") };
}

/** Niveau d'un modèle et d'un effort déjà réglés (le plus proche de la grille). */
export function levelFrom(model: string, effort: string): Level {
  if (model === "sonnet") {
    return effort === "low" || effort === "medium" ? 0 : 1;
  }
  return effort === "xhigh" || effort === "max" ? 3 : 2;
}

/**
 * Niveau final : correction urgente au moins Opus · élevé ; une retouche ne redescend jamais sous le
 * niveau du passage précédent, et monte d'un cran à la deuxième retouche ou après une correction
 * automatique.
 */
export function finalLevel(
  base: Level,
  ctx: { urgent: boolean; retouch: boolean; previous: Level; retouches: number; autofix: number }
): { level: Level; extra: string } {
  let level = base;
  const extra: string[] = [];
  if (ctx.urgent && level < 2) {
    level = 2;
    extra.push("correction urgente");
  }
  if (ctx.retouch) {
    if (ctx.previous > level) {
      level = ctx.previous;
      extra.push("retouche : niveau du passage précédent");
    }
    if ((ctx.retouches >= 2 || ctx.autofix > 0) && level < 3) {
      level = (level + 1) as Level;
      extra.push("retouches répétées : un cran au-dessus");
    }
  }
  return { level, extra: extra.join(", ") };
}

/** Phrase montrée dans le ticket : « Sonnet · moyen : texte ou style à un seul endroit ». */
export const levelText = (level: Level, why: string) => `${NAMES[level]} : ${why}`;
