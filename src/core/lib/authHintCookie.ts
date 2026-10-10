// Cookie compagnon de la session (voir worker/auth.ts, AUTH_HINT_COOKIE),
// lisible en JS : absent, une réponse 401 de /api/auth/me est garantie.
export function hasAuthHintCookie(): boolean {
  return /(?:^|;\s*)seancy_auth=1(?:;|$)/.test(document.cookie);
}

// Le serveur ne peut pas toujours l'effacer lui-même (session révoquée
// ailleurs, voir AuthContext.tsx).
export function clearAuthHintCookie(): void {
  document.cookie = "seancy_auth=; Path=/; Max-Age=0";
}
