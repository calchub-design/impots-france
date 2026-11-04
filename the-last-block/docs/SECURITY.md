# Sécurité — état réel du prototype

Ce document dit ce qui est vérifié **par des tests automatisés** et ce qui ne l'est pas. Aucun audit de sécurité n'a été réalisé.

## Vérifié par les tests

- Le serveur refuse les coups mal formés, hors limites, sur une couche verrouillée ou sur un bloc détruit.
- Un même `actionId` n'est jamais appliqué deux fois pour un joueur, y compris après redémarrage.
- Limite de 5 coups/s par compte, partagée entre plusieurs connexions du même compte.
- Limite quotidienne de temps actif, persistée en base.
- Routes d'administration : refusées sans `ADMIN_TOKEN` configuré (403) et avec un mauvais jeton (401). Comparaison à temps constant.
- Une demande de connexion Google sans implémentation réelle est refusée (`auth_unavailable`).
- Messages JSON invalides ou inconnus : erreur renvoyée, connexion conservée.

## Mesures en place, non testées en conditions hostiles

- Taille maximale d'un message WebSocket : 2 Kio ; anti-flood de 40 messages/s par connexion (fermeture après abus répété).
- Fermeture des connexions sans `hello` au bout de 10 s ; heartbeat ping/pong de 30 s.
- Liste blanche d'origines WebSocket (`ALLOWED_ORIGINS`).
- Le client n'insère jamais de texte joueur via `innerHTML` (uniquement `textContent`).
- Les fichiers statiques sont servis en interdisant la sortie du dossier.

## Limites connues

- **Comptes invités** : le jeton dans `localStorage` donne le contrôle du compte ; il n'y a ni récupération, ni authentification forte.
- **Comptes multiples** : rien n'empêche de créer de nombreux comptes invités (pas de limite par IP, pas de captcha). Les limites par compte (débit, 4 h) sont donc contournables par une personne déterminée.
- **Robots** : aucun système de détection d'automatisation ; le maintien du bouton *Miner* est d'ailleurs une fonctionnalité prévue.
- **Pas de limite de création de comptes ou de brigades par IP.**
- **Déni de service** : non testé.
- HTTPS doit être assuré par un reverse proxy (non fourni).
