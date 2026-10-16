import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../../shared/hooks/useDocumentTitle.ts";
import {
  posterUrl,
  backdropUrl,
  getPerson,
  getPersonCredits,
  getGenres,
  dateLocaleTag,
} from "../../core/api/tmdb.ts";
import { useLocale } from "../../core/context/LocaleContext.tsx";
import {
  MediaCard,
  Loading,
  ErrorMessage,
  EmptyState,
  Icon,
} from "../../shared/components/index.ts";
import FrequentCollaborators from "./components/FrequentCollaborators.tsx";
import { posterAccentFromGenres } from "../../shared/lib/posterAccent.ts";
import { toMediaItem } from "../../shared/lib/mediaItem.ts";
import posterStyles from "../../shared/styles/posterAccents.module.css";
import gridStyles from "../../shared/styles/mediaGrid.module.css";
import type {
  PersonCastCredit,
  PersonCrewCredit,
  PersonDetails,
  PersonCredits,
} from "../../core/types/tmdb.ts";
// Même gabarit que la fiche film/série (grand bloc avec image de fond et
// halo, carte « Infos », titres de section) : on reprend ses classes plutôt
// que de les dupliquer, pour que les deux pages évoluent ensemble.
import detailStyles from "../detail/DetailPage.module.css";
import styles from "./PersonPage.module.css";

const DIRECTING_JOBS = new Set(["Director", "Writer", "Screenplay", "Creator"]);
// Filmographie affichée par lots, comme le casting de la fiche : certaines
// personnes ont plus de 150 titres.
const CREDITS_BATCH = 18;
// Au-delà, la biographie est repliée (« Lire la suite »).
const BIO_COLLAPSE_CHARS = 600;
const KNOWN_DEPARTMENTS = new Set([
  "Acting",
  "Directing",
  "Writing",
  "Production",
  "Sound",
  "Camera",
  "Editing",
  "Art",
  "Costume & Make-Up",
  "Crew",
  "Visual Effects",
  "Lighting",
  "Creator",
]);

