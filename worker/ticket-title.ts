// Titre d'un ticket laissé vide sur la page Tickets, écrit d'après sa
// description (comme sur Paddock Live) : Claude Haiku si le secret
// ANTHROPIC_API_KEY est posé, sinon Workers AI (binding AI, déjà utilisé par
// les suggestions), sinon la 1re ligne de la description comme avant.
// cleanTitle est vérifiée par scripts/verify-tickets.ts.
// Type minimal (pas worker/types.ts) : vérifiable par les scripts, hors du projet TypeScript du Worker
interface TitleEnv {
  ANTHROPIC_API_KEY?: string;
  AI?: unknown;
}
type RunAi = { run(model: string, input: unknown): Promise<unknown> };

const ASK =
  "Écris un titre court (8 mots au plus), en français, sans guillemets ni point final, pour ce ticket de développement de Seancy, un site de suivi de films et de séries. Réponds par le titre seul.\n\n";
const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** 1re ligne non vide de la description, 120 caractères au plus (titre d'avant, et secours). */
export function firstLine(detail: string): string {
  return (detail.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 120);
}

/** Réponse du modèle ramenée à un titre : 1re ligne, sans « Titre : », guillemets ni point final ; sinon le secours. */
export function cleanTitle(out: string, fallback: string): string {
  const line = (out.split("\n").find((l) => l.trim()) ?? "")
    .trim()
    .replace(/^\**\s*titre\s*:\s*/i, "")
    .replace(/^[\s"'«»“”*]+|[\s"'«»“”*.]+$/g, "")
    .trim();
  return line && line.length <= 120 ? line : fallback;
}

export async function ticketTitle(env: TitleEnv, detail: string): Promise<string> {
  const fallback = firstLine(detail);
  const text = detail.trim().slice(0, 3000);
  if (!text) {
    return fallback;
  }
  const messages = [{ role: "user" as const, content: ASK + text }];
  if (env.ANTHROPIC_API_KEY) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        // Réflexion coupée : elle compterait dans max_tokens et pourrait laisser la réponse vide
        body: JSON.stringify({
          model: "claude-haiku-5-5",
          max_tokens: 200,
          thinking: { type: "disabled" },
          messages,
        }),
      });
      const data = (await res.json()) as {
        stop_reason?: string;
        content?: { type: string; text?: string }[];
      };
      const out =
        data.stop_reason === "refusal"
          ? ""
          : (data.content?.find((c) => c.type === "text")?.text ?? "");
      if (res.ok && out.trim()) {
        return cleanTitle(out, fallback);
      }
      console.error("Titre de ticket (Claude) : réponse", res.status);
    } catch (err) {
      console.error("Titre de ticket (Claude) :", err);
    }
  }
  if (env.AI) {
    try {
      const r = (await (env.AI as RunAi).run(WORKERS_AI_MODEL, { messages, max_tokens: 40 })) as {
        response?: string;
      };
      return cleanTitle(r.response ?? "", fallback);
    } catch (err) {
      console.error("Titre de ticket (Workers AI) :", err);
    }
  }
  return fallback;
}
