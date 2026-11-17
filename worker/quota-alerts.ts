// Alertes de quota (notification aux administrateurs et rappel dans les cartes
// du tableau de bord) : volumes inclus du forfait Cloudflare qui approchent de
// leur fin (80 %, ou épuisés avant la remise à zéro au rythme actuel) ou sont
// épuisés, neurones Workers AI gratuits du jour, et fenêtres du quota de
// l'abonnement Claude (80 % ou alerte de Claude, puis atteint). Chaque alerte a
// une clé propre à sa période : envoyée une seule fois (meta « quotaAlerts »,
// worker/tickets.ts). Logique pure : vérifiée par scripts/verify-quota-alerts.ts.
import { PAID, type Usage } from "./cloudflare-usage.ts";
import type { Limit } from "./claude-usage.ts";

export interface QuotaAlert {
  key: string;
  level: "warn" | "bad";
  text: string;
}

const DAY = 86_400_000;
const pct = (n: number) => `${Math.round(n * 100)} %`;
const dateFr = (t: number) =>
  new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
const whenFr = (t: number) =>
  new Date(t).toLocaleString("fr-FR", {
    weekday: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  });
const CLAUDE_NAMES: Record<string, string> = {
  five_hour: "session de 5 h",
  seven_day: "semaine",
  seven_day_opus: "semaine Opus",
  seven_day_sonnet: "semaine Sonnet",
};

/** Volumes Cloudflare du forfait (période de facturation en cours, neurones du jour). */
export function cloudflareAlerts(u: Usage, now = Date.now()): QuotaAlert[] {
  const m = u.month;
  const start = Date.parse(`${m.from}T00:00:00Z`);
  const end = Date.parse(`${m.renews}T00:00:00Z`);
  const elapsed = Math.max(0, Math.min(1, (now - start) / (end - start)));
  const out: QuotaAlert[] = [];
  for (const [name, used, included] of [
    ["Requêtes des Workers", m.requests, PAID.requests.included],
    ["Temps de calcul", m.cpuMs, PAID.cpuMs.included],
    ["D1 · lignes lues", m.rowsRead, PAID.rowsRead.included],
    ["D1 · lignes écrites", m.rowsWritten, PAID.rowsWritten.included],
    ["D1 · stockage", u.storage, PAID.storage.included],
  ] as const) {
    const share = used / included;
    const key = `cf:${name}:${m.from}`;
    if (share >= 1) {
      out.push({
        key: `${key}:bad`,
        level: "bad",
        text: `Cloudflare : ${name} au-delà de l'inclus (${pct(share)}), facturé jusqu'au ${dateFr(end)}`,
      });
      continue;
    }
    // Au rythme de la période (au moins 3 jours écoulés pour ne pas extrapoler un seul pic), sauf le stockage
    // qui ne se consomme pas au fil du mois
    const pace =
      name !== "D1 · stockage" && now - start >= 3 * DAY && elapsed > 0 ? share / elapsed : 0;
    if (share >= 0.8 || pace >= 1) {
      const out_at = pace >= 1 ? start + (end - start) * (elapsed / share) : 0;
      out.push({
        key: `${key}:warn`,
        level: "warn",
        text:
          share >= 0.8
            ? `Cloudflare : ${name} à ${pct(share)} de l'inclus, remise à zéro le ${dateFr(end)}`
            : `Cloudflare : ${name} à ${pct(share)} de l'inclus, épuisé vers le ${dateFr(out_at)} au rythme actuel (remise à zéro le ${dateFr(end)})`,
      });
    }
  }
  const ai = u.neurons / PAID.neuronsPerDay.included;
  if (ai >= 0.8) {
    out.push({
      key: `cf:neurons:${u.day}:${ai >= 1 ? "bad" : "warn"}`,
      level: ai >= 1 ? "bad" : "warn",
      text:
        ai >= 1
          ? `Cloudflare : neurones Workers AI gratuits du jour épuisés (${pct(ai)}), facturés jusqu'à minuit UTC`
          : `Cloudflare : neurones Workers AI gratuits du jour à ${pct(ai)}`,
    });
  }
  return out;
}

/** Fenêtres du quota de l'abonnement Claude (dernier relevé de chacune, encore valable). */
export function claudeAlerts(limits: Limit[], now = Date.now()): QuotaAlert[] {
  const out: QuotaAlert[] = [];
  for (const l of limits) {
    if (l.resetsAt && l.resetsAt <= now) {
      continue;
    }
    const name = CLAUDE_NAMES[l.type] ?? l.type;
    const reset = l.resetsAt ? `, remis à zéro ${whenFr(l.resetsAt)}` : "";
    const key = `claude:${l.type}:${l.resetsAt || new Date(l.at).toISOString().slice(0, 10)}`;
    if (l.status === "rejected" || (l.used ?? 0) >= 100) {
      out.push({
        key: `${key}:bad`,
        level: "bad",
        text: `Claude : quota de la ${name} atteint, les tickets attendent${reset}`,
      });
    } else if (l.status === "allowed_warning" || (l.used ?? 0) >= 80) {
      out.push({
        key: `${key}:warn`,
        level: "warn",
        text: `Claude : quota de la ${name} à ${l.used == null ? "plus de 80 %" : `${Math.round(l.used)} %`}${reset}`,
      });
    }
  }
  return out;
}

/** Alertes pas encore envoyées, et la liste des clés envoyées à garder (les 60 dernières). */
export function newAlerts(
  alerts: QuotaAlert[],
  sent: string[]
): { fresh: QuotaAlert[]; sent: string[] } {
  const fresh = alerts.filter((a) => !sent.includes(a.key));
  return { fresh, sent: [...fresh.map((a) => a.key), ...sent].slice(0, 60) };
}
