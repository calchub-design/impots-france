# Audit avant le gameplay de la saison 1

Cet audit inventorie ce qui existe et peut être réutilisé pour les cinq chantiers demandés : découvertes collectives, missions individuelles, objectifs de brigade, cérémonie de fin de saison et mini-saison privée de 48 h. Il a été réalisé sur la branche `ccr-df7b905e-uqdwc8` (commit `4522de3`). Aucun code n'a été modifié.

## Ce qui existe

### Serveur

Le serveur fait environ 2 500 lignes ; le moteur à lui seul en fait 850.

| Système | Où | Ce qui est utile pour la suite |
|---|---|---|
| Moteur autoritaire | `server/game/engine.ts` | `mine()` valide puis applique chaque coup dans une transaction SQLite. Il met ensuite à jour l'état mémoire **après COMMIT** et émet des événements (`block`, `layer`, `seasonEnded`, `seasonStarted`, `brigadeChanged`, `profileChanged`). |
| Fin de couche | `engine.ts`, dans `mine()` | Quand le dernier bloc d'une couche tombe, `currentLayer` avance et l'événement `layer` est émis. Le joueur qui a détruit ce dernier bloc est connu à cet endroit précis. |
| Journal des coups | table `hits` | Chaque coup y figure : joueur, brigade, couche, bloc, destruction, horodatage. Unicité `(player_id, action_id)`. L'historique complet de la saison peut donc être recalculé. |
| Contributions | tables `contributions`, `brigade_contributions` | Coups et blocs par joueur et par brigade pour la saison, avec un cache mémoire trié pour les classements. |
| Saisons | table `seasons`, `startSeason()`, `endSeason()`, `tick()` | Durée réglable (`SEASON_DURATION_HOURS`, 168 h par défaut), démarrage automatique, clôture par fin du cube, par échéance ou par l'administration. La clôture après un arrêt brutal est rattrapée (`recoverCompletedSeason`). |
| Résultats archivés | table `season_results` | Classement final des joueurs et des brigades (top 100). |
| Brigades | tables `brigades`, `brigade_members` | Création, code d'invitation, adhésion, départ, taille minimale et maximale, éligibilité. |
| Limites anti-triche | `rateLimiter.ts`, `playtime.ts` | 5 coups par seconde par compte, 4 h de temps actif par jour, idempotence. Ces limites sont appliquées **avant** toute récompense, ce qui les rend réutilisables telles quelles. |
| Migrations | `SqliteStore.migrate()` | Ajout de colonnes ou de tables avec `IF NOT EXISTS`. Un test de migration depuis le schéma v1 existe. |
| Diffusion | `server/net/gameServer.ts` | `broadcast()`, diffusion groupée des deltas, rafraîchissement périodique du classement. Le message `welcome` porte l'état complet à la (re)connexion. |
| Administration | `server/net/http.ts` | `/api/admin/season/start` et `/api/admin/season/end`, protégées par jeton. On peut y brancher la création d'une mini-saison. |

### Protocole et client

| Système | Où | Ce qui est utile pour la suite |
|---|---|---|
| Protocole | `shared/protocol.ts` | Messages typés, version 1. Ajouter des champs **optionnels** reste compatible avec les clients existants. |
| Réception d'une couche | `client/src/main.ts`, `case 'layer'` | Affiche aujourd'hui une simple notification : « Couche n atteinte ! ». C'est le point d'accroche naturel pour annoncer une découverte. |
| Fin de saison | `showSeasonEnd()`, `#season-dialog` | Dialogue texte : raison, champion, brigade, Pierre finale. C'est la base de la future cérémonie. |
| Écran holographique | `world/monolith/hologram.ts` | Il affiche déjà une alerte (`holoAlert`). On peut y ajouter une ligne « secret révélé ». |
| Panneau latéral | onglets Classement / Brigade / Saisons / Profil | Un onglet ou une section peut accueillir les découvertes, les missions et les objectifs. |
| Rendus | `WorldView` (classique et monolithe) | Le contrat commun permet d'ajouter un calque visuel (`WorldLayer`) **sans toucher aux deux rendus**, comme pour la présence et le panneau. |

