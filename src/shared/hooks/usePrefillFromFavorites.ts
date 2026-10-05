import { useEffect, useRef, useState } from "react";

// Pré-remplit un filtre de page (ex. `countries`/`languages` de FilterPanel)
// depuis une préférence de compte (ex. favoriteCountryCodes), sans écraser
// une modification ponctuelle de l'utilisateur sur cette page — même
// principe que `useMyPlatforms`, qui ne modifie jamais `favoriteProviderIds`.
//
// `favorites` peut arriver après le premier rendu (la synchronisation
// compte/serveur de FavoriteCountriesContext/FavoriteLanguagesContext est
// asynchrone, voir SYNCED_FOR_KEY) : un simple `useState(favorites)` figerait
// la valeur vide du tout premier rendu. Ce hook réapplique `favorites`
// chaque fois qu'il change TANT QUE la valeur affichée est encore celle
// posée automatiquement la dernière fois (donc pas encore d'édition locale).
export function usePrefillFromFavorites<T>(favorites: T[]): [T[], (next: T[]) => void] {
  const [value, setValue] = useState<T[]>(favorites);
  const lastAppliedRef = useRef<T[]>(favorites);

  useEffect(() => {
    setValue((prev) => {
      const prevWasAuto = JSON.stringify(prev) === JSON.stringify(lastAppliedRef.current);
      lastAppliedRef.current = favorites;
      return prevWasAuto ? favorites : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favorites]);

  return [value, setValue];
}
