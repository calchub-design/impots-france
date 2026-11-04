# Refonte visuelle : cube colossal navigable

Ce document trace la refonte de l'interface (novembre 2026) : analyse de départ, architecture retenue, ce qui est réellement fonctionnel et ce qui ne l'est pas.

## Phase A — Analyse du prototype existant

### Ce qui existait

- `client/src/scene.ts` : un seul canvas dessinant **tout le cube** en isométrique (taille fixe, petite) et un panneau top 10 au-dessus.
- Le serveur n'expose que la **couche courante** : une grille `taille × taille` (`CubeSnapshot.currentHp`, index `y × taille + x`) mise à jour par deltas absolus `[couche, bloc, pv]`. Seule cette couche est minable.
- Un toucher sur le canvas **sélectionnait et minait** immédiatement.
- `main.ts` déclenchait un effet d'impact **dès l'envoi** du coup, avant la réponse du serveur (le serveur restait autoritaire sur les PV, mais l'impact visuel était anticipé).
- Taille de cube par défaut : 10 (100 blocs par couche), maximum 64.

### Risques identifiés

| Risque | Décision |
|---|---|
| Le modèle serveur n'a pas de « faces » : les couches sont des tranches horizontales. | Une seule face jouable : **le dessus de la couche courante** (`faceId: 'top'`). Aucune autre face n'est présentée comme jouable. |
| Une surface « monumentale » exige plus de blocs que 10 × 10. | Taille par défaut portée à **32** (1 024 blocs par couche) ; le maximum de 64 (4 096 blocs, ~2 800 px de large à 44 px par bloc) suffit sans modifier le protocole. Les règles (PV, saisons, limites) ne changent pas. |
| Coût du dessin d'une grande grille. | Culling : seuls les blocs visibles sont dessinés ; rendu à la demande (pas de boucle permanente quand rien ne bouge). |
| Conflit entre glisser (déplacer la caméra) et toucher (sélectionner), et avec le défilement de la page. | Seuil de mouvement par type de pointeur ; `touch-action: none` sur la surface ; sur mobile, la page ne défile plus : les panneaux deviennent un tiroir. |
| Toucher = miner : un glissement mal reconnu minerait par erreur. | Toucher = **sélection seule** ; le bouton Miner (ou Espace) agit sur le bloc sélectionné. |
| Effets anticipés. | Supprimés : l'envoi affiche un état « en attente » ; impact, fragments et destruction ne sont montrés qu'après confirmation du serveur (réponse ou delta). |
| Changement de couche : toute la surface est remplacée. | Caméra conservée, sélection déplacée sur le bloc vivant le plus proche. |
| Présence des autres joueurs : aucune donnée côté serveur. | Phase D : présence **dérivée des coups réels** (dernier bloc miné il y a moins de 20 s), agrégée et diffusée au plus une fois par seconde. Aucun mouvement de caméra n'est transmis. |
| Tests navigateur existants fondés sur « toucher = miner ». | Script e2e réécrit : glisser, pincer, sélectionner après déplacement, miner. |

### Architecture retenue (client uniquement, sans dépendance)

```
client/src/world/
  face.ts       modèle d'une face : index ⇄ (x, y), voisinage, bloc vivant le plus proche, plage visible
  camera.ts     caméra 2.5D : centre (x, y) en blocs, zoom (px/bloc), inclinaison, inertie, limites, animations
  gestures.ts   reconnaissance tap / glisser / pincer (logique pure, testable) + liaison DOM, molette, clavier
  surface.ts    rendu Canvas 2D de la face visible (blocs en relief, puits, falaise, repères d'échelle, effets)
  minimap.ts    mini-carte de toute la face, rectangle de vue, saut par toucher
client/src/scene.ts   l'ancienne vue isométrique, réutilisée pour la « Vue d'ensemble »
```

Les modules `face`, `camera` et la logique de `gestures` n'accèdent pas au DOM : ils sont testés par Vitest.