### Tests

- **133 tests unitaires** répartis en 13 fichiers. Les aides de `tests/helpers.ts` (`makeEngine`, `FakeClock`, `newPlayer`, `aid`) permettent de tester le moteur hors réseau, avec une horloge simulée.
- **Tests navigateur** : 31 vérifications dans `scripts/e2e-browser.mjs`, avec `--rendu monolithe|classique`.

## Réutilisation prévue

### 1. Découvertes collectives

Proposition, à confirmer par le cahier des charges :

- **Déclencheur** : la fin d'une couche « importante ». La liste des couches serait définie côté serveur, en fraction de la profondeur, pour fonctionner avec un cube de 32 comme de 48. Le déclenchement se ferait dans le moteur, après COMMIT, au même endroit que l'événement `layer`. Aucun nouveau chemin d'écriture ne serait ouvert aux joueurs : une découverte se gagne seulement par des coups déjà validés, donc soumis aux mêmes limites.
- **Persistance** : une petite table `discoveries`, avec la saison, l'identifiant du secret, l'instant de révélation et le joueur ou la brigade ayant fait tomber le dernier bloc. Ces valeurs sont aussi reconstructibles depuis `hits` si nécessaire.
- **Révélation progressive** : chaque secret aurait plusieurs fragments. Le fragment courant se dévoile selon l'avancement réel de la couche en cours, une donnée que le serveur connaît déjà (`layerRemaining`). Le secret est complet quand la couche tombe. Rien ne serait inventé côté client.
- **Diffusion** : un champ optionnel dans `welcome` et dans `layer`, ou un message `discovery`. La reprise après reconnexion passerait par `welcome`, sans rien de nouveau.
- **Client** :
  - une annonce mise en scène quand un secret est révélé ;
  - une ligne sur l'écran holographique ;
  - une section « Découvertes » dans le panneau ;
  - en rendu monolithe, un indice visuel discret dans la couche (calque `WorldLayer`).
  
  Le rendu classique reçoit la même information, sous une forme plus simple.
- **Tests** :
  - déclenchement exactement à la fin de couche ;
  - aucune découverte en double, y compris après un SIGKILL et une reprise ;
  - cubes de tailles différentes ;
  - fragments progressifs ;
  - diffusion WebSocket ;
  - e2e sur les deux rendus.

### 2 à 5. Suite, après les découvertes

| Chantier | Réutilisation principale |
|---|---|
| Missions individuelles | Les événements du moteur et le journal `hits` permettent de calculer la progression côté serveur. Les récompenses resteraient purement cosmétiques (titres, apparences de `shared/skins.ts`) et n'influenceraient jamais les coups, les classements ni les limites. |
| Objectifs de brigade | `brigade_contributions` et `brigadeChanged`. |
| Cérémonie de fin de saison | `endSeason()`, `season_results` et `seasonEnded` ; le dialogue actuel serait remplacé par une séquence mise en scène dans la vue monumentale. |
| Mini-saison privée de 48 h | `startSeason({ durationMs, cubeSize })` existe déjà. Il faudra ajouter la notion de saison **privée** (accès par code, isolement du classement public) et des statistiques de participation calculables depuis `hits` et `playtime`. C'est le chantier le plus structurant : le moteur ne gère aujourd'hui qu'**une seule saison active à la fois**. |

## Points d'attention

- **Une seule saison active** (`GameEngine.state`). Une mini-saison privée qui tournerait en parallèle de la saison publique demanderait plusieurs états de saison dans le moteur. C'est le seul changement profond identifié ; il est à trancher avant le chantier 5.
- **Aucune récompense ne doit passer par un autre chemin que `mine()`**, pour que les limites (5 coups/s, 4 h par jour, idempotence) s'appliquent d'office.
- **Pas d'effet avant confirmation du serveur** : les annonces de découverte partent de messages serveur, jamais d'une prédiction du client.
