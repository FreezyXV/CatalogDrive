import { listOrganizations, requirePageIdentity } from "@/server/auth";
import { WorkspaceShell } from "@/components/workspace-shell";
export const dynamic = "force-dynamic";
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const identity = await requirePageIdentity();
  const organizations = await listOrganizations(identity.userId);
  return (
    <WorkspaceShell identity={identity} organizations={organizations}>
      {children}
    </WorkspaceShell>
  );
}