type Credit = PersonCastCredit | PersonCrewCredit;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function dedupeByMedia<T extends { media_type: string; id: number }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = `${item.media_type}:${item.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out;
}

function sortByDateDesc<T extends { release_date?: string; first_air_date?: string }>(
  items: T[]
): T[] {
  return items.slice().sort((a, b) => {
    const dateA = a.release_date || a.first_air_date || "";
    const dateB = b.release_date || b.first_air_date || "";
    return dateB.localeCompare(dateA);
  });
}

/** Âge en années révolues à `until` (aujourd'hui, ou la date de décès). */
function ageAt(birthday: string, until?: string | null): number | null {
  const birth = new Date(birthday);
  const end = until ? new Date(until) : new Date();
  if (Number.isNaN(birth.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }
  let age = end.getFullYear() - birth.getFullYear();
  const beforeBirthday =
    end.getMonth() < birth.getMonth() ||
    (end.getMonth() === birth.getMonth() && end.getDate() < birth.getDate());
  if (beforeBirthday) {
    age -= 1;
  }
  return age >= 0 ? age : null;
}

function CreditsSection({
  title,
  items,
  emptyLabel = "",
}: {
  title: string;
  items: Credit[];
  emptyLabel?: string;
}) {
  const { t } = useTranslation();
  const [batches, setBatches] = useState(1);
  const visible = items.slice(0, batches * CREDITS_BATCH);
  const remaining = items.length - visible.length;

  return (
    <section className={detailStyles.section}>
      <div className={detailStyles.sectionHead}>
        <h2>{title}</h2>
        {items.length > 0 && (
          <span className={styles.count}>
            {t("personPage.titlesCount", { count: items.length })}
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <EmptyState label={emptyLabel} />
      ) : (
        <div className={`${gridStyles.grid} ${styles.grid}`}>
          {visible.map((item) => (
            <MediaCard
              key={`${item.media_type}:${item.id}`}
              item={toMediaItem(item, item.media_type)}
            />
          ))}
        </div>
      )}
      {remaining > 0 && (
        <div className={detailStyles.castMore}>
          <span className={detailStyles.castMoreCount}>
            {t("personPage.shown", { shown: visible.length, total: items.length })}
          </span>
          <button
            type="button"
            className={detailStyles.castMoreBtn}
            onClick={() => setBatches((b) => b + 1)}
          >
            {t("personPage.showMore", { count: Math.min(CREDITS_BATCH, remaining) })}
          </button>
        </div>
      )}
    </section>
  );
}

export default function PersonPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams<{ id: string }>();
  const { locale } = useLocale();
  const [person, setPerson] = useState<PersonDetails | null>(null);
  const [credits, setCredits] = useState<PersonCredits | null>(null);
  const [genreMap, setGenreMap] = useState<Record<number, string>>({});
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [error, setError] = useState<Error | null>(null);
  const [bioOpen, setBioOpen] = useState(false);
  useDocumentTitle(person?.name);

  useEffect(() => {
    if (!id) {
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setBioOpen(false);
    Promise.all([getPerson(id), getPersonCredits(id)])
      .then(([p, c]) => {
        if (cancelled) {
          return;
        }
        setPerson(p);
        setCredits(c);
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
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getGenres("movie"), getGenres("tv")])
      .then(([m, t]) => {
        if (cancelled) {
          return;
        }
        const map: Record<number, string> = {};
        for (const g of [...(m.genres || []), ...(t.genres || [])]) {
          map[g.id] = g.name;
        }
        setGenreMap(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const asActor = useMemo(() => sortByDateDesc(dedupeByMedia(credits?.cast || [])), [credits]);
  const asCrew = useMemo(
    () =>
      sortByDateDesc(
        dedupeByMedia((credits?.crew || []).filter((c) => DIRECTING_JOBS.has(c.job || "")))
      ),
    [credits]
  );
  const allCredits = useMemo<Credit[]>(
    () => dedupeByMedia<Credit>([...asActor, ...asCrew]),
    [asActor, asCrew]
  );

  const stats = useMemo(() => {
    const rated = allCredits.filter((c) => c.vote_average != null && c.vote_average > 0);
    const avg = rated.length
      ? rated.reduce((s, c) => s + (c.vote_average || 0), 0) / rated.length
      : null;
    const genreCounts = new Map<number, number>();
    for (const c of allCredits) {
      for (const gId of c.genre_ids || []) {
        genreCounts.set(gId, (genreCounts.get(gId) || 0) + 1);
      }
    }
    const genresByCount = [...genreCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([gId]) => gId);
    return {
      total: allCredits.length,
      avgRating: avg,
      genresByCount,
      topGenres: genresByCount
        .map((gId) => genreMap[gId])
        .filter(Boolean)
        .slice(0, 3),
    };
  }, [allCredits, genreMap]);

  // Image de fond : celle du titre le plus connu de la personne (le plus de
  // votes TMDB), comme le backdrop de la fiche.
  const knownFor = useMemo(
    () =>
      allCredits
        .filter((c) => c.backdrop_path)
        .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0))[0],
    [allCredits]
  );

  function backLink(className: string) {
    return (
      <Link
        to="/"
        className={className}
        onClick={(e) => {
          // Voir DetailPage : navigate(-1) déclenche un vrai POP, requis
          // pour que useScrollRestoration restaure la liste d'origine, sauf
          // en première page de session (sinon on quitterait le site).
          if (location.key !== "default") {
            e.preventDefault();
            navigate(-1);
          }
        }}
      >
        {t("personPage.back")}
      </Link>
    );
  }

  if (status === "loading") {
    return (
      <div className={detailStyles.page}>
        {backLink(detailStyles.backPlain)}
        <Loading />
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className={detailStyles.page}>
        {backLink(detailStyles.backPlain)}
        <ErrorMessage error={error} />
      </div>
    );
  }
  if (!person) {
    return null;
  }

  const localeTag = dateLocaleTag(locale);
  const accentKey = posterAccentFromGenres(stats.genresByCount, person.name);
  const department = person.known_for_department;
  const job =
    department && KNOWN_DEPARTMENTS.has(department)
      ? t(`personPage.departments.${department}`)
      : department || t("personPage.personality");
  const age = person.birthday ? ageAt(person.birthday, person.deathday) : null;
  const formatDate = (date: string) =>
    new Date(date).toLocaleDateString(localeTag, {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  const eyebrow = [
    job,
    person.birthday &&
      (person.deathday
        ? `${person.birthday.slice(0, 4)} – ${person.deathday.slice(0, 4)}`
        : age != null && t("personPage.ageYears", { count: age })),
    t("personPage.titlesCount", { count: stats.total }),
  ]
    .filter(Boolean)
    .join(" · ");

  const bio = person.biography?.trim();
  const bioLong = !!bio && bio.length > BIO_COLLAPSE_CHARS;

  const infoRows: { label: string; value: string }[] = [{ label: t("personPage.job"), value: job }];
  if (person.birthday) {
    infoRows.push({
      label: t("personPage.born"),
      value:
        !person.deathday && age != null
          ? `${formatDate(person.birthday)} (${t("personPage.ageYears", { count: age })})`
          : formatDate(person.birthday),
    });
  }
  if (person.deathday) {
    infoRows.push({
      label: t("personPage.died"),
      value:
        age != null
          ? `${formatDate(person.deathday)} (${t("personPage.ageYears", { count: age })})`
          : formatDate(person.deathday),
    });
  }
  if (person.place_of_birth) {
    infoRows.push({ label: t("personPage.birthplace"), value: person.place_of_birth });
  }
  infoRows.push({ label: t("personPage.titles"), value: String(stats.total) });
  if (stats.topGenres[0]) {
    infoRows.push({ label: t("personPage.favoriteGenre"), value: stats.topGenres[0] });
  }

  // Réalisateur·rice ou scénariste : ses films derrière la caméra d'abord.
  const crewFirst = department === "Directing" || department === "Writing";
  const actingSection = (
    <CreditsSection
      key="acting"
      title={t("personPage.filmography")}
      items={asActor}
      emptyLabel={t("personPage.noKnownAppearance")}
    />
  );
  const crewSection = asCrew.length > 0 && (
    <CreditsSection key="crew" title={t("personPage.asDirectorWriter")} items={asCrew} />
  );

  return (
    <div className={detailStyles.page}>
      <div className={detailStyles.hero}>
        <div
          className={detailStyles.backdrop}
          style={
            knownFor?.backdrop_path
              ? { backgroundImage: `url(${backdropUrl(knownFor.backdrop_path)})` }
              : undefined
          }
        />
        <div
          className={`${detailStyles.halo} ${detailStyles[`halo_${accentKey}`]}`}
          aria-hidden="true"
        />
        <div className={detailStyles.heroInner}>
          {backLink(detailStyles.back)}
          <div className={detailStyles.posterWrap}>
            {person.profile_path ? (
              <img
                src={posterUrl(person.profile_path, "w342") ?? undefined}
                alt={person.name}
                className={detailStyles.poster}
              />
            ) : (
              <div
                className={`${detailStyles.poster} ${styles.portraitEmpty} ${posterStyles[accentKey]}`}
              >
                {initials(person.name)}
              </div>
            )}
          </div>

          <div className={detailStyles.heading}>
            <p className="eyebrow">{eyebrow}</p>
            <h1 className={detailStyles.title}>{person.name}</h1>
          </div>

          {(stats.topGenres.length > 0 || stats.avgRating != null) && (
            <div className={detailStyles.meta}>
              {stats.topGenres.length > 0 && (
                <ul className={detailStyles.genres}>
                  {stats.topGenres.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              )}
              {stats.avgRating != null && (
                <p className={detailStyles.score}>
                  <Icon name="star" filled />
                  <b>
                    {stats.avgRating.toLocaleString(localeTag, {
                      maximumFractionDigits: 1,
                      minimumFractionDigits: 1,
                    })}
                  </b>
                  <span className={detailStyles.scoreOutOf}>/10</span>
                  <span className={detailStyles.scoreVotes}>
                    · {t("personPage.averageRating").toLowerCase()}
                  </span>
                </p>
              )}
            </div>
          )}

          <div className={detailStyles.details}>
            <p
              className={`${detailStyles.overview} ${bioLong && !bioOpen ? styles.bioClamped : ""}`}
            >
              {bio || t("personPage.noBiography")}
            </p>
            {bioLong && (
              <button
                type="button"
                className={`${detailStyles.textBtn} ${styles.bioToggle}`}
                onClick={() => setBioOpen((o) => !o)}
                aria-expanded={bioOpen}
              >
                {bioOpen ? t("personPage.readLess") : t("personPage.readMore")}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className={detailStyles.body}>
        <div className={detailStyles.main}>
          {crewFirst ? [crewSection, actingSection] : [actingSection, crewSection]}
        </div>

        <aside className={`${detailStyles.aside} ${styles.asideFirst}`}>
          <section className={detailStyles.infoCard}>
            <h2>{t("personPage.infos")}</h2>
            <dl className={detailStyles.infoList}>
              {infoRows.map((row) => (
                <div key={row.label} className={detailStyles.infoRow}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </aside>
      </div>

      {allCredits.length > 0 && (
        <FrequentCollaborators
          personId={person.id}
          credits={sortByDateDesc(allCredits).map((c) => ({ id: c.id, media_type: c.media_type }))}
          sectionClassName={detailStyles.section}
          headClassName={detailStyles.sectionHead}
        />
      )}
    </div>
  );
}
