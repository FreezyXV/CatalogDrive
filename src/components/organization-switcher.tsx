"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "./account-forms";

/** Shown only to people who belong to several organizations. */
export function OrganizationSwitcher({
  current,
  organizations,
}: {
  current: string;
  organizations: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (organizations.length < 2) return null;
  return (
    <label className="organization-switcher">
      <span className="sr-only">Changer d’organisation</span>
      <select
        value={current}
        disabled={pending}
        onChange={async (event) => {
          setPending(true);
          setError("");
          try {
            await sendJson("/api/auth/switch", {
              organizationId: event.target.value,
            });
            router.push("/dashboard");
            router.refresh();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Échec.");
          } finally {
            setPending(false);
          }
        }}
      >
        {organizations.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.name}
          </option>
        ))}
      </select>
      {error && <span role="alert">{error}</span>}
    </label>
  );
}
