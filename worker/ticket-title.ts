// Textes des tickets écrits par l'IA (comme sur Paddock Live) : titre d'un
// ticket laissé vide, d'après sa description, et carte d'une idée (titre et
// description) d'après l'idée tapée telle quelle. Claude Haiku si le secret
// ANTHROPIC_API_KEY est posé, sinon Workers AI (binding AI, déjà utilisé par
// les suggestions), sinon le texte tel quel comme avant.
// cleanTitle et ideaFrom sont vérifiées par scripts/verify-tickets.ts.
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

// Réponse du modèle : Claude Haiku si sa clé est posée, sinon Workers AI ; "" si aucun ne répond
async function ask(env: TitleEnv, prompt: string, maxTokens: number): Promise<string> {
  const messages = [{ role: "user" as const, content: prompt }];
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
          max_tokens: maxTokens + 160,
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
        return out;
      }
      console.error("Texte de ticket (Claude) : réponse", res.status);
    } catch (err) {
      console.error("Texte de ticket (Claude) :", err);
    }
  }
  if (env.AI) {
    try {
      const r = (await (env.AI as RunAi).run(WORKERS_AI_MODEL, {
        messages,
        max_tokens: maxTokens,
      })) as { response?: string };
      return r.response ?? "";
    } catch (err) {
      console.error("Texte de ticket (Workers AI) :", err);
    }
  }
  return "";
}

export async function ticketTitle(env: TitleEnv, detail: string): Promise<string> {
  const fallback = firstLine(detail);
  const text = detail.trim().slice(0, 3000);
  return text ? cleanTitle(await ask(env, ASK + text, 40), fallback) : fallback;
}

const IDEA_ASK =
  "Voici une idée notée en vrac pour Seancy, un site de suivi de films et de séries. Transforme-la en carte : sur la 1re ligne, un titre court (8 mots au plus, sans guillemets ni point final) ; puis une ligne vide ; puis une description claire en 2 à 4 phrases : ce qu'on veut, pourquoi, et où dans le site si c'est dit. Reste fidèle à l'idée, n'invente ni détail ni solution technique. En français, sans markdown ni intitulé du genre « Titre : ».\n\nIdée :\n";

/** Idée tapée telle quelle (1re ligne : le titre, comme avant), utilisée quand l'IA ne répond pas. */
export function ideaFallback(raw: string): { title: string; detail: string } {
  const [first = "", ...rest] = raw.trim().split("\n");
  return { title: first.trim().slice(0, 120), detail: rest.join("\n").trim() };
}

/** Réponse du modèle ramenée à une carte : titre (1re ligne), description (le reste), l'idée d'origine gardée en dessous. */
export function ideaFrom(out: string, raw: string): { title: string; detail: string } {
  const fallback = ideaFallback(raw);
  const lines = out.trim().split("\n");
  const title = cleanTitle(lines[0] ?? "", "");
  const body = lines
    .slice(1)
    .join("\n")
    .replace(/^\s*\**\s*description\s*:\s*/i, "")
    .trim();
  if (!title || !body) {
    return fallback;
  }
  return { title, detail: `${body}\n\n**Idée d'origine :** ${raw.trim()}` };
}

/** Carte d'une idée (titre et description) écrite d'après l'idée tapée telle quelle. */
export async function ideaCard(
  env: TitleEnv,
  raw: string
): Promise<{ title: string; detail: string }> {
  const text = raw.trim().slice(0, 3000);
  return text ? ideaFrom(await ask(env, IDEA_ASK + text, 300), text) : ideaFallback(raw);
}
