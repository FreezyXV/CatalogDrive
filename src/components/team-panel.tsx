"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send, UserMinus, X } from "lucide-react";
import { sendJson } from "./account-forms";

type Role = "admin" | "operator" | "reviewer";
const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "admin", label: "Administrateur" },
  { value: "operator", label: "Opérateur" },
  { value: "reviewer", label: "Relecteur" },
];
const roleLabel = (role: Role) =>
  ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;

export type TeamData = {
  members: {
    userId: string;
    email: string;
    role: Role;
    managedByOidc: boolean;
    emailVerified: boolean;
  }[];
  invitations: { id: string; email: string; role: Role; expiresAt: string }[];
};

export function TeamPanel({
  team,
  currentUserId,
  canManage,
  canInvite,
}: {
  team: TeamData;
  currentUserId: string;
  canManage: boolean;
  /** Admin with a confirmed email. */
  canInvite: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);

  async function act(action: () => Promise<unknown>, success: string) {
    setError("");
    setNotice("");
    setPending(true);
    try {
      await action();
      setNotice(success);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action impossible.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="panel form-panel team-panel">
      <div className="panel-heading">
        <div>
          <h2>Équipe</h2>
          <p>
            Administrateur : tout gérer. Opérateur : importer, corriger et
            exporter. Relecteur : consulter et relire.
          </p>
        </div>
      </div>
      {canManage && (
        <form
          className="form-section invite-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const email = String(data.get("email"));
            void act(async () => {
              await sendJson("/api/organization/invitations", {
                email,
                role: data.get("role"),
              });
              form.reset();
            }, `Invitation envoyée à ${email}.`);
          }}
        >
          <label>
            Inviter par email
            <input
              type="email"
              name="email"
              placeholder="collegue@entreprise.fr"
              maxLength={254}
              required
              disabled={!canInvite}
            />
          </label>
          <label>
            Rôle
            <select name="role" defaultValue="operator" disabled={!canInvite}>
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button className="button primary" disabled={pending || !canInvite}>
            <Send size={16} />
            Inviter
          </button>
          {!canInvite && (
            <p className="fine-print">
              Confirmez votre adresse email pour envoyer des invitations.
            </p>
          )}
        </form>
      )}
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="alert success" role="status">
          {notice}
        </p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Membre</th>
              <th>Rôle</th>
              <th>Statut</th>
              {canManage && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {team.members.map((member) => {
              const editable =
                canManage &&
                member.userId !== currentUserId &&
                !member.managedByOidc;
              return (
                <tr key={member.userId}>
                  <td>
                    {member.email}
                    {member.userId === currentUserId && " (vous)"}
                  </td>
                  <td>
                    {editable ? (
                      <select
                        aria-label={`Rôle de ${member.email}`}
                        value={member.role}
                        disabled={pending}
                        onChange={(event) =>
                          void act(
                            () =>
                              sendJson(
                                `/api/organization/members/${member.userId}`,
                                { role: event.target.value },
                                "PATCH",
                              ),
                            `Rôle de ${member.email} mis à jour.`,
                          )
                        }
                      >
                        {ROLE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      roleLabel(member.role)
                    )}
                  </td>
                  <td>
                    <span
                      className={`status-badge ${member.emailVerified ? "success" : "warning"}`}
                    >
                      {member.managedByOidc
                        ? "Géré par le SSO"
                        : member.emailVerified
                          ? "Actif"
                          : "Email non confirmé"}
                    </span>
                  </td>
                  {canManage && (
                    <td>
                      {editable && (
                        <button
                          className="icon-button"
                          title={`Retirer ${member.email}`}
                          aria-label={`Retirer ${member.email}`}
                          disabled={pending}
                          onClick={() =>
                            void act(
                              () =>
                                sendJson(
                                  `/api/organization/members/${member.userId}`,
                                  undefined,
                                  "DELETE",
                                ),
                              `${member.email} n’a plus accès à l’organisation.`,
                            )
                          }
                        >
                          <UserMinus size={16} />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {team.invitations.map((invitation) => (
              <tr key={invitation.id}>
                <td>{invitation.email}</td>
                <td>{roleLabel(invitation.role)}</td>
                <td>
                  <span className="status-badge warning">
                    Invité · expire le{" "}
                    {new Date(invitation.expiresAt).toLocaleDateString("fr-FR")}
                  </span>
                </td>
                {canManage && (
                  <td>
                    <button
                      className="icon-button"
                      title={`Annuler l’invitation de ${invitation.email}`}
                      aria-label={`Annuler l’invitation de ${invitation.email}`}
                      disabled={pending}
                      onClick={() =>
                        void act(
                          () =>
                            sendJson(
                              `/api/organization/invitations/${invitation.id}`,
                              undefined,
                              "DELETE",
                            ),
                          "Invitation annulée.",
                        )
                      }
                    >
                      <X size={16} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
