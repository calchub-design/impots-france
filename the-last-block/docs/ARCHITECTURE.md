# Architecture

## Vue d'ensemble

```
 Navigateur (Vite + Canvas 2D)                    Serveur Node.js (1 processus)
 ┌───────────────────────────┐   WebSocket /ws   ┌───────────────────────────────────┐
 │ net.ts   reconnexion,      │ ───────────────▶ │ net/gameServer.ts                  │
 │          actions en attente│  hello / mine /  │   anti-flood par connexion,        │
 │ main.ts  état dérivé du    │  brigade / ...   │   lots de deltas (50 ms),          │
 │          serveur, UI       │ ◀─────────────── │   classement (1 s), heartbeat      │
 │ scene.ts cube isométrique, │  welcome / delta │ game/engine.ts  (autoritaire)      │
 │          panneau géant     │  layer / ...     │   règles, saisons, brigades        │
 └───────────────────────────┘                   │ db/store.ts  interface GameStore   │
                                                 │ db/sqlite.ts SQLite (WAL)          │
                                                 └───────────────────────────────────┘
```

## Traitement d'un coup (`GameEngine.mine`)

1. **Validation de forme** : `actionId` (8–64 caractères URL-safe), `layer` et `block` entiers.
2. **Idempotence** : si `(player_id, action_id)` existe déjà dans `hits`, on renvoie le résultat enregistré (`duplicate: true`), sans rien modifier ni consommer la limite de débit.
3. **Saison** : refus si aucune saison active ; si l'échéance est dépassée, la saison est clôturée (datée de l'échéance).
4. **Débit** : fenêtre glissante exacte de 1 000 ms, 5 coups max par **compte** (toutes sessions confondues).
5. **Temps actif** : refus si le compteur du jour a atteint la limite.
6. **Règles du cube** : bornes, couche courante uniquement, bloc vivant (contrôle mémoire rapide).
7. **Transaction SQLite** :
   - `UPDATE blocks SET hp = hp - 1 … WHERE … AND hp > 0 RETURNING hp` — si aucune ligne n'est renvoyée, le bloc était déjà détruit : refus ;
   - insertion dans `hits` (contrainte `UNIQUE(player_id, action_id)`) ;
   - incrément des contributions joueur et brigade, mise à jour du temps actif.
8. **Après COMMIT** seulement : mise à jour de l'état mémoire, événement `block`, passage de couche, et fin de saison si la Pierre finale tombe.

Node.js exécute ce traitement de façon synchrone : deux coups ne s'entrelacent jamais dans un même processus. La mise à jour conditionnelle et la contrainte d'unicité en base restent néanmoins les garanties finales (testées en simulant une destruction « externe »).

## Client : surface navigable

Le client affiche la face `top` (dessus de la couche courante) à travers une caméra 2.5D : `client/src/world/` contient la face, la caméra, les gestes, le rendu, la mini-carte, le panneau et la présence. Le rendu ne dessine que les blocs visibles et uniquement quand quelque chose change ; il n'applique jamais un coup avant la réponse du serveur. Détails, mesures et limites : [REFONTE.md](REFONTE.md).

## Présence observée

Le moteur garde en mémoire le dernier coup **accepté** de chaque joueur (`GameEngine.presence()`) et le diffuse avec le classement (≤ 1 fois/s, 40 entrées max, fenêtre de 20 s, `PRESENCE_WINDOW_MS`). Seuls les champs `playerId`, `name`, `skin`, `brigadeName`, `block` et `ageMs` sont envoyés ; aucune position de caméra ne circule. Un joueur peut masquer sa présence (`setPresence`, colonne `players.presence_hidden`, migration idempotente). Rien n'est persisté : après un redémarrage, la présence repart de zéro.

## Synchronisation client

- `welcome` : état complet (saison, couche courante avec PV de chaque bloc, restants par couche, classements, temps actif, brigade) et numéro de séquence `seq`.
- `delta` : lots de `[couche, bloc, pv]` en valeurs **absolues** (rejouer un delta est sans effet). Le client ignore les deltas dont `seq` est inférieur ou égal à celui de son état.
- `layer` : nouvel état complet lors d'un changement de couche.
- `mineResult` : réponse à chaque action. Le client garde les actions non confirmées et les renvoie avec le **même** `actionId` après reconnexion.
- Changement de saison : `seasonEnded`/`seasonStarted` puis nouveau `welcome` pour tous.

## Temps de jeu actif

Modèle « réunion des fenêtres » (`server/game/playtime.ts`) : chaque coup accepté rend le joueur actif pendant W = `IDLE_GAP_SECONDS` (5 s par défaut). Le temps actif est la durée de la réunion de ces fenêtres ; un coup crédite donc `min(écart depuis le coup précédent, W)` (W pour le premier coup).

