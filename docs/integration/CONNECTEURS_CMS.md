# Export direct Shopify et WooCommerce — note de conception (V1)

Statut : V1 implémentée sur la branche `claude/project-thread-oyrqiw`, à valider avant fusion.

## Problème

Aujourd'hui CataMotive produit un **fichier** (CSV WooCommerce, Shopify…) que le marchand doit télécharger puis réimporter lui-même dans sa boutique. C'est la dernière étape manuelle, la plus source d'erreurs (mauvais fichier, mauvais séparateur, import partiel non vu), et elle empêche toute mise à jour régulière des prix et stocks fournisseurs.

Objectif V1 : depuis la page d'export d'un import prêt, **envoyer directement** les lignes valides dans une boutique connectée, en créant les nouveaux produits en brouillon et en mettant à jour les produits existants retrouvés par SKU. Le fichier reste disponible : l'envoi direct s'ajoute, il ne remplace rien.

## Ce que fait la V1 (et ce qu'elle ne fait pas)

| Inclus                                                                 | Reporté (V2+)                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Connexion d'une ou plusieurs boutiques par organisation (admin)        | OAuth « app publique » Shopify / flux d'autorisation WooCommerce    |
| Test de connexion : nom, devise, prix TTC ou HT de la boutique         | Catégories WooCommerce (IDs à résoudre ou créer)                    |
| Upsert par SKU : création en **brouillon**, mise à jour sinon          | Produits à variantes (tailles, couleurs)                            |
| Mode « prix et stock seulement » pour les synchronisations récurrentes | Shopify Bulk Operations (JSONL) pour les catalogues > 10 000 lignes |
| Simulation (aucune écriture) : combien de créations / mises à jour     | Stock multi-emplacements Shopify                                    |
| Reprise après coupure, progression visible, erreurs ligne par ligne    | Exposition dans l'API publique `/api/v1` et la file RabbitMQ        |
| Contrôles bloquants HT/TTC et devise contre la configuration boutique  | Webhooks retour (commandes, stock vendu)                            |

## Décisions

### 1. Identifiants : jetons d'application privée, chiffrés au repos

- **Shopify** : domaine `xxx.myshopify.com` + jeton Admin API d'une _custom app_ (`shpat_…`), portées `write_products`, `read_locations`, `write_inventory`, `read_inventory`. Pas d'OAuth en V1 : il impose une app publique, une revue Shopify et une URL de rappel, disproportionné pour un pilote.
- **WooCommerce** : URL HTTPS de la boutique + clé et secret REST (`ck_…` / `cs_…`) en lecture/écriture, authentification Basic **uniquement sur HTTPS**.
- Les secrets sont chiffrés en **AES-256-GCM** (clé `STORE_CREDENTIALS_KEY`, 32 octets en base64, hors base) avec l'identifiant de connexion en donnée authentifiée : un secret copié sur une autre ligne ne se déchiffre pas. Ils ne sont jamais renvoyés au navigateur (seuls les 4 derniers caractères sont affichés) ni journalisés.
- Gestion réservée au rôle **Administrateur** (nouvelle permission `store:manage`) ; l'envoi suit `export:create` (Administrateur, Opérateur).

### 2. Anti-SSRF

Une URL WooCommerce est saisie par l'utilisateur et appelée par le serveur. Garde-fous : HTTPS obligatoire, pas d'identifiants ni de port exotique dans l'URL, résolution DNS **à chaque envoi** et refus des adresses privées, de bouclage, link-local et métadonnées cloud, redirections refusées. Shopify n'accepte qu'un domaine `*.myshopify.com`. Limite connue : une attaque par _DNS rebinding_ entre la résolution et la connexion reste théorique ; à fermer en V2 avec un agent HTTP qui épingle l'adresse résolue.

### 3. Correspondance des champs (modèle pivot → boutique)

| Pivot            | Shopify (GraphQL `2025-10`)                    | WooCommerce (REST `wc/v3`)            |
| ---------------- | ---------------------------------------------- | ------------------------------------- |
| `sku`            | `variant.inventoryItem.sku` (clé d'upsert)     | `sku` (clé d'upsert)                  |
| `product_name`   | `title`                                        | `name`                                |
| `description`    | `descriptionHtml` (texte échappé)              | `description` (texte échappé)         |
| `sale_price`     | `variant.price`                                | `regular_price`                       |
| `stock_quantity` | quantité `available` à l'emplacement principal | `manage_stock` + `stock_quantity`     |
| `brand`          | `vendor`                                       | méta `catamotive_brand`               |
| `category`       | `productType`                                  | — (V2)                                |
| `ean`            | `variant.barcode`                              | `global_unique_id` (WC ≥ 9.2)         |
| `oem_reference`  | métachamp `catamotive.oem_reference`           | méta `oem_reference`                  |
| `image_urls`     | médias, **à la création seulement**            | `images`, **à la création seulement** |

Les images ne sont envoyées qu'à la création : les renvoyer à chaque synchronisation dupliquerait les médias côté boutique.

### 4. Règles de sécurité métier

Les mêmes filtres que l'export fichier s'appliquent (code partagé) : ligne valide, non exclue, SKU + désignation + prix au format décimal, premier SKU gagnant en cas de doublon. S'y ajoutent, vérifiés contre la boutique au démarrage :

