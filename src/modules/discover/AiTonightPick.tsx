import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getDrawDetails } from "../../core/api/tmdb.ts";
import {
  getTonightSuggestions,
  postTonightSkip,
  type TonightSuggestion,
} from "../../core/api/tonightSuggestions.ts";
import { useExcludedTitles } from "../../core/context/ExcludedTitlesContext.tsx";
import { useLibrary } from "../../core/context/LibraryContext.tsx";
import { logWarn } from "../../core/logger.ts";
import type { MediaDetails } from "../../core/types/tmdb.ts";
import TonightPickCard, { TonightPickMessage } from "./TonightPickCard.tsx";
import styles from "./TonightPick.module.css";

// Le Worker génère les suggestions du jour en arrière-plan (~2-5 s mesurées)
// et répond "pending" en attendant : on redemande à ce rythme…
const POLL_INTERVAL_MS = 3000;
// … pendant au plus ~2 min (au-delà du verrou de génération côté Worker,
// voir PENDING_TTL_MS dans worker/ai-suggestions.ts), après quoi on retombe
// sur le tirage populaire plutôt que de laisser l'attente tourner sans fin.
const MAX_POLLS = 40;

type SuggestionsState =
  { status: "loading" } | { status: "pending" } | { status: "ready"; items: TonightSuggestion[] };

function keyOf(item: TonightSuggestion): string {
  return `${item.mediaType}:${item.id}`;
}

/** « Pour vous ce soir » pour un compte connecté : jusqu'à 10 titres choisis
 * par Workers AI à partir de l'historique (ou par l'algo non-IA en repli),
 * générés une fois par jour côté Worker et proposés un par un.
 * « Autre suggestion » écarte le titre pour 6 mois (côté serveur, tous
 * appareils) et passe au suivant. `onUnavailable` : erreur ou attente trop
 * longue, le parent repasse sur le tirage populaire côté client. */
export default function AiTonightPick({ onUnavailable }: { onUnavailable: () => void }) {
  const { t, i18n } = useTranslation();
  const { isWatched } = useLibrary();
  const { isExcludedTitle } = useExcludedTitles();
  const [suggestions, setSuggestions] = useState<SuggestionsState>({ status: "loading" });
  const [skippedKeys, setSkippedKeys] = useState<string[]>([]);
  // Fiches TMDB chargées (langue active comprise dans la clé) ; `null` =
  // échec, le titre est alors simplement sauté.
  const [details, setDetails] = useState<Record<string, MediaDetails | null>>({});

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const load = () => {
      getTonightSuggestions(controller.signal)
        .then((res) => {
          if (res.status !== "pending") {
            setSuggestions({ status: "ready", items: res.items });
          } else if (++polls > MAX_POLLS) {
            onUnavailable();
          } else {
            setSuggestions({ status: "pending" });
            timer = setTimeout(load, POLL_INTERVAL_MS);
          }
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) {
            logWarn("Seancy : suggestions du soir indisponibles.", err);
            onUnavailable();
          }
        });
    };
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [onUnavailable]);

  const detailsKey = (item: TonightSuggestion) => `${keyOf(item)}:${i18n.language}`;
  const remaining =
    suggestions.status === "ready"
      ? suggestions.items.filter(
          (item) =>
            !skippedKeys.includes(keyOf(item)) &&
            !isWatched(item.mediaType, item.id) &&
            !isExcludedTitle(item.mediaType, item.id) &&
            details[detailsKey(item)] !== null
        )
      : [];
  const current = remaining[0];
  // Le suivant est préchargé : « Autre suggestion » l'affiche sans attente.
  const upcoming = remaining.slice(0, 2);
  const upcomingKey = upcoming.map(detailsKey).join(",");

  useEffect(() => {
    for (const item of upcoming) {
      const key = detailsKey(item);
      if (key in details) {
        continue;
      }
      getDrawDetails(item.mediaType, item.id)
        .then((data) => setDetails((prev) => ({ ...prev, [key]: data })))
        .catch((err: unknown) => {
          logWarn("Seancy : fiche de la suggestion du soir indisponible.", err);
          setDetails((prev) => ({ ...prev, [key]: null }));
        });
    }
    // Clé stable des titres à charger plutôt que le tableau (nouvelle
    // référence à chaque rendu) ; `details` lu pour ne pas recharger une
    // fiche déjà là, pas pour relancer l'effet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcomingKey]);

  if (suggestions.status === "loading") {
    return <div className={`${styles.hero} ${styles.placeholder}`} aria-hidden="true" />;
  }
  if (suggestions.status === "pending") {
    return (
      <TonightPickMessage title={t("tonightPick.preparingTitle")} busy>
        {t("tonightPick.preparingText")}
      </TonightPickMessage>
    );
  }
  if (!current) {
    return (
      <TonightPickMessage title={t("tonightPick.allSkippedTitle")}>
        {t("tonightPick.allSkippedText")}
      </TonightPickMessage>
    );
  }
  const item = details[detailsKey(current)];
  if (!item) {
    return <div className={`${styles.hero} ${styles.placeholder}`} aria-hidden="true" />;
  }

  function skip() {
    setSkippedKeys((prev) => [...prev, keyOf(current)]);
    postTonightSkip(current).catch((err: unknown) =>
      logWarn('Seancy : "autre suggestion" non enregistrée.', err)
    );
  }

  return (
    <TonightPickCard
      mediaType={current.mediaType}
      item={item}
      genreIds={(item.genres ?? []).map((g) => g.id)}
      genreName={item.genres?.[0]?.name}
      onSkip={skip}
    />
  );
}
