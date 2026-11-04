# The Last Block — prototype

Jeu de minage coopératif mondial : un cube commun, composé de couches de blocs, que tous les joueurs minent ensemble en temps réel. Chaque saison couronne un **champion** (meilleure contribution), une **brigade championne** et le détenteur honorifique de la **Pierre finale** (celui ou celle qui brise le dernier bloc).

> Prototype. Aucun paiement, aucune collecte, aucun gain d'argent, aucun avantage payant.
> Le serveur n'a **pas** été audité en sécurité et sa tenue en charge n'a été mesurée que sur une machine de test (voir plus bas).

## Prérequis

- **Node.js ≥ 22.13** (utilise le module intégré `node:sqlite` : aucune compilation native). Testé avec Node 22.23.
- npm.

## Installation

```bash
cd the-last-block
npm install
cp .env.example .env   # facultatif : les valeurs par défaut conviennent pour jouer en local
```

## Démarrage

### Développement (rechargement automatique)

```bash
npm run dev
```

- Client Vite : http://localhost:5173 (relaie `/ws` et `/api` vers le serveur)
- Serveur de jeu : http://localhost:8080

**Tester à plusieurs dans un seul navigateur** : chaque fenêtre utilise le compte invité stocké dans le navigateur. Pour simuler deux joueurs, ouvrez par exemple
`http://localhost:5173/?profil=alice` et `http://localhost:5173/?profil=bob` (ou une fenêtre de navigation privée).

**Sur un téléphone du même réseau** : ouvrez `http://<IP-du-PC>:5173`.

### Production locale

```bash
npm run build     # client -> dist/client, serveur -> dist/server
npm start         # sert le client et le WebSocket sur PORT (8080)
```

## Tests

```bash
npm test             # 42 tests Vitest : règles, concurrence, idempotence, persistance, WebSocket, HTTP
npm run typecheck    # vérification TypeScript (serveur, client, tests)
npm run loadtest -- --bots 100 --seconds 15   # test de charge simple (voir docs/DEPLOYMENT.md)
```

## Comment jouer

