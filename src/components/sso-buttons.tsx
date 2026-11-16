import { KeyRound } from "lucide-react";
import type { SocialConnection } from "@/server/auth/oidc";

/** Official multicolour Google "G" mark, as Google's sign-in guidelines require. */
function GoogleMark() {
  return (
    <svg
      className="sso-logo"
      width="18"
      height="18"
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** Provider logo for a social button; none for unknown connections. */
function ConnectionLogo({ id }: { id: string }) {
  if (id === "google-oauth2" || id === "google") return <GoogleMark />;
  return null;
}

/**
 * Sign-in buttons for the identity provider. Plain links on purpose: the
 * route handler redirects to another origin, so a full navigation is needed.
 */
export function SsoButtons({
  connections,
  signup = false,
  error,
}: {
  connections: SocialConnection[];
  signup?: boolean;
  error?: string;
}) {
  const href = (connection?: string) => {
    const query = new URLSearchParams();
    if (connection) query.set("connection", connection);
    if (signup) query.set("signup", "1");
    const text = query.toString();
    return `/api/auth/oidc/login${text ? `?${text}` : ""}`;
  };
  const verb = signup ? "S’inscrire" : "Continuer";
  return (
    <div className="sso-buttons">
      {connections.map((connection) => (
        <a
          key={connection.id}
          className="button secondary full"
          href={href(connection.id)}
        >
          <ConnectionLogo id={connection.id} />
          {verb} avec {connection.label}
        </a>
      ))}
      <a className="button primary full" href={href()}>
        <KeyRound size={17} />
        {connections.length
          ? `${verb} avec un autre compte (SSO)`
          : `${verb} avec le SSO de l’entreprise`}
      </a>
      {error ? (
        <p role="alert" className="error">
          {error.slice(0, 200)}
        </p>
      ) : null}
      <p className="fine-print">ou avec votre email et un mot de passe :</p>
    </div>
  );
}
