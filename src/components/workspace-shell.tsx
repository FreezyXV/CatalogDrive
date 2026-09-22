import Link from "next/link";
import { CircleHelp, PanelLeft, ShieldCheck } from "lucide-react";
import { Brand } from "./brand";
import { LogoutButton } from "./workspace-actions";
import { WorkspaceNav } from "./workspace-nav";
import type { Identity } from "@/server/auth";
export function WorkspaceShell({
  identity,
  children,
}: {
  identity: Identity;
  children: React.ReactNode;
}) {
  return (
    <div className="workspace">
      <aside className="sidebar">
        <Link href="/dashboard" aria-label="CataMotive, tableau de bord">
          <Brand light />
        </Link>
        <div className="workspace-label">ESPACE DE TRAVAIL</div>
        <WorkspaceNav />
        <div className="sidebar-note">
          <span className="eyebrow">
            <ShieldCheck size={15} />
            VOTRE CATALOGUE, PRIVÉ
          </span>
          <p>
            Vos fichiers restent dans votre organisation. Les originaux sont
            conservés sans modification.
          </p>
        </div>
        <div className="sidebar-bottom">
          <CircleHelp size={17} />
          <span>MVP opérationnel</span>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="topbar">
          <span className="topbar-title">
            <PanelLeft size={18} />
            Espace catalogue
          </span>
          <div className="topbar-account">
            <span className="mode-badge">
              {process.env.STORAGE_DRIVER === "s3"
                ? "Stockage privé S3"
                : "Stockage local"}
            </span>
            <span className="avatar">
              {identity.organizationName.slice(0, 2).toUpperCase()}
            </span>
            <div className="account-name">
              <strong>{identity.organizationName}</strong>
              <small>Propriétaire</small>
            </div>
            <LogoutButton />
          </div>
        </header>
        <main className="main-content">{children}</main>
        <footer className="workspace-footer">
          <span>CataMotive · Des données fiables, dès la source.</span>
          <span>Aucune compatibilité véhicule déduite.</span>
        </footer>
      </div>
    </div>
  );
}
