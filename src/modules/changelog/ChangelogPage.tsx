import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "../../shared/hooks/useDocumentTitle.ts";
import { PageHeader, EmptyState } from "../../shared/components/index.ts";
import { useLocale } from "../../core/context/LocaleContext.tsx";
import { formatFullDate } from "../../core/api/movieMeta.ts";
import { parseChangelog } from "./changelogParser.ts";
// Contenu généré par scripts/changelogRelease.ts (voir CHANGELOG.md) : lu au
// build, pas au runtime — chaque release redéploie de toute façon le site,
// donc pas de staleness possible entre le contenu affiché et le bundle
// déployé.
import changelogRaw from "../../../CHANGELOG.md?raw";
import styles from "./ChangelogPage.module.css";

export default function ChangelogPage() {
  const { t } = useTranslation();
  const { locale } = useLocale();
  useDocumentTitle(t("pageTitle.changelog"));

  const releases = parseChangelog(changelogRaw);

  return (
    <div className={styles.page}>
      <PageHeader eyebrow={t("changelogPage.eyebrow")} title={t("changelogPage.title")} />

      {releases.length === 0 ? (
        <EmptyState label={t("changelogPage.empty")} />
      ) : (
        releases.map((release) => (
          <article key={release.version} className={styles.release}>
            <div className={styles.releaseHead}>
              <span className={styles.version}>{release.version}</span>
              <span className={styles.date}>
                {formatFullDate(release.date, locale) || release.date}
              </span>
            </div>
            {release.sections.map((section) => (
              <div key={section.title} className={styles.section}>
                <h2 className={styles.sectionTitle}>{section.title}</h2>
                <ul className={styles.items}>
                  {section.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </article>
        ))
      )}
    </div>
  );
}
