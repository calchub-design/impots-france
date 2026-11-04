# The Last Block — prototype

Jeu de minage coopératif mondial : un cube colossal commun, composé de couches de blocs, que tous les joueurs minent ensemble en temps réel. On explore sa surface, bien plus grande que l'écran, avec une caméra 2.5D (glisser, pincer, molette, clavier). Chaque saison couronne un **champion** (meilleure contribution), une **brigade championne** et le détenteur honorifique de la **Pierre finale** (celui ou celle qui brise le dernier bloc).

> Prototype. Aucun paiement, aucune collecte, aucun gain d'argent, aucun avantage payant.
> Aucun audit de sécurité externe n'a été réalisé. Un audit ciblé interne et ses limites sont décrits dans [docs/AUDIT.md](docs/AUDIT.md). La tenue en charge n'a été mesurée que sur une machine de test (voir [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

## Prérequis

- **Node.js ≥ 22.13** (module intégré `node:sqlite`, aucune compilation native). Testé avec Node 22.23.
- npm.
- Facultatif, pour le test à deux navigateurs : `playwright` et Chromium.

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

**Plusieurs joueurs dans un même navigateur** : chaque fenêtre utilise le compte invité stocké dans le navigateur. Ouvrez `http://localhost:5173/?profil=alice` et `http://localhost:5173/?profil=bob`, ou utilisez une fenêtre privée. Le paramètre `profil` ne choisit qu'un emplacement de stockage local ; il ne donne accès à aucun compte existant.

**Sur un téléphone du même réseau** : `http://<IP-du-PC>:5173`.

### Production locale

```bash
npm run build     # client -> dist/client, serveur -> dist/server
npm start         # sert le client et le WebSocket sur PORT (8080)
```

## Tests

```bash
npm test             # 133 tests Vitest (13 fichiers), ~6 s
npm run typecheck    # TypeScript (serveur, client, tests, scripts)
npm run build && npm run e2e -- --rendu monolithe   # test réel : deux Chromium (mobile tactile + bureau), 31 vérifications
npm run e2e -- --rendu classique                     # mêmes scénarios avec le rendu classique
npm run loadtest -- --bots 100 --seconds 15
npm run calibrate -- --days 30 --players 200 --minutes 30
```

`npm run e2e` utilise Playwright s'il est installé (sinon il l'indique et s'arrête). S'il est installé globalement : `NODE_PATH=$(npm root -g) npm run e2e`. Les captures sont écrites dans `e2e-output/` (option `--out`).

| Fichier | Contenu |
|---|---|
| `tests/engine.test.ts` | règles de minage, idempotence, limite 5/s, concurrence, persistance |
| `tests/seasons.test.ts` | fins de saison, champion, Pierre finale, brigades |
| `tests/integration.test.ts` | WebSocket et HTTP de bout en bout |
| `tests/security.test.ts` | usurpation, jetons, sessions, limites par IP, messages malformés, doublons, courses, invitations, admin, CSP |
| `tests/limits.test.ts` | temps actif (rythmes adversariaux, changement de jour, redémarrage), reconnexions |
| `tests/crash.test.ts` | **SIGKILL réel** du serveur en plein minage, invariants SQLite, reprise complète |
| `tests/calibration.test.ts` | calibrage et **simulation complète d'une saison de 30 jours** |
| `tests/migration.test.ts` | migration d'une base au schéma v1 |
| `tests/world.test.ts` | caméra (limites, zoom ancré, inertie), gestes (toucher/glisser/pincer), modèle de face |
| `tests/persp.test.ts` | caméra en perspective du rendu monolithe : projection, aller-retour, transition minage ⇄ monument, cadrage, glisser exact, échelle locale des balises |
| `tests/presence.test.ts` | présence observée : expiration 20 s, coups refusés ignorés, masquage, changement de couche, WebSocket |
| `tests/labels.test.ts` | pseudos des mineurs sans chevauchement : foule dense, priorité aux alliés, zones d'interface réservées |
| `tests/hologram.test.ts` | alertes de l'écran holographique (couche presque terminée, dernière couche, Pierre finale) |

Le script `npm run e2e` utilise deux navigateurs distincts : un iPhone 13 émulé, avec gestes tactiles réels via CDP, et un ordinateur. Il vérifie le glisser, le pincer, la sélection et le minage après déplacement, la synchronisation des destructions, la présence, le panneau, l'absence de chevauchement à 5 tailles d'écran, un SIGKILL du serveur, `prefers-reduced-motion`, la fin de saison, l'absence d'erreur JavaScript, et mesure les performances. Détails et résultats : [docs/REFONTE.md](docs/REFONTE.md).

## Comment jouer

- **Se déplacer** : glisser (doigt ou souris), avec inertie ; flèches, ZQSD ou WASD au clavier.
- **Zoomer** : pincer, molette, boutons + et −, ou touches + et −.
- **Choisir un bloc** : un toucher bref ou un clic. Le toucher est « aimanté » vers un bloc vivant proche. Toucher ne mine pas.
- **Miner** : bouton **Miner**, sous la surface, sans jamais la recouvrir. Le maintenir mine en continu, et Espace fait de même. Un bloc est présélectionné à l'ouverture : on peut miner tout de suite.
- **Retrouver son chemin** : ◎ recentre sur votre bloc, ▦ ouvre la vue d'ensemble du cube entier (toucher un bloc pour s'y rendre). La mini-carte en haut à droite permet aussi de s'y rendre.
- **Panneau géant** : un monumental panneau lumineux se dresse au nord de la face, avec le top 3, la meilleure brigade, l'avancement et la saison. Un bandeau compact le résume ; ★ (ou un toucher sur le bandeau) amène la caméra devant lui. Le classement complet est dans **Menu → Classement**.
- **Autres mineurs** : les marqueurs montrent le dernier bloc frappé par chaque joueur au cours des 20 dernières secondes. Ce sont des observations réelles, aux couleurs de la brigade. ⚑ amène la caméra vers un membre de votre brigade vu récemment. L'option « montrer ma position » se trouve dans le profil.
- **Règles du cube** : chaque coup retire 1 point de résistance ; les blocs profonds sont plus durs ; une couche doit être entièrement détruite pour accéder à la suivante.
- Onglet **Brigade** : créez une brigade (code d'invitation) ou rejoignez-en une avec un code.
- Onglet **Profil** : pseudo (unique), apparence, « Déconnecter mes autres appareils » (nouveau jeton), « Abandonner ce compte invité » (révocation).

## Saisons de ~30 jours

```bash
npm run calibrate -- --days 30 --players 200 --minutes 30
```

Le script propose `CUBE_SIZE`, `BLOCK_BASE_HP`, `BLOCK_HP_PER_LAYER` et `SEASON_DURATION_HOURS=720` pour que le cube soit fini vers 90 % de la saison (option `--target`), en fonction de la fréquentation estimée. Pendant la saison, `GET /api/season/projection` (et l'onglet *Saisons*) donne le rythme moyen réel et la date de fin estimée.

**Achèvement anticipé** : si le cube est terminé avant l'échéance, la saison se clôt immédiatement (`endReason: completed`). La Pierre finale et le champion sont attribués, et l'avance sur l'échéance est indiquée (`completedEarlyMs`, fenêtre de fin de saison, archives). La saison suivante démarre après `SEASON_COOLDOWN_SECONDS`, avec une nouvelle échéance complète. Si l'échéance arrive avant la fin du cube, la saison se clôt par `timeout` sans Pierre finale.

## Rendu « monolithe » (par défaut)

Le cube est rendu en **vraie perspective** : une vue de minage où la surface fuit vers l'horizon, et une **vue monumentale** (▦ ou V, ou en pinçant vers l'arrière) qui montre le monolithe entier suspendu dans le vide cosmique. L'univers est futuriste et mystérieux : pierre-tech, lignes d'énergie, glyphes gravés, fissures lumineuses. Le rendu classique, plus léger, reste disponible (Profil → Rendu du cube, ou `?rendu=classique`) et sert de repli automatique sur les appareils trop lents. Détails, compromis, performances mesurées et captures : [étape 1](docs/REFONTE-MONOLITHE.md) (gigantisme, identité futuriste) et [étape 2](docs/REFONTE-MONOLITHE-2.md) (écran holographique, présence, mobile, repli en cours de session).

## Refonte « cube colossal navigable »

Voir [docs/REFONTE.md](docs/REFONTE.md) : analyse, architecture caméra, ce qui est fonctionnel ou non, tests, performances mesurées et captures avant/après. Une seule face est jouable : le dessus de la couche courante, la seule que le serveur sert. La taille par défaut du cube est désormais **32** (`CUBE_SIZE`, jusqu'à 64), soit une surface de 32 × 32 blocs.

## Architecture (résumé)

```
the-last-block/
  shared/       protocole WebSocket typé, skins, calibrage (partagés client/serveur)
  server/
    config.ts   variables d'environnement
    db/         interface GameStore + implémentation SQLite (migrations)
    game/       moteur autoritaire, limiteur de débit, temps actif, validations
    auth/       comptes invités (jeton haché) + interfaces Google/Apple (non implémentées)
    net/        HTTP (API, statiques, CSP), WebSocket, adresse IP client
  client/       Vite + TypeScript + Canvas 2D, réseau avec reconnexion (net.ts)
    world/      surface navigable : face, caméra, gestes, rendu, mini-carte, panneau, présence
    scene.ts    vue isométrique du cube entier (« Vue d'ensemble »)
  tests/        tests unitaires, d'intégration, de sécurité, de crash
  scripts/      dev, loadtest, calibrate, e2e-browser
  docs/         AUDIT, ARCHITECTURE, DEPLOYMENT, SECURITY
```

## API HTTP

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/health` | État du serveur |
| GET | `/api/config` | Règles publiques, skins, paramètres d'association, fournisseurs de connexion |
| GET | `/api/stats` | Compteurs (connexions, refus, coups, mémoire) — à protéger en production |
| GET | `/api/seasons` | Saisons (en cours et archivées) avec champion, brigade, Pierre finale, avance éventuelle |
| GET | `/api/seasons/:id` | Classement final archivé |
| GET | `/api/season/projection` | Avancement et date de fin estimée de la saison en cours |
| POST | `/api/admin/season/start` | `{name?, cubeSize?, durationHours?, baseHp?, hpPerLayer?}` — `Authorization: Bearer $ADMIN_TOKEN` |
| POST | `/api/admin/season/end` | Clôture la saison en cours |

## Fonctionnalités

### Terminées et testées automatiquement

**Priorité 1 — vertical slice**
- [x] Cube commun, plusieurs joueurs et navigateurs synchronisés (WebSocket + test réel à deux Chromium).
- [x] Serveur autoritaire ; mise à jour SQL conditionnelle `hp > 0` : un bloc détruit ne peut plus être frappé.
- [x] Coups concurrents : nombre exact de coups acceptés, un seul destructeur par bloc, une seule Pierre finale.
- [x] Idempotence par `actionId` (contrainte SQL), y compris après redémarrage et entre sessions simultanées.
- [x] Temps réel par lots de 50 ms ; reconnexion automatique, reprise d'état, renvoi des actions non confirmées.
- [x] Classement de contribution, progression de couche, journal persistant des coups.
- [x] Interface mobile et bureau.

**Priorité 2 — saisons**
- [x] Saisons (auto ou admin), compte à rebours, fin par Pierre finale, échéance ou clôture manuelle, délai inter-saison (y compris après redémarrage), archives.
- [x] Champion, brigade championne (≥ 5 membres), Pierre finale distincte.
- [x] Brigades privées : code d'invitation, 5 à 10 membres, une brigade par joueur, freinage de la recherche exhaustive de codes.
- [x] Limite de 4 h de minage **actif** par jour (inactivité au-delà de 5 s non comptée, aucun rythme ne permet de la contourner), persistée et remise à zéro à minuit UTC.
- [x] Limite de 5 coups/s par compte (toutes sessions, reconnexions comprises).
- [x] Panneau géant (Canvas 2D, isométrie, sans moteur 3D).
- [x] Calibrage de saisons de ~30 jours et estimation de fin en direct.

**Sécurité et fiabilité (audit du 4 novembre 2026)**
- [x] Identité invitée : jeton secret seule preuve, refus explicite des jetons inconnus, rotation et révocation, 4 sessions max par compte.
- [x] Limites par IP (connexions, créations de comptes), pseudos uniques, limites d'actions de profil, CSP.
- [x] Reprise après arrêt brutal vérifiée avec SIGKILL réel, y compris entre le dernier coup et la clôture de saison.

**Priorité 3 — préparation**
- [x] Interfaces Google/Apple qui **refusent** toute connexion tant qu'une vérification réelle n'existe pas.
- [x] Skins cosmétiques gratuits, sans effet de jeu.
- [x] Paramètres d'association configurables, en affichage seul.
- [x] Documentation de déploiement, test de charge, calibrage.

### Incomplètes / non faites

- [ ] Connexion Google / Apple réelle.
- [ ] Protection solide contre les comptes multiples et les robots (voir [docs/AUDIT.md](docs/AUDIT.md#3-problèmes-restant-ouverts)).
- [ ] Adaptateur PostgreSQL et exécution multi-processus.
- [ ] Fuseau horaire par joueur pour la limite quotidienne (minuit UTC).
- [ ] Modération des pseudos et détection des homoglyphes entre alphabets.
- [x] Surface navigable (caméra, zoom, mini-carte, vue d'ensemble), panneau monumental dans le décor, présence réelle des mineurs.
- [ ] Une seule face jouable (dessus de la couche courante) ; navigation clavier bloc par bloc ; surface étroite sur téléphone en paysage.
- [ ] Tests sur téléphones physiques, Safari et Firefox.
- [ ] Magasin cosmétique, notifications, sons, PWA hors ligne.
