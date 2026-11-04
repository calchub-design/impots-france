# Sécurité — état réel du prototype

Aucun audit de sécurité externe n'a été réalisé. Un audit ciblé interne (4 novembre 2026) est détaillé dans [AUDIT.md](AUDIT.md) : problèmes trouvés avec preuves, corrections, problèmes ouverts. Ce document résume le modèle et distingue ce qui est **vérifié par des tests automatisés** de ce qui ne l'est pas.

## Modèle d'identité

- **Compte invité** : au premier `hello` sans jeton, le serveur génère un jeton aléatoire de 256 bits, le remet une seule fois au client (stocké dans `localStorage`, une clé par `?profil=`) et ne conserve que son empreinte SHA-256.
- **Session** = la connexion WebSocket. Elle n'est associée à un compte qu'après présentation du jeton dans `hello`. Ensuite, toutes les actions utilisent l'identité attachée à la connexion côté serveur. **Aucun identifiant de joueur envoyé par le client n'est jamais lu.**
- **Reprise** : à la reconnexion, le client renvoie son jeton. Un jeton inconnu ou révoqué est refusé (`invalid_token`, fermeture 4003) : aucun compte n'est créé en silence.
- **Rotation** (`rotateToken`) : nouveau jeton ; les autres sessions du compte sont fermées (4002). Les onglets du même navigateur se reconnectent avec le nouveau jeton, les autres appareils perdent l'accès.
- **Révocation** (`logout`) : plus aucun jeton ne donne accès au compte ; toutes les sessions sont fermées.
- **Sessions simultanées** : 4 par compte au maximum ; au-delà, la plus ancienne est fermée (4001) et ne se reconnecte pas automatiquement.

## Vérifié par les tests automatisés

- Impossible d'agir sur un autre compte via un paramètre d'URL, un champ de `hello`, de `mine` ou de `setName`.
- Aucune réponse HTTP ou WebSocket ne contient de jeton, d'empreinte de jeton ni le code d'invitation d'une brigade dont on n'est pas membre.
- Jetons mal formés ou inconnus refusés sous 7 formes (chaîne, nombre, objet, tableau, caractères non ASCII…).
- Rotation, révocation, limite de sessions par compte.
- Limites par IP : 20 connexions simultanées (HTTP 429 à la poignée de main), 30 créations de compte par heure ; `X-Forwarded-For` ignoré sauf `TRUST_PROXY=true`, auquel cas seule la dernière valeur est utilisée.
- Pseudos uniques (insensibles à la casse et à la forme NFKC, ex. pleine chasse).
- Messages malformés (JSON invalide, types inattendus, `__proto__`, `constructor`, caractères de contrôle et d'inversion de sens, noms HTML, coups hors limites, `Infinity`) : erreur explicite, connexion conservée, aucun effet.
- Message > 2 Kio : fermeture 1009 ; trame binaire : fermeture 1003.
- Doublons : même `actionId` avec d'autres coordonnées, ou sur deux sessions simultanées → appliqué une seule fois.
- Limites de jeu : 5 coups/s par compte (toutes sessions, reconnexions comprises) ; 4 h actives par jour sous 5 rythmes adversariaux, au changement de jour et après redémarrage.
- Codes d'invitation : 10 échecs maximum par 10 min et par joueur.
- Administration : 403 sans `ADMIN_TOKEN`, 401 avec un mauvais jeton, 429 après 10 échecs depuis une IP ; comparaison à temps constant.
- Page : CSP stricte (`script-src 'self'`, aucun script ou style inline, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`. Le test à deux navigateurs n'a relevé aucune violation CSP.
- Chemins statiques : traversée impossible, encodage invalide → 400.

## Mesures en place, non testées en conditions hostiles réelles

- Anti-flood : 40 messages/s par connexion, avertissement explicite, expulsion après abus répété (le compteur décroît après 10 s de calme).
- Actions de profil et de brigade : 20 par 10 s et par compte.
- Délai de 10 s pour envoyer `hello` ; heartbeat de 30 s.
- Liste blanche d'origines WebSocket (`ALLOWED_ORIGINS`).
- Le client n'insère jamais de texte joueur via `innerHTML`.

## Limites connues

Voir [AUDIT.md § 3](AUDIT.md#3-problèmes-restant-ouverts) : multi-comptes via plusieurs IP, robots respectant les limites, IP partagées (NAT), homoglyphes entre alphabets, jeton en `localStorage` (vol possible en cas de XSS), `/api/stats` public, perte des dernières transactions en cas de coupure électrique avec `SQLITE_SYNCHRONOUS=NORMAL`, déni de service non testé. Le HTTPS doit être assuré par un reverse proxy.
