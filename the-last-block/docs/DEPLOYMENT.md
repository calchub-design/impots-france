# Déploiement (non effectué)

Rien n'a été déployé publiquement. Ce document décrit une mise en production possible sur un serveur que vous contrôlez, sans service payant imposé.

## Processus unique

Le serveur garde l'état du cube en mémoire : lancez **une seule instance** par base de données. Ne mettez pas plusieurs réplicas derrière un répartiteur de charge.

```bash
cd the-last-block
npm ci
npm run build
cp .env.example .env    # puis éditez : ADMIN_TOKEN, ALLOWED_ORIGINS, DB_PATH…
npm start
```

Exemple d'unité systemd :

```ini
[Unit]
Description=The Last Block
After=network.target

[Service]
WorkingDirectory=/opt/the-last-block
EnvironmentFile=/opt/the-last-block/.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning dist/server/server/index.js
Restart=on-failure
User=lastblock

[Install]
WantedBy=multi-user.target
```

## Proxy HTTPS

Placez un reverse proxy TLS (Caddy, nginx) devant le port 8080 et transmettez les en-têtes WebSocket. Exemple nginx :

```nginx
location /ws {
  proxy_pass http://127.0.0.1:8080;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 120s;
}
location / {
  proxy_pass http://127.0.0.1:8080;
}
```

Définissez `ALLOWED_ORIGINS=https://votre-domaine` pour refuser les WebSocket d'autres origines.

## Sauvegardes

La base est un fichier SQLite en mode WAL. Sauvegarde à chaud :

```bash
sqlite3 data/lastblock.sqlite ".backup 'backup-$(date +%F).sqlite'"
```

## Administration

```bash
curl -X POST https://votre-domaine/api/admin/season/end   -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X POST https://votre-domaine/api/admin/season/start -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H 'content-type: application/json' -d '{"name":"Saison 2","cubeSize":16,"durationHours":336}'
```

## Test de charge

```bash
npm run loadtest -- --bots 100 --seconds 15              # serveur démarré dans le même processus
npm run loadtest -- --url ws://localhost:8080/ws --bots 200   # serveur déjà lancé
```

Chaque robot est un compte distinct qui mine un bloc aléatoire toutes les 220 ms (≈ 4,5 coups/s, sous la limite de 5/s).

### Mesures réalisées (4 novembre 2026)

Machine : conteneur Linux à 4 vCPU, Node 22.23. Robots et serveur **dans le même processus** (ils se partagent le CPU : les chiffres sont pessimistes pour le serveur, mais ne valent que pour cette machine). Cube 32³, 40 PV par bloc, 15 s par essai.

| Robots | Coups acceptés/s | Latence p50 | p95 | p99 | Erreurs |
|---:|---:|---:|---:|---:|---:|
| 100 | ~448 | 1,8 ms | 14 ms | 18 ms | 0 |
| 400 | ~1 626 | 17 ms | 43 ms | 72 ms | 0 |
| 1 000 | ~1 421 (saturé) | 310 ms | 506 ms | 1 152 ms | 0 |

Lecture : sur cette machine, le processus sature vers **1 400–1 600 coups/s**, soit environ 300 à 350 joueurs minant en continu à la vitesse maximale. Au-delà, la latence se dégrade fortement. Ces mesures **ne valident pas** une capacité de production : réseau réel, TLS, autre matériel, et robots séparés du serveur donneront d'autres résultats. Refaites la mesure sur l'infrastructure cible, avec `--url` et les robots sur une autre machine.

Pistes si nécessaire : regrouper les écritures SQLite en micro-lots, réduire la fréquence des deltas, diffuser des deltas binaires, séparer la diffusion dans un worker.
