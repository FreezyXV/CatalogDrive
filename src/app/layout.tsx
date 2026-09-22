import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: {
    default: "CataMotive — Espace catalogue",
    template: "%s | CataMotive",
  },
  description:
    "Importez et inspectez vos fichiers fournisseurs de pièces automobiles dans un espace privé.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
