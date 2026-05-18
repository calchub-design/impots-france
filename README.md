# Aide Déclaration d'Impôts France 2025

Assistant web complet pour préparer votre déclaration de revenus 2025 (revenus 2024).
Génère un PDF récapitulatif avec toutes vos cases et justificatifs à conserver.

## Fonctionnalités

- 13 modules couvrant l'intégralité de la déclaration 2042 et annexes
- Calcul automatique : quotient familial, déficit foncier, frais réels vs forfait
- Simulation d'impôt en temps réel (barème 2024)
- PDF téléchargeable avec cases, montants et justificatifs
- 100% local — zéro donnée envoyée à un serveur
- Sauvegarde automatique dans localStorage

## Déploiement Vercel (3 commandes)

```bash
# 1. Installer les dépendances
npm install

# 2. Tester en local
npm run dev

# 3. Déployer sur Vercel
npx vercel --prod
```

Ou via l'interface Vercel : connectez votre dépôt GitHub, Vercel détecte automatiquement Next.js.

## Stack

- Next.js 15 (App Router)
- Tailwind CSS v4
- @react-pdf/renderer (génération PDF côté client)
- React useReducer (état global)
- localStorage (persistance)
- Zéro backend, zéro base de données

## Modules couverts

| # | Module | Cases |
|---|--------|-------|
| 0 | Profil & activation | — |
| 1 | Situation personnelle & parts | 1AJ, 1BJ, T, P, W, G |
| 2 | Revenus salariaux | 1AJ, 1BJ, 1AK, 1BK, 1GH |
| 3 | Retraites & allocations | 1AS, 1BS, 1AP, 1AZ |
| 4 | Activité indépendante | 5KO, 5KP, 5HQ, 5QC, 1GB |
| 5 | Location nue | 4BA, 4BC, 4BD, 4BE + détail 2044 |
| 6 | Location meublée (LMNP) | 5ND, 5NA |
| 7 | SCI à l'IR | 4BA, 4BC |
| 8 | Patrimoine financier | 2TR, 2DC, 3VG, 3VH, 2CH |
| 9 | Charges déductibles | 6EL, 6GU, 6NS |
| 10 | Réductions & crédits | 7UF, 7UD, 7DB, 7GA, 7EA... |
| 11 | IFI | 9HI, 9HJ, 9HM |
| 12 | Récapitulatif + PDF | — |

## Avertissement légal

Outil indicatif uniquement — voir [DISCLAIMER.md](DISCLAIMER.md).
Vérifiez toujours sur **impots.gouv.fr** avant de soumettre votre déclaration.
