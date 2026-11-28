import { useEffect, useState } from "react";
import { Icon } from "../../../shared/components/index.ts";
import styles from "./MemberAvatar.module.css";

// Photo de membre d'une liste commune : seulement si son profil est public
// (même route que PublicProfilePage, /api/public-profile/:slug/avatar) —
// jamais la photo d'un profil privé, qui resterait sinon exposée à des
// co-membres sans que son propriétaire ait choisi de la rendre publique
// (cadrage du 2026-10-11). Sinon, la même icône générique que le profil en
// haut à droite (NavBar), pas une vraie photo de repli.
export default function MemberAvatar({
  shareSlug,
  className = "",
}: {
  shareSlug: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [shareSlug]);

  if (!shareSlug || failed) {
    return (
      <span className={`${styles.avatar} ${styles.placeholder} ${className}`}>
        <Icon name="user" size={12} />
      </span>
    );
  }
  return (
    <img
      className={`${styles.avatar} ${className}`}
      src={`/api/public-profile/${encodeURIComponent(shareSlug)}/avatar`}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}
