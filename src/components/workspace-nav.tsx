"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowUpRight,
  FileUp,
  LayoutDashboard,
  Settings,
  Shapes,
} from "lucide-react";

export function WorkspaceNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Navigation principale">
      <Link
        href="/dashboard"
        aria-current={pathname === "/dashboard" ? "page" : undefined}
      >
        <LayoutDashboard size={19} />
        Vue d’ensemble
      </Link>
      <Link
        href="/imports/new"
        aria-current={pathname === "/imports/new" ? "page" : undefined}
      >
        <FileUp size={19} />
        Nouvel import
        <ArrowUpRight size={15} className="nav-arrow" />
      </Link>
      <Link
        href="/templates"
        aria-current={pathname === "/templates" ? "page" : undefined}
      >
        <Shapes size={18} />
        Modèles
      </Link>
      <Link
        href="/settings"
        aria-current={pathname === "/settings" ? "page" : undefined}
      >
        <Settings size={18} />
        Paramètres
      </Link>
    </nav>
  );
}
