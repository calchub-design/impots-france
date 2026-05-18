import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aide Déclaration d'Impôts 2025 — Revenus 2024",
  description: "Assistant complet pour votre déclaration de revenus française 2025 (revenus 2024). Calcul des cases, simulation d'impôt, PDF récapitulatif. Données 100% locales.",
  keywords: "déclaration impôts France 2025, formulaire 2042, revenus fonciers, LMNP, auto-entrepreneur",
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