- **HT/TTC** : la convention de prix de la source doit correspondre au réglage de la boutique (`shop.taxesIncluded` / `woocommerce_prices_include_tax`). Sinon l'envoi échoue avant toute écriture. Aucune conversion fiscale implicite, comme pour les fichiers.
- **Devise** : une ligne dont la devise diffère de celle de la boutique est refusée.
- **Création = brouillon** : un nouveau produit n'est jamais publié automatiquement. Une mise à jour ne change jamais le statut d'un produit existant.
- **Produits à variantes** : un produit Shopify existant avec plusieurs variantes, ou un SKU qui correspond à une variation WooCommerce, est **ignoré** avec un motif, jamais écrasé.
- **Mode « prix et stock seulement »** : ne touche ni titre, ni description, ni marque : le contenu retravaillé par le marchand est préservé.

### 5. Exécution : tâche reprenable, compatible Vercel

Un envoi est une ligne `store_syncs` (statut, curseur = dernier numéro de ligne traité, compteurs, 200 premières erreurs). Le moteur traite des lots de 50 lignes depuis le curseur et enregistre curseur + compteurs après chaque lot, sous un `run_id` qui garantit un seul exécutant à la fois (prise de relais si le battement de cœur a plus de 90 s).

- **Pilote Vercel (inline)** : la requête qui crée l'envoi le fait avancer jusqu'à ~4 min, puis la page relance l'avancement tant que l'envoi n'est pas terminé. Si l'onglet est fermé, l'envoi reste « en cours » et reprend au prochain affichage ou au clic sur « Reprendre ».
- **Worker PostgreSQL** (`npm run worker`) : il reprend aussi les envois en attente, sans navigateur.
- **Idempotence** : l'upsert recherche toujours le SKU avant d'écrire. Rejouer un lot après une coupure met à jour ce qui a déjà été créé, sans doublon.

Débit attendu : WooCommerce par lots de 100 (quelques secondes par lot) ; Shopify environ 2 à 4 produits/s avec gestion du coût GraphQL (attente sur `THROTTLED` / 429). Au-delà de ~10 000 lignes Shopify, la V2 passera par les Bulk Operations.

### 6. Modèle de données (migration `0007`)

- `store_connections` : organisation, plateforme, libellé, domaine/URL, secrets chiffrés, aperçu du jeton, devise et convention de prix lues au dernier test, date de dernier test.
- `store_syncs` : organisation, import, connexion, auteur, options (`updateMode`, `dryRun`), statut (`queued`, `running`, `done`, `failed`), curseur, `run_id`, battement de cœur, compteurs (créés, mis à jour, ignorés, en erreur), erreurs (JSONB borné), message d'échec, dates.
- Audit : `store.connected`, `store.disconnected`, `store.sync.started`. Usage : `store_sync` par envoi réel (pas les simulations). Limite horaire : 20 envois par organisation.

### 7. Interfaces

- `GET/POST /api/store-connections`, `POST/DELETE /api/store-connections/:id` (test, suppression).
- `GET/POST /api/imports/:id/store-syncs` (liste, lancement), `GET/POST /api/store-syncs/:id` (état, avancement).
- Paramètres → « Boutiques connectées ». Page d'export → « Envoyer directement vers une boutique », avec simulation, choix du mode, progression et erreurs.

## Risques et parades

| Risque                                           | Parade V1                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| Écraser un catalogue retravaillé par le marchand | Mode « prix et stock », simulation, statut jamais modifié, variantes ignorées |
| Fuite des jetons boutique                        | AES-256-GCM, clé hors base, jamais renvoyés ni journalisés, admin seulement   |
| Appels serveur vers le réseau interne (SSRF)     | HTTPS, DNS vérifié à chaque envoi, IP privées refusées, pas de redirection    |
| Coupure au milieu d'un gros envoi                | Curseur par lot, upsert idempotent, reprise                                   |
| Changement d'API Shopify                         | Version `2025-10` épinglée, à monter une fois par an                          |
| Erreurs de prix HT/TTC                           | Contrôle bloquant contre le réglage réel de la boutique                       |

## Vérification

- `tests/unit/store-sync.test.ts` : correspondance des champs, chiffrement, garde-fous d'URL et d'IP, réessais HTTP, adaptateurs Shopify et WooCommerce contre un transport simulé (création en brouillon, mise à jour prix et stock, variantes ignorées, limitation de débit, simulation, erreurs par ligne).
- `tests/integration/store-sync.test.ts` (PostgreSQL réel) : refus HT/TTC avant toute écriture, envoi par lots avec pause et reprise, doublon de SKU envoyé une seule fois, ligne en devise étrangère ignorée, envoi concurrent refusé.
- **Non vérifié en V1** : aucun appel contre une vraie boutique. Les requêtes GraphQL et REST suivent la documentation publique, mais doivent être recettées avant mise en production.

## Recette avant production

1. Générer la clé : `openssl rand -base64 32`, la déclarer en `STORE_CREDENTIALS_KEY` (Vercel et worker). La perdre rend les connexions existantes illisibles : il faut alors les recréer.
2. Shopify : créer une boutique de développement (compte Partner, gratuit), une app personnalisée avec `write_products`, `read_locations`, `read_inventory`, `write_inventory`, puis la connecter dans Paramètres.
3. WooCommerce : une instance WordPress publique en HTTPS (WooCommerce ≥ 9.2, permaliens activés), clé REST en lecture/écriture.
4. Pour chaque boutique : simuler, envoyer 3 produits (dont un avec images et stock), vérifier qu'ils sont en brouillon, modifier un prix dans la source, renvoyer en mode « prix et stock » et vérifier que titre et description retouchés sont préservés.
5. Couper la page au milieu d'un envoi de plus de 100 lignes, la rouvrir : l'envoi doit reprendre sans doublon.
