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
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_read_timeout 120s;
}
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Définissez `ALLOWED_ORIGINS=https://votre-domaine` pour refuser les WebSocket d'autres origines, et **`TRUST_PROXY=true`** pour que les limites par IP s'appliquent à l'IP réelle du client (sinon toutes les connexions semblent venir du proxy et la limite de 20 connexions serait atteinte immédiatement). Ne l'activez que si le serveur n'est joignable **que** via ce proxy, qui doit ajouter `X-Forwarded-For` (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`).

Les limites par IP (`MAX_CONNECTIONS_PER_IP`, `NEW_ACCOUNTS_PER_IP_PER_HOUR`) peuvent gêner des lieux partageant une IP (établissement scolaire, entreprise) : surveillez `connectionsRefused` et `accountsRefused` dans `/api/stats`.

## Saison de 30 jours

```bash
npm run calibrate -- --days 30 --players 200 --minutes 30
# CUBE_SIZE=32  BLOCK_BASE_HP=440  BLOCK_HP_PER_LAYER=29  SEASON_DURATION_HOURS=720
```

Les paramètres dépendent entièrement de l'estimation de fréquentation : suivez `GET /api/season/projection` les premiers jours et ajustez la saison suivante (`/api/admin/season/start` accepte `cubeSize`, `baseHp`, `hpPerLayer`, `durationHours`). Une saison en cours n'est pas recalibrée.

## Durabilité

`SQLITE_SYNCHRONOUS=NORMAL` (défaut) : aucun coup validé n'est perdu si le **processus** est tué (vérifié par SIGKILL) ; une coupure électrique peut perdre les dernières transactions, la base restant cohérente. `SQLITE_SYNCHRONOUS=FULL` supprime ce risque au prix de performances non mesurées.

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

### Mesures après l'audit (4 novembre 2026, même machine, même jour)

Comparaison avec la version précédente (`564db0e`) exécutée dans les mêmes conditions, 400 robots, 15 s, 2 essais chacune :

| Version | Coups acceptés/s | Latence p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| avant audit | 1 529 – 1 555 | 23–25 ms | 57–68 ms | 93–144 ms |
| après audit | 1 445 – 1 522 | 25–34 ms | 79–98 ms | 133–141 ms |

À 100 robots : ~447 coups/s acceptés, p95 12 ms, 0 erreur. Le durcissement coûte environ 3 à 5 % de débit à forte charge. La machine était un peu plus lente que lors des mesures ci-dessous (la version précédente y faisait ~1 626 coups/s) : seules les comparaisons du même jour sont significatives.

Le test de charge lève les limites par IP (tous les robots viennent de 127.0.0.1). Contre un serveur externe (`--url`), relevez `MAX_CONNECTIONS_PER_IP` et `NEW_ACCOUNTS_PER_IP_PER_HOUR` sur ce serveur pendant le test.

### Mesures initiales (3 novembre 2026)

Machine : conteneur Linux à 4 vCPU, Node 22.23. Robots et serveur **dans le même processus** (ils se partagent le CPU : les chiffres sont pessimistes pour le serveur, mais ne valent que pour cette machine). Cube 32³, 40 PV par bloc, 15 s par essai.

| Robots | Coups acceptés/s | Latence p50 | p95 | p99 | Erreurs |
|---:|---:|---:|---:|---:|---:|
| 100 | ~448 | 1,8 ms | 14 ms | 18 ms | 0 |
| 400 | ~1 626 | 17 ms | 43 ms | 72 ms | 0 |
| 1 000 | ~1 421 (saturé) | 310 ms | 506 ms | 1 152 ms | 0 |

Lecture : sur cette machine, le processus sature vers **1 400–1 600 coups/s**, soit environ 300 à 350 joueurs minant en continu à la vitesse maximale. Au-delà, la latence se dégrade fortement. Ces mesures **ne valident pas** une capacité de production : réseau réel, TLS, autre matériel, et robots séparés du serveur donneront d'autres résultats. Refaites la mesure sur l'infrastructure cible, avec `--url` et les robots sur une autre machine.

Pistes si nécessaire : regrouper les écritures SQLite en micro-lots, réduire la fréquence des deltas, diffuser des deltas binaires, séparer la diffusion dans un worker.
