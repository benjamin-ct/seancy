import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../../shared/hooks/useDocumentTitle.ts";
import { searchMultiRanked } from "../../core/api/tmdb.ts";
import {
  MediaCard,
  PersonCard,
  Loading,
  ErrorMessage,
  EmptyState,
} from "../../shared/components/index.ts";
import { useRegion } from "../../core/context/RegionContext.tsx";
import gridStyles from "../../shared/styles/mediaGrid.module.css";
import type { MediaItem, PersonSummary } from "../../core/types/tmdb.ts";
import styles from "./SearchPage.module.css";

export default function SearchPage() {
  const { t } = useTranslation();
  const { region } = useRegion();
  const [searchParams] = useSearchParams();
  const query = searchParams.get("q") || "";
  useDocumentTitle(query ? t("pageTitle.searchQuery", { query }) : t("pageTitle.search"));
  const [titles, setTitles] = useState<MediaItem[]>([]);
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!query) {
      setTitles([]);
      setPeople([]);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    searchMultiRanked(query, region)
      .then((results) => {
        if (cancelled) {
          return;
        }
        setTitles(
          results
            .filter((item) => item.media_type === "movie" || item.media_type === "tv")
            .map((item) => {
              const { media_type, ...rest } = item;
              return { ...rest, mediaType: media_type as "movie" | "tv" };
            })
        );
        setPeople(
          results
            .filter((item) => item.media_type === "person")
            .map((item) => ({
              id: item.id,
              name: item.name,
              profile_path: item.profile_path,
              known_for_department: item.known_for_department,
            }))
        );
        setStatus("success");
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setError(err);
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [query, region]);

  const isEmpty = titles.length === 0 && people.length === 0;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t("searchPage.resultsFor", { query })}</h1>
      {status === "loading" && <Loading />}
      {status === "error" && <ErrorMessage error={error} />}
      {status === "success" && isEmpty && <EmptyState label={t("searchPage.noResults")} />}

      {status === "success" && people.length > 0 && (
        <section className={styles.section}>
          <h3>{t("searchPage.actorsAndDirectors")}</h3>
          <div className={gridStyles.personGrid}>
            {people.map((person) => (
              <PersonCard
                key={person.id}
                id={person.id}
                name={person.name}
                profilePath={person.profile_path}
                knownForDepartment={person.known_for_department}
              />
            ))}
          </div>
        </section>
      )}

      {status === "success" && titles.length > 0 && (
        <section>
          {people.length > 0 && <h3>{t("searchPage.moviesAndSeries")}</h3>}
          <div className={gridStyles.grid}>
            {titles.map((item) => (
              <MediaCard key={`${item.mediaType}:${item.id}`} item={item} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
