# Audit ciblé — 4 novembre 2026

Périmètre : identité des joueurs, limites de jeu (5 coups/s, 4 h actives/jour), reprise après arrêt brutal, messages hostiles, calibrage des saisons sur ~30 jours. Ensuite seulement : panneau géant et ergonomie mobile.

Méthode : relecture du code, puis **script de sondage exécuté sur la version d'avant correction** (commit `564db0e`) pour confirmer chaque soupçon par une preuve, puis corrections, puis tests de non-régression. Aucune refonte de l'architecture (même moteur, même protocole étendu, même stockage).

Ce document distingue :
1. [les problèmes constatés et corrigés](#1-problèmes-constatés-et-corrigés) ;
2. [ce qui a été vérifié sans défaut](#2-vérifié-sans-défaut-trouvé) ;
3. [les problèmes qui restent ouverts](#3-problèmes-restant-ouverts) ;
4. [les tests réellement exécutés](#4-tests-réellement-exécutés).

---

## 1. Problèmes constatés et corrigés

### Preuves avant correction (sortie du script de sondage, version `564db0e`)

```
A proto provider -> {"t":"error","code":"internal_error","message":"Erreur interne."}
B comptes créés depuis 127.0.0.1 en rafale: 60/60
C jeton inconnu -> welcome (nouveau compte silencieux: true)
D 4000 coups espacés de 21 s (~23 h): acceptés=4000, temps actif compté=0 ms
E homonyme "alice" accepté pour un 2e compte
F après redémarrage: saison active=1, statut base=active, Pierre finale=null
G redémarrage 1 s après la fin (délai 1 h): nouvelle saison démarrée immédiatement=true
```

| # | Gravité | Problème | Correction | Test de non-régression |
|---|---|---|---|---|
| D | **Élevée** | **Contournement de la limite de 4 h** : seuls les écarts ≤ 20 s entre coups étaient comptés. En frappant toutes les 21 s, un joueur jouait 24 h/24 sans que rien ne soit décompté (4 000 coups acceptés, 0 ms compté). | Nouveau modèle « réunion des fenêtres » : chaque coup rend actif pendant W = 5 s ; un coup crédite `min(écart, W)`. Aucun coup n'est gratuit. Borne démontrée : ≤ 5 × limite (s) + 5 coups/jour, quel que soit le rythme. | `limits.test.ts` : régression 21 s (refus après 2 880 coups = 4 h), 5 rythmes adversariaux (rafales, 200 ms, 5,01 s, rafales + pauses, aléatoire) |
| F | **Élevée** | **Saison bloquée après crash** : le dernier coup et la clôture de saison étaient deux transactions. Un arrêt entre les deux laissait une saison « active » sans bloc, jamais clôturée avant l'échéance, et la Pierre finale perdue. | Au démarrage, une saison active sans bloc restant est clôturée (`completed`) avec la Pierre finale retrouvée dans le journal des coups et la date du dernier coup. | `crash.test.ts` « dernier bloc validé mais saison non clôturée » |
| C | Moyenne | **Jeton inconnu → nouveau compte silencieux** : un appareil dont le jeton avait été révoqué, ou un client falsifié, devenait un autre joueur sans rien signaler. | Refus explicite `invalid_token` + fermeture 4003. Le client efface son jeton, prévient le joueur et crée un compte de façon visible. | `security.test.ts` « jeton inconnu refusé explicitement » (7 formes de jeton, aucun compte créé) |
| E | Moyenne | **Usurpation visuelle sur le panneau** : plusieurs comptes pouvaient porter le même pseudo (« Alice » / « alice »), y compris celui du champion. | Pseudos uniques par clé normalisée (NFKC + minuscules + espaces). Migration de schéma v2 ; les homonymes historiques gardent leur nom sans le réserver. | `security.test.ts` (casse, pleine chasse « Ａｌｉｃｅ », espaces), `migration.test.ts` |
| B | Moyenne | **Création de comptes illimitée** depuis une IP (60/60 en rafale) et connexions illimitées : multi-comptes triviaux, base gonflée. | 30 créations de compte/h et 20 connexions simultanées par IP (configurables) ; `X-Forwarded-For` lu seulement si `TRUST_PROXY=true` (dernière valeur). Au plus 4 sessions par compte : la plus ancienne est fermée (4001), sans reconnexion automatique. | `security.test.ts` « création de comptes limitée », « connexions simultanées limitées » (HTTP 429), « 4 sessions par compte », `clientIp` |
| G | Faible | **Délai inter-saison ignoré après redémarrage** : la saison suivante démarrait aussitôt. | Délai recalculé depuis la date de fin de la dernière saison en base. | `crash.test.ts` (unitaire + SIGKILL réel avec délai d'1 h) |
| A | Faible | `auth.provider = "__proto__"` provoquait une exception (« erreur interne » + trace dans les journaux). | Recherche du fournisseur via `Object.hasOwn`, validation du type. | `security.test.ts` (8 noms exotiques, 4 formes invalides) |
| — | Faible | Pas de révocation possible d'un jeton copié. | Messages `rotateToken` (nouveau jeton, autres sessions fermées en 4002) et `logout` (révocation). Boutons dans le profil. | `security.test.ts` rotation et logout ; test navigateur : rotation entre deux onglets |
| — | Faible | Recherche exhaustive des codes d'invitation limitée seulement par l'anti-flood. | 10 codes invalides max par joueur et par 10 min. | `security.test.ts` « invitations invalides » |
| — | Faible | Force brute du jeton admin non freinée. | 10 échecs max par IP et par 10 min (429). | `security.test.ts` « administration » |
| — | Faible | Page servie sans CSP (le jeton invité vit dans `localStorage`, une injection l'exposerait). | CSP stricte (`script-src 'self'`, aucun inline, `frame-ancestors 'none'`), `X-Frame-Options`, `Referrer-Policy`. | `security.test.ts` en-têtes ; test navigateur : aucune violation CSP |
| — | Faible | Chemin d'URL mal encodé (`/%E0%A4%A`) → erreur 500. | 400 ; octet nul refusé. | `security.test.ts` |
| — | Faible | Anti-flood : messages en excès **ignorés en silence** (le client attendait indéfiniment) et compteur d'avertissements qui ne décroissait jamais (une connexion longue finissait expulsée). | Avertissement `flood` explicite (limité) ; compteur remis à zéro après 10 s sans abus. | Découvert par `limits.test.ts` ; comportement couvert par les tests WebSocket |
| — | Faible | Actions de profil/brigade non limitées par compte (écritures en base + diffusions). | 20 actions par 10 s et par compte (le minage a sa propre limite). | `security.test.ts` |
| — | Faible | Échéance dépassée pendant un arrêt : la saison était datée du redémarrage. | Date de fin = échéance. | `crash.test.ts` |
| — | Faible | Calibrage : l'arrondi de la progression par couche décalait la durée prévue jusqu'à +13 %. | Base recalculée après arrondi. | `calibration.test.ts` (12 hypothèses, ±10 %) |
| — | Faible | Estimation de fin fondée sur la dernière heure : fausse avec un cycle jour/nuit. | Moyenne depuis le début de saison (recalculée depuis la base après redémarrage). | Simulation de 30 jours : estimation du 11e jour juste à ±2 jours |
| — | UI | Mobile : bouton Miner hors écran dès qu'on fait défiler ; blocs de 25×12 px sur un cube de 12 ; notifications masquant le bouton ; panneau limité à 2 lignes sur 360 px ; panneau vide et trompeur pendant l'intersaison. | Barre d'action fixe en bas d'écran, aimantation du toucher vers le bloc vivant le plus proche, panneau repensé (voir README), titres de la saison écoulée pendant l'intersaison. | Captures 360 px / 1280 px, test à deux navigateurs |

---

## 2. Vérifié sans défaut trouvé

- **Aucune usurpation de compte directe** : l'identité est attachée à la connexion WebSocket côté serveur, uniquement après présentation du jeton secret (256 bits, seule l'empreinte SHA-256 est stockée). Aucun message ni aucune route HTTP n'accepte d'identifiant de joueur. Testé : `playerId`, `id`, `player` dans `hello`, dans l'URL `/ws?playerId=…` et dans les messages `mine`/`setName` sont ignorés ; un second `hello` est refusé ; aucune réponse HTTP ou WebSocket ne contient de jeton, d'empreinte ni le code d'invitation d'une brigade dont on n'est pas membre.
- **Détournement de WebSocket entre sites (CSWSH)** : non applicable, l'authentification ne repose pas sur un cookie. Une page tierce ne peut pas lire le `localStorage` du jeu.
- **Limite de 5 coups/s** : par compte, partagée entre toutes les sessions, non réinitialisée par une reconnexion ; doublons non comptés ; champs forgés (`playtime`, `at`, `hits`) ignorés.
- **Idempotence** : un `actionId` réutilisé avec d'autres coordonnées renvoie le coup d'origine ; le même `actionId` envoyé simultanément sur deux sessions n'est appliqué qu'une fois.
- **Courses** : 8 clients se disputant toutes les couches d'un cube → exactement 8 destructions, une seule Pierre finale, une seule fin de saison.
- **Durabilité** : avec SIGKILL réel en plein minage, aucun coup confirmé au client n'a été perdu et tous les invariants tiennent (voir § 4).

---

## 3. Problèmes restant ouverts

| Sujet | Risque | Piste |
|---|---|---|
| **Multi-comptes** | Une personne déterminée peut créer des comptes depuis plusieurs IP (mobile, VPN) et cumuler les limites par compte (débit, 4 h). Les limites par IP ne font que ralentir. | Authentification forte (Google/Apple réellement vérifiés), détection d'abus, éventuellement vérification de l'appareil. |
| **Robots** | Aucun dispositif anti-automatisation ; le maintien du bouton est d'ailleurs prévu. Un script respectant 5 coups/s et 4 h/jour reste indiscernable d'un joueur. | Accepté par conception : la limite 4 h borne l'avantage. |
| **Limites par IP derrière un NAT** | Une école ou une entreprise partageant une IP peut atteindre 20 connexions / 30 comptes par heure. | Paramètres ajustables ; à surveiller via `/api/stats` (`connectionsRefused`, `accountsRefused`). |
| **Limiteur 5 coups/s en mémoire** | Après redémarrage du serveur, un compte peut placer au plus 5 coups supplémentaires dans la première seconde. | Négligeable ; à persister seulement en multi-processus. |
| **Homoglyphes** | « Аlice » avec un A cyrillique reste distinct de « Alice ». | Table de confusables Unicode (UTS #39) ou restriction à un seul alphabet par pseudo. |
| **Jeton en `localStorage`** | Une injection de script (XSS) volerait le compte. Atténué par la CSP et l'absence d'`innerHTML` ; non éliminé. | Cookie `HttpOnly` + `SameSite=Strict`, avec contrôle d'origine du WebSocket obligatoire. |
| **Perte de courant** | En `SQLITE_SYNCHRONOUS=NORMAL` (défaut), une coupure électrique ou un crash du système peut perdre les dernières transactions validées (la base reste cohérente). Le SIGKILL du processus ne perd rien (testé). | `SQLITE_SYNCHRONOUS=FULL` (non mesuré en charge). |
| **Processus unique** | État du cube en mémoire : une seule instance par base. | Voir ARCHITECTURE.md. |
| **Grands cubes sur mobile** | Au-delà de ~24 blocs d'arête, viser un bloc précis au doigt reste difficile malgré l'aimantation ; le bouton Miner cible automatiquement. | Zoom/panoramique sur la couche courante. |
| **Accessibilité** | Le cube n'est pas utilisable au clavier bloc par bloc (seulement via la barre d'espace / le bouton). Pas de lecteur d'écran pour le panneau Canvas (le classement HTML équivalent existe). | Navigation clavier sur la grille. |
| **`/api/stats` public** | Expose des compteurs et la mémoire du processus. | Le placer derrière `ADMIN_TOKEN` en production. |
| **Surcoût du durcissement** | Mesuré le même jour sur la même machine, à 400 robots : ~3 à 5 % de débit en moins et une latence p95 plus élevée (79–98 ms contre 57–68 ms). | Acceptable pour le prototype ; à suivre. |
| **Déni de service** | Non testé au-delà des limites ci-dessus. | — |

---

## 4. Tests réellement exécutés

Machine : conteneur Linux 4 vCPU, Node 22.23.4, Chromium (Playwright) préinstallé.

| Commande | Résultat |
|---|---|
| `npm test` (exécuté 3 fois de suite) | **90/90** tests, 8 fichiers, ~6 s ; aucun test instable |
| `npm run typecheck` | OK |
| `npm run build` | OK (client Vite + serveur tsc) |
| `npm run e2e` (exécuté 2 fois) | **15/15** vérifications, deux Chromium distincts (iPhone 13 émulé + bureau 1280×860) |
| `npm run loadtest -- --bots 100/400 --seconds 15` | voir DEPLOYMENT.md |
| `npm run calibrate -- --days 30 --players 200 --minutes 30` | cube 32³, 440 → 1 339 coups par bloc, fin attendue 27,0 j |

Détail des fichiers de tests :

| Fichier | Tests | Contenu |
|---|---:|---|
| `engine.test.ts` | 16 | règles de minage, idempotence, limite 5/s, concurrence en mémoire, persistance |
| `seasons.test.ts` | 11 | fin par Pierre finale/échéance/admin, champion, brigades |
| `integration.test.ts` | 12 | WebSocket de bout en bout, API HTTP |
| `security.test.ts` | 23 | usurpation, jetons, rotation, révocation, sessions, limites IP, messages malformés, doublons, courses, pseudos, invitations, admin, CSP |
| `limits.test.ts` | 15 | modèle de temps actif, 5 rythmes adversariaux, changement de jour, redémarrage, reconnexions, sessions multiples |
| `crash.test.ts` | 5 | **SIGKILL réel** du processus serveur en plein minage, puis invariants vérifiés dans le fichier SQLite et reprise ; fenêtres de crash entre transactions |
| `calibration.test.ts` | 7 | formule, 12 hypothèses de fréquentation, **simulation complète de 30 jours**, fin par échéance, achèvement anticipé |
| `migration.test.ts` | 1 | migration d'une base au schéma v1 |

Invariants vérifiés après SIGKILL (directement dans SQLite) : `PRAGMA integrity_check = ok` ; pour chaque bloc, PV = PV max − nombre de coups journalisés ; auteur de la destruction cohérent ; contributions joueur et brigade égales aux décomptes du journal ; au plus une saison active ; **chaque coup confirmé au client est présent avec les mêmes PV restants**. Après redémarrage : mêmes comptes, pseudos, scores, brigade (5 membres, même code) et PV de la couche courante ; le renvoi des 60 dernières actions (confirmées ou non) n'applique aucun coup deux fois.

Vérifications du test à deux navigateurs (`scripts/e2e-browser.mjs`) : comptes distincts ; homonyme refusé et signalé ; même cube et même classement dans les deux navigateurs ; débit du bouton maintenu ≤ 5/s ; clics avec aimantation ; brigade par code ; **SIGKILL du serveur et reconnexion automatique avec les mêmes comptes, scores et brigade** ; rotation du jeton entre deux onglets ; partie jusqu'à la Pierre finale avec la même fenêtre de fin des deux côtés et l'avance sur l'échéance affichée ; aucune erreur JavaScript ni violation CSP.

**Non testé** : comportement réel sur téléphones physiques (émulation seulement), réseaux mobiles instables, Safari/Firefox, coupure électrique, charge au-delà de 1 000 robots, multi-processus, et toute attaque par déni de service.