- Jeu continu : le temps compté suit le temps réel.
- Pause de durée P : seule une durée min(P, W) est comptée.
- Aucun coup n'est gratuit : espacer ses coups coûte W par coup. Avec W ≥ 1 s et 5 coups/s maximum, le nombre de coups par jour est borné par 5 × limite (s) + 5, soit ≈ 72 000 pour 4 h, **quel que soit le rythme adopté** (vérifié sur 5 rythmes adversariaux).
- Le crédit est imputé au jour UTC du coup et plafonné à la durée écoulée depuis minuit.

La version précédente ne comptait que les écarts ≤ 20 s : frapper toutes les 21 s permettait de jouer sans limite (voir AUDIT.md, problème D).

## Reprise après arrêt brutal

Toutes les écritures d'un coup sont dans une seule transaction ; la mémoire n'est mise à jour qu'après COMMIT et entièrement reconstruite depuis la base au démarrage. Cas particuliers traités au démarrage :

- saison dont le dernier bloc a été détruit mais pas encore clôturée (crash entre les deux transactions) : clôture `completed` avec la Pierre finale retrouvée dans `hits` ;
- échéance dépassée pendant l'arrêt : clôture `timeout` datée de l'échéance ;
- intersaison : le délai avant la saison suivante est recalculé depuis la date de fin en base.

Vérifié par `tests/crash.test.ts` avec un vrai SIGKILL du processus serveur.

## Estimation de fin et calibrage

- `shared/calibration.ts` : total de coups d'un cube, `taille² × (taille × base + parCouche × taille × (taille − 1) / 2)`, et choix des paramètres pour une durée visée (`npm run calibrate`).
- `GameEngine.projection()` : coups portés / restants (somme des PV en mémoire), rythme moyen depuis le début de saison (robuste aux cycles jour/nuit), date de fin estimée. Exposé par `GET /api/season/projection` et diffusé avec le classement.

## Données (SQLite)

| Table | Rôle |
|---|---|
| `players` | compte invité : empreinte SHA-256 du jeton, pseudo et sa clé d'unicité `name_key` (v2), skin, dernier coup |
| `seasons` | saisons ; index unique partiel garantissant une seule saison `active` |
| `blocks` | PV de chaque bloc de chaque saison, auteur et date de destruction |
| `hits` | journal persistant de tous les coups acceptés (idempotence) |
| `contributions`, `brigade_contributions` | agrégats par saison |
| `playtime` | temps actif par joueur et par jour UTC |
| `brigades`, `brigade_members` | brigades et appartenance (une brigade par joueur : clé primaire) |
| `season_results` | archives des classements finaux |
| `meta` | version du schéma (2) ; migrations idempotentes au démarrage (`SqliteStore.migrate`) |

## Évolution vers PostgreSQL

Le moteur ne dépend que de l'interface `GameStore` (`server/db/store.ts`). Pour un adaptateur PostgreSQL :

- l'interface est **synchrone** aujourd'hui (adaptée à `node:sqlite`). PostgreSQL impose des appels asynchrones : il faudra rendre `GameStore` et `GameEngine.mine` asynchrones et **sérialiser** les coups dans le processus (file d'attente) pour conserver l'ordre et la cohérence de l'état mémoire ;
- le SQL est déjà portable : `UPDATE … WHERE hp > 0 RETURNING hp`, `INSERT … ON CONFLICT DO UPDATE`, contrainte d'unicité sur `(player_id, action_id)`, index unique partiel pour la saison active ;
- en **plusieurs processus**, l'état mémoire (PV, classements, limiteur de débit, temps actif) ne serait plus partagé : il faudrait un état central (Redis ou PostgreSQL), un bus de diffusion (LISTEN/NOTIFY, Redis pub/sub) et un limiteur partagé. Ce n'est pas fait.

## Authentification

- Prototype : comptes invités. Jeton aléatoire de 256 bits remis une seule fois, stocké côté client dans `localStorage`, côté serveur uniquement sous forme d'empreinte SHA-256. La session est la connexion WebSocket ; un jeton inconnu est refusé (4003), rotation (`rotateToken`) et révocation (`logout`) disponibles. Détails : SECURITY.md.
- Google / Apple : `server/auth/providers.ts` définit `IdentityProvider`. Les implémentations actuelles déclarent `isAvailable() === false` et lèvent une erreur : le serveur répond `auth_unavailable`. Les étapes d'une vraie vérification sont décrites dans le fichier.

## Cosmétiques et association

- `shared/skins.ts` : skins gratuits, sans effet de jeu (`price: null`). Le serveur refuse tout identifiant inconnu.
- `DONATION_*` : affichage d'une note et d'une association envisagée. Il n'existe **aucun** code de paiement, de collecte ou de transfert.
