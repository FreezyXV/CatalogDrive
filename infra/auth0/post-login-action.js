/**
 * Auth0 Action, trigger "Login / Post Login" (optional).
 *
 * Without it, every person who signs in (Google, Microsoft, email…) gets a
 * personal CataMotive organization where they are admin (self-signup).
 * With it, a company can manage memberships centrally: put
 *   { "catamotive_groups": ["/organizations/<uuid>/operator"] }
 * in the user's app_metadata and the application applies these roles,
 * revoking what is no longer listed (joiner / mover / leaver).
 *
 * Auth0 requires custom claims to be namespaced: set
 * OIDC_GROUPS_CLAIM=https://catamotive.app/groups in the application.
 */
exports.onExecutePostLogin = async (event, api) => {
  const groups = event.user.app_metadata?.catamotive_groups;
  if (!Array.isArray(groups) || groups.length === 0) return;
  api.idToken.setCustomClaim("https://catamotive.app/groups", groups);
  api.accessToken.setCustomClaim("https://catamotive.app/groups", groups);
};
