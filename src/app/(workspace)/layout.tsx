import { requirePageIdentity } from "@/server/auth";
import { WorkspaceShell } from "@/components/workspace-shell";
export const dynamic = "force-dynamic";
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const identity = await requirePageIdentity();
  return <WorkspaceShell identity={identity}>{children}</WorkspaceShell>;
}