- Touchez un bloc de la couche supérieure (ou maintenez le bouton **Miner**, ou la barre d'espace sur ordinateur).
- Chaque coup retire 1 point de résistance ; plus on descend, plus les blocs sont durs.
- Une couche doit être entièrement détruite pour accéder à la suivante.
- Le panneau géant au-dessus du cube affiche les meilleurs mineurs de la saison.
- Onglet **Brigade** : créez une brigade (vous recevez un code d'invitation) ou rejoignez-en une avec un code.

## Architecture (résumé)

```
the-last-block/
  shared/       protocole WebSocket typé + catalogue de skins (partagés client/serveur)
  server/
    config.ts   variables d'environnement
    db/         interface GameStore + implémentation SQLite
    game/       moteur autoritaire (engine.ts), limiteur de débit, temps actif, validations
    auth/       comptes invités (jeton haché) + interfaces Google/Apple (non implémentées)
    net/        serveur HTTP (API, fichiers statiques) + WebSocket
  client/       Vite + TypeScript + Canvas 2D (scene.ts), réseau avec reconnexion (net.ts)
  tests/        tests unitaires et d'intégration
  scripts/      dev.mjs, loadtest.ts
  docs/         ARCHITECTURE.md, DEPLOYMENT.md, SECURITY.md
```

Détails : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Déploiement et charge : [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · Sécurité : [docs/SECURITY.md](docs/SECURITY.md).

## API HTTP

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/health` | État du serveur |
| GET | `/api/config` | Règles publiques, skins, paramètres d'association, fournisseurs de connexion |
| GET | `/api/stats` | Compteurs (connexions, coups acceptés/refusés, mémoire) |
| GET | `/api/seasons` | Saisons (en cours et archivées) avec champion, brigade, Pierre finale |
| GET | `/api/seasons/:id` | Classement final archivé d'une saison |
| POST | `/api/admin/season/start` | Démarre une saison `{name?, cubeSize?, durationHours?}` — `Authorization: Bearer $ADMIN_TOKEN` |
| POST | `/api/admin/season/end` | Clôture la saison en cours |

## Fonctionnalités

### Terminées et testées automatiquement

**Priorité 1 — vertical slice**
- [x] Cube commun partagé, plusieurs fenêtres/joueurs minent le même cube (test WebSocket + test navigateur manuel automatisé avec Playwright).
- [x] Serveur autoritaire : validation de chaque coup (format, limites, couche accessible, bloc vivant). Mise à jour SQL conditionnelle `hp > 0` : un bloc détruit ne peut plus être frappé.
- [x] Coups concurrents : test avec 20 joueurs × 5 coups simultanés et 6 clients WebSocket en rafale → nombre exact de coups acceptés = PV du bloc, un seul destructeur.
- [x] Déduplication / idempotence : `actionId` unique par joueur (contrainte SQL), renvoi = résultat d'origine sans double application, y compris après redémarrage du serveur.
- [x] Temps réel : diffusion des changements par lots de 50 ms, classement chaque seconde, changement de couche diffusé avec un état complet.
- [x] Reconnexion automatique (backoff + gigue), reprise d'état complète, renvoi des actions non confirmées.
- [x] Classement de contribution (départage : premier à atteindre le score) et progression de couche.
- [x] Journal persistant des coups (table `hits`).
- [x] Interface mobile (bouton « maintenir pour miner », cibles tactiles) et bureau (deux colonnes, clic, barre d'espace).

**Priorité 2 — saisons**
- [x] Création de saisons (automatique ou via l'API admin), compte à rebours, fin par Pierre finale, échéance ou clôture manuelle, délai avant la saison suivante.
- [x] Archivage : top 100 joueurs et brigades éligibles, consultables dans l'onglet *Saisons*.
- [x] Champion (contribution), brigade championne (≥ 5 membres), Pierre finale distincte et honorifique.
- [x] Brigades privées : code d'invitation de 8 caractères, 10 membres max, éligibilité à 5, une brigade par joueur, transfert du rôle de chef, dissolution quand vide, coups attribués à la brigade du moment.
- [x] Limite de 4 h de minage **actif** par jour, imposée côté serveur et persistée ; seuls les intervalles ≤ 20 s entre deux coups sont comptés ; remise à zéro à minuit UTC.
- [x] Limite de 5 actions/s par compte (fenêtre glissante exacte, partagée entre les connexions d'un même compte).
- [x] Panneau géant des meilleurs mineurs au-dessus du cube (Canvas 2D, projection isométrique, sans moteur 3D).

**Priorité 3 — préparation**
- [x] Interfaces Google/Apple (`server/auth/providers.ts`) qui **refusent** toute connexion tant qu'une vérification réelle n'est pas implémentée (pas de fausse sécurité).
- [x] Skins cosmétiques gratuits (6 couleurs), sans effet sur le gameplay, `price: null` partout.
- [x] Paramètres d'association configurables, en affichage seul ; aucune transaction.
- [x] Documentation de déploiement et script de test de charge, avec mesures réelles.

### Incomplètes / non faites

- [ ] Connexion Google / Apple réelle (vérification JWKS, nonce, liaison de compte) : seulement les interfaces.
- [ ] Protection contre les comptes multiples / robots : un joueur peut créer plusieurs comptes invités et contourner les limites par compte. Nécessite une authentification forte et/ou de l'anti-abus.
- [ ] Adaptateur PostgreSQL : l'interface `GameStore` est prête, l'implémentation non (voir docs/ARCHITECTURE.md).
- [ ] Exécution multi-processus / multi-serveurs : le moteur garde l'état en mémoire, prévu pour **un seul processus**.
- [ ] Fuseau horaire par joueur pour la limite quotidienne (actuellement minuit UTC).
- [ ] Modération des pseudos / noms de brigade (seuls les caractères sont filtrés).
- [ ] Magasin cosmétique, notifications, sons, PWA hors ligne, accessibilité approfondie (le cube n'est utilisable qu'à la souris, au toucher ou via le bouton).
- [ ] Tests de bout en bout du navigateur intégrés à `npm test` (le parcours a été vérifié avec Playwright, mais le script n'est pas versionné dans la suite).
