import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aide Déclaration d'Impôts 2026 — Revenus 2025",
  description: "Assistant complet pour votre déclaration de revenus française 2026 (revenus 2025). Calcul des cases, simulation d'impôt, PDF récapitulatif. Données 100% locales.",
  keywords: "déclaration impôts France 2026, formulaire 2042, revenus fonciers, LMNP, auto-entrepreneur",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
