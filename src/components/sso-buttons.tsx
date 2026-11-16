import { KeyRound } from "lucide-react";
import type { SocialConnection } from "@/server/auth/oidc";

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
