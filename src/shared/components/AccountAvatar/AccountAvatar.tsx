import { useAuth } from "../../../core/context/AuthContext.tsx";
import { useAvatarSources } from "../../hooks/useAvatarSources.ts";
import styles from "./AccountAvatar.module.css";

/** Initiale affichée dans l'avatar quand il n'y a aucune photo. */
function initial(name: string, fallback: string): string {
  return (name.trim() || fallback).charAt(0).toUpperCase() || "?";
}

/**
 * Avatar du compte : photo personnelle si elle existe, sinon photo Gravatar,
 * sinon l'initiale. La géométrie (taille, forme) vient de `className`, fourni
 * par l'appelant.
 */
export default function AccountAvatar({ name, className }: { name: string; className: string }) {
  const { email } = useAuth();
  const { url, onError } = useAvatarSources();
  return (
    <div className={className} aria-hidden="true">
      {url ? (
        <img key={url} className={styles.avatarImg} src={url} alt="" onError={onError} />
      ) : (
        initial(name, email || "?")
      )}
    </div>
  );
}
