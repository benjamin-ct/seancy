// Chargement paresseux de reCAPTCHA v3 côté client. La clé "site" est
// servie par le Worker (voir GET /api/recaptcha-site-key) plutôt que codée
// en dur ou passée par une variable d'env Vite à configurer séparément —
// voir le commentaire dans wrangler.jsonc.
//
// Tant que la clé n'est pas configurée côté serveur (retourne `siteKey:
// null`), getRecaptchaToken() renvoie `null` sans rien charger : le flux
// d'auth continue de fonctionner normalement, juste sans cette couche —
// exactement le même repli que le reste de l'app (Resend, TMDB proxy...).

declare global {
  interface Window {
    grecaptcha?: {
      ready(cb: () => void): void;
      execute(siteKey: string, options: { action: string }): Promise<string>;
    };
  }
}

let siteKeyPromise: Promise<string | null> | null = null;
let scriptLoadPromise: Promise<void> | null = null;

function fetchSiteKey(): Promise<string | null> {
  if (!siteKeyPromise) {
    siteKeyPromise = fetch("/api/recaptcha-site-key", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { siteKey: null }))
      .then((data: { siteKey?: string | null }) => data.siteKey || null)
      .catch(() => null);
  }
  return siteKeyPromise;
}

function loadScript(siteKey: string): Promise<void> {
  if (!scriptLoadPromise) {
    scriptLoadPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://www.google.com/recaptcha/api.js?render=${siteKey}`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Échec du chargement de reCAPTCHA."));
      document.head.appendChild(script);
    });
  }
  return scriptLoadPromise;
}

// Renvoie un jeton reCAPTCHA v3 pour `action`, ou `null` si reCAPTCHA n'est
// pas configuré côté serveur (dev local, ou avant configuration des clés)
// ou en cas d'échec de chargement — dans tous les cas, l'appelant doit
// continuer sans bloquer l'utilisateur : la vérification côté serveur a le
// même repli symétrique (voir worker/recaptcha.ts).
export async function getRecaptchaToken(action: string): Promise<string | null> {
  const siteKey = await fetchSiteKey();
  if (!siteKey) {
    return null;
  }
  try {
    await loadScript(siteKey);
    await new Promise<void>((resolve) => window.grecaptcha?.ready(resolve));
    return (await window.grecaptcha?.execute(siteKey, { action })) ?? null;
  } catch {
    return null;
  }
}
