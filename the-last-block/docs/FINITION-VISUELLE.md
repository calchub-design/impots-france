# Finition visuelle avant la bêta (points 1 à 6)

Retouches de présentation, **sans nouvelle mécanique**. Aucun changement du serveur ni du protocole.

## Ce qui a changé

| # | Problème constaté sur les captures | Correction |
|---|---|---|
| 1 | Mini-carte et coordonnées posées **sur l'écran holographique** (petits cubes, zooms intermédiaires). | Le rendu publie à chaque image la place de l'écran holographique et son opacité. La mini-carte s'efface dès qu'il passe dessous. Les pseudos des mineurs ne se posent plus dessus. |
| 2 | « 1 coups », « 1 actifs », « 0 actifs », et ailleurs « 1 membres », « 1 blocs détruits ». | Accord en nombre partout où un nombre est suivi d'un nom : singulier pour 0 et 1, pluriel au-delà (`client/src/text.ts`). Concerne les pastilles, l'écran holographique, le classement des brigades, la cérémonie, le Hall et l'onglet Brigade. |
| 3 | Le classement apparaît **deux fois** : bandeau en haut et écran holographique juste dessous. | Le bandeau se masque dès que l'écran holographique est **lisible** : au moins 35 % de la largeur, assez opaque, visible aux deux tiers. Le bandeau revient en vue de minage, quand l'écran est lointain et estompé. |
| 4 | Écran holographique illisible sur téléphone : libellés de 4 à 7 px, environ 150 px de large. | L'écran est plus large (1,5 arête au lieu de 1,1) et un peu plus haut (rapport 0,56). Les textes sont agrandis (pseudos 11 unités au lieu de 9, libellés 7 au lieu de 5,5). Les textes trop longs **rétrécissent avant d'être coupés**. Sur iPhone 13, l'écran fait 270 px sur 376, et les pseudos environ 16 px au lieu de 7 px. |
| 5 | Vue monumentale mal remplie : ensemble décentré, l'hologramme sortait même à droite du cadre une fois agrandi. | Le cadrage tient compte de l'écran holographique réel (largeur et hauteur). Il **centre** l'ensemble cube et écran, horizontalement et verticalement, au-dessus des pastilles du bas. Il occupe 94 % de la largeur ou 88 % de la hauteur utile. Le décalage ne s'applique qu'en vue monumentale : la vue de minage reste centrée sur le bloc visé. |
| 6 | Vue de minage : trous, blocs abîmés et bloc sélectionné peu contrastés. | Fonds et parois des puits plus sombres. Blocs abîmés assombris par palier (16 % au lieu de 10 %), avec des fissures plus visibles. Sélection plus lumineuse (remplissage 32 % au lieu de 16 %, cadre de 3 px). **Contraste mesuré entre bloc intact et trou, sur iPhone : 1,49 avant, 2,22 après.** |

## Effet secondaire assumé

En vue monumentale, le pseudo d'un mineur situé juste sous l'écran holographique n'est plus affiché, car l'étiquette ne peut pas être déplacée loin de son mineur sans tromper. Son marqueur (losange et faisceau) reste visible. En vue de minage, rien ne change.

## Vérifications

- **Tests unitaires** : 239 au total, dont 10 nouveaux dans `tests/finition.test.ts`.
  - Accords en nombre.
  - Règle de lisibilité de l'écran holographique et chevauchements.
  - Pseudos hors de la zone réservée.
  - Cadrage monumental pour des cubes de 4, 12 et 40 et des vues portrait, bureau et paysage : tout est à l'écran, centré à 2 px près, et remplit la zone.
  - Absence de décalage en vue de minage.
- **e2e** :
  - nouvelle vérification dans `e2e-browser` : en vue monumentale sur iPhone, l'écran holographique est entier, occupe au moins 55 % de la largeur, sans bandeau ni mini-carte ;
  - toutes les suites passent sur les deux rendus : e2e 32/32 en monolithe et 31/31 en classique, découvertes, missions, brigades, cérémonie, bêta.
- **Zoom intermédiaire** sur un cube de 4 (cas de la photo d'origine), le bandeau et la mini-carte sont masqués à chaque palier où l'écran est lisible :

  | Paliers testés | Valeur de `t` |
  |---|---|
  | ×1,03 | 0,97 |
  | ×1,07 | 0,87 |
  | ×1,12 | 0,68 |
  | ×1,18 | 0,42 |

Captures avant / après : `npm run build && NODE_PATH=$(npm root -g) npm run captures:finition -- --prefixe apres`. Ce script couvre les cubes de 4, 12 et 40, sur iPhone et ordinateur, en vues minage, panneau et monument.

| | |
|---|---|
| Vue monumentale, iPhone, cubes 12 et 40 | ![](captures/finition/monument-iphone-cube12.png) |
| Vue monumentale, ordinateur | ![](captures/finition/monument-bureau-cube12.png) |
| Petit cube (photo d'origine : bandeau et mini-carte sur l'écran) | ![](captures/finition/petit-cube-iphone.png) |
| Contraste en vue de minage | ![](captures/finition/minage-contraste-iphone.png) |
