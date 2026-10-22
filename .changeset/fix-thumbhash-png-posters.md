---
bump: patch
---

Corrige le calcul de ThumbHash à la demande pour les affiches dont la source TMDB est nativement en PNG (il échouait auparavant, puis était simplement ignoré) : l'affiche est maintenant décodée dans son vrai format au lieu de supposer du JPEG.
