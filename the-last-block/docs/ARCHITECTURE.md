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
3. **Saison** : refus si aucune saison active ; si l'échéance est dépassée, la saison est clôturée.
4. **Débit** : fenêtre glissante exacte de 1 000 ms, 5 coups max par **compte**.
5. **Temps actif** : refus si le compteur du jour a atteint la limite.
6. **Règles du cube** : bornes, couche courante uniquement, bloc vivant (contrôle mémoire rapide).
7. **Transaction SQLite** :
   - `UPDATE blocks SET hp = hp - 1 … WHERE … AND hp > 0 RETURNING hp` — si aucune ligne n'est renvoyée, le bloc était déjà détruit : refus ;
   - insertion dans `hits` (contrainte `UNIQUE(player_id, action_id)`) ;
   - incrément des contributions joueur et brigade, mise à jour du temps actif.
8. **Après COMMIT** seulement : mise à jour de l'état mémoire, événement `block`, passage de couche, et fin de saison si la Pierre finale tombe.

Node.js exécute ce traitement de façon synchrone : deux coups ne s'entrelacent jamais dans un même processus. La mise à jour conditionnelle et la contrainte d'unicité en base restent néanmoins les garanties finales (testées en simulant une destruction « externe »).

## Synchronisation client

- `welcome` : état complet (saison, couche courante avec PV de chaque bloc, restants par couche, classements, temps actif, brigade) et numéro de séquence `seq`.
- `delta` : lots de `[couche, bloc, pv]` en valeurs **absolues** (rejouer un delta est sans effet). Le client ignore les deltas dont `seq` est inférieur ou égal à celui de son état.
- `layer` : nouvel état complet lors d'un changement de couche.
- `mineResult` : réponse à chaque action. Le client garde les actions non confirmées et les renvoie avec le **même** `actionId` après reconnexion.
- Changement de saison : `seasonEnded`/`seasonStarted` puis nouveau `welcome` pour tous.

## Temps de jeu actif

Seul l'écart entre deux coups acceptés consécutifs est crédité, et seulement s'il est ≤ `IDLE_GAP_SECONDS` (20 s par défaut). Le premier coup après une pause n'est pas crédité. Granularité : un joueur qui frappe toutes les 19 s se voit compter 19 s par coup. Un écart à cheval sur minuit UTC n'est crédité que pour sa partie du nouveau jour.

## Données (SQLite)

| Table | Rôle |
|---|---|
| `players` | compte invité : empreinte SHA-256 du jeton, pseudo, skin, dernier coup |
| `seasons` | saisons ; index unique partiel garantissant une seule saison `active` |
| `blocks` | PV de chaque bloc de chaque saison, auteur et date de destruction |
| `hits` | journal persistant de tous les coups acceptés (idempotence) |
| `contributions`, `brigade_contributions` | agrégats par saison |
| `playtime` | temps actif par joueur et par jour UTC |
| `brigades`, `brigade_members` | brigades et appartenance (une brigade par joueur : clé primaire) |
| `season_results` | archives des classements finaux |

## Évolution vers PostgreSQL

Le moteur ne dépend que de l'interface `GameStore` (`server/db/store.ts`). Pour un adaptateur PostgreSQL :

- l'interface est **synchrone** aujourd'hui (adaptée à `node:sqlite`). PostgreSQL impose des appels asynchrones : il faudra rendre `GameStore` et `GameEngine.mine` asynchrones et **sérialiser** les coups dans le processus (file d'attente) pour conserver l'ordre et la cohérence de l'état mémoire ;
- le SQL est déjà portable : `UPDATE … WHERE hp > 0 RETURNING hp`, `INSERT … ON CONFLICT DO UPDATE`, contrainte d'unicité sur `(player_id, action_id)`, index unique partiel pour la saison active ;
- en **plusieurs processus**, l'état mémoire (PV, classements, limiteur de débit, temps actif) ne serait plus partagé : il faudrait un état central (Redis ou PostgreSQL), un bus de diffusion (LISTEN/NOTIFY, Redis pub/sub) et un limiteur partagé. Ce n'est pas fait.

## Authentification

- Prototype : comptes invités. Jeton aléatoire de 256 bits remis une seule fois, stocké côté client dans `localStorage`, côté serveur uniquement sous forme d'empreinte SHA-256.
- Google / Apple : `server/auth/providers.ts` définit `IdentityProvider`. Les implémentations actuelles déclarent `isAvailable() === false` et lèvent une erreur : le serveur répond `auth_unavailable`. Les étapes d'une vraie vérification sont décrites dans le fichier.

## Cosmétiques et association

- `shared/skins.ts` : skins gratuits, sans effet de jeu (`price: null`). Le serveur refuse tout identifiant inconnu.
- `DONATION_*` : affichage d'une note et d'une association envisagée. Il n'existe **aucun** code de paiement, de collecte ou de transfert.
