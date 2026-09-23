# CataMotive — état de préparation commerciale

État au 23 septembre 2026 : **pilote public gratuit utilisable, vente en libre-service non prête**. Le parcours du cahier des charges est fonctionnel avec de vrais fichiers, PostgreSQL et Supabase Storage. Les résultats locaux et hébergés sont détaillés dans [VERIFICATION.md](VERIFICATION.md). La page Tarifs affiche des hypothèses ; aucun abonnement n'est activé ni facturé.

## Bloquants avant la vente

| Priorité             | Chantier                                   | Critère de sortie vérifiable                                                                                                                                                                                                                                                                                                               | Dépendance                                                                                                                  |
| -------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| P0                   | Identité et récupération                   | Vérification de propriété de l'email avant accès durable, récupération par jeton à usage unique expirant, changement de mot de passe invalidant les sessions, tests de non-divulgation de compte et de limitation des demandes. Les comptes déjà créés passent aussi par la vérification.                                                  | Domaine, adresse d'expédition et fournisseur d'email transactionnel validés. Aucun des trois n'est disponible actuellement. |
| P0                   | Prévention des abus et quotas              | Limites d'inscription et de connexion par identité et réseau, quotas d'imports/stockage/exports appliqués côté serveur, nettoyage vérifié des uploads signés non finalisés ; alertes en cas de pic. La tâche quotidienne annule les multipart B2 expirés, mais son exécution hébergée et le nettoyage des objets signés jamais importés restent à prouver.                              | Politique commerciale des quotas et accès aux métriques Vercel/Supabase.                                                    |
| P0                   | Durabilité et exploitation                 | Restauration testée d'une sauvegarde PostgreSQL **et** des objets source/export, surveillance des erreurs et des tâches planifiées, alerte en cas d'échec, procédure d'incident et de suppression d'un compte. La rétention et le cron existent, mais leur exécution planifiée et une restauration complète n'ont pas encore été prouvées. | Politique de sauvegarde, destination indépendante et canal d'alerte.                                                        |
| P0                   | Exactitude des exports CMS                 | Import de fichiers réels CataMotive dans des installations de test WooCommerce, PrestaShop et Shopify aux versions cibles ; vérification des références, prix HT/TTC, stock, images et variantes ; fixtures de non-régression après chaque évolution de profil.                                                                            | Boutiques de test et exemples de catalogues fournisseurs autorisés.                                                         |
| P0                   | Sécurité, confidentialité et accessibilité | Revue externe de l'isolation multi-organisations, des accès S3 et des principales routes ; tests de charge dans les limites publiées ; contrôle clavier/lecteur d'écran ; documents légaux et politique de confidentialité adaptés à l'entité qui vend le service.                                                                         | Identité légale, contact support et validation juridique.                                                                   |
| P0 si vente en ligne | Paiement et droits d'usage                 | Un abonnement réellement payé, modifié, impayé puis résilié change les droits côté serveur sans perte de données ; webhooks vérifiés/idempotents, factures et remboursement traités. La page Tarifs ne doit promettre que les capacités réellement livrées.                                                                                | Entité commerciale, compte de paiement, choix des offres/quotas et conditions de vente.                                     |

Une vente accompagnée avec facturation manuelle évite l'intégration du paiement au départ, mais ne dispense pas des autres lignes P0 ni d'une offre et de limites explicites.

## Capacités utiles au-delà du MVP

1. **Équipes et agences** : invitations, rôles propriétaire/éditeur/lecture seule, changement d'organisation et révocation des accès. Critère : deux membres collaborent sur un catalogue sans franchir les droits d'une autre organisation.
2. **Traitement asynchrone durable** : worker hébergé, progression et reprise après arrêt ; seulement ensuite relever la limite de 50 Mo / 50 000 lignes. Critère : une tâche interrompue reprend sans doublon ni résultat partiel exposé.
3. **Réconciliation du stockage** : suivre chaque URL d'upload émise et purger les objets non finalisés après expiration. Critère : un upload abandonné ne laisse plus d'objet après la tâche de nettoyage, sans supprimer les sources actives.
4. **Diagnostics métier par fournisseur** : corpus de fichiers réels anonymisés, profils de mapping/règles validés par l'utilisateur et tests de référence. Critère : chaque nouveau fournisseur dispose d'un résultat reproductible et d'un rapport des exceptions.
5. **Connecteurs CMS éventuels** : uniquement après qualification des exports de fichiers et des permissions API des boutiques. Aucune synchronisation automatique n'est promise aujourd'hui.

## Décisions encore nécessaires

- Choisir un domaine maîtrisé, l'adresse d'expédition et un service d'email transactionnel. Sans eux, les parcours email restent désactivés.
- Décider entre vente accompagnée/facturation manuelle et vente en ligne par abonnement ; fixer les quotas et le support de chaque offre.
- Fournir les versions et boutiques de test CMS ainsi que des catalogues représentatifs dont l'utilisation est autorisée.
- Définir l'entité vendeuse, les documents contractuels et le contact d'exploitation.

Ne pas présenter le pilote public actuel comme un service commercial prêt tant que les critères P0 applicables ne sont pas satisfaits et revérifiés sur le domaine définitif.

## Import ZIP et objectif 1 Gio

La comparaison des fournisseurs gratuits pour les dépôts de 50 à 200 Mo se trouve dans [STOCKAGE_GRATUIT.md](STOCKAGE_GRATUIT.md).

Le premier incrément ZIP est disponible dans le code : une archive de **50 Mo compressés maximum** et **20 fichiers CSV/XLSX maximum** produit un import distinct par fichier. Chaque entrée reste limitée à 50 Mo et le total décompressé à 100 Mio. Les chemins dangereux, liens symboliques, entrées chiffrées et formats annexes sont refusés. L'archive originale et les fichiers extraits sont conservés ; une erreur d'entrée annule le lot entier. Les tests d'intégration couvrent l'extraction CSV/XLSX, l'isolation des organisations, l'archive identique et le nettoyage.

La cible demandée est **1 Gio par fichier déposé**, ainsi que **1 Gio maximum par entrée décompressée** d'un ZIP. Elle n'est pas atteinte par cet incrément. Le bucket actuel est plafonné à 50 Mo, Supabase Free plafonne un objet à 50 Mo, l'import initial s'exécute dans une fonction Vercel, ExcelJS charge les classeurs en mémoire, et le traitement métier conserve toutes les lignes dans PostgreSQL. Augmenter une constante de taille exposerait le service à des échecs et à des coûts imprévus.

Jalons nécessaires, chacun avec un test de bout en bout :

1. **Stockage et transfert** : offre de stockage permettant 1 Gio par objet, bucket privé dédié. L'upload S3 multipart signé et la reprise des parties échouées existent pour 50 Mo sur Supabase ; les vérifier sur le fournisseur retenu, puis vérifier 1 Gio transféré avec empreinte SHA-256 identique, annulation et purge des uploads abandonnés. Choix d'offre et coût à valider avant activation.
2. **Ingestion asynchrone** : enregistrer un lot en base avant traitement, worker hébergé avec disque/temporaire et mémoire dimensionnés, états/progression/reprise idempotente. Vérifier un arrêt forcé puis redémarrage sans import double.
3. **Formats à grande échelle** : CSV en flux, XLSX en lecture bornée ou déportée et ZIP avec bornes sur nombre d'entrées, taille de chaque entrée et expansion totale. Vérifier des CSV, XLSX et ZIP réels de 251 Mio puis jusqu'à 1 Gio, plus les archives corrompues et bombes de décompression.
4. **Capacité métier** : quotas d'espace et de lignes, traitement des doublons sans index complet en mémoire, pagination et export en flux, surveillance du temps et des volumes PostgreSQL. Vérifier mapping, rapport qualité et export d'un grand catalogue représentatif, pas seulement son dépôt.

Tant que ces critères ne passent pas dans l'environnement hébergé, l'interface doit continuer d'afficher la limite réellement vérifiée de 50 Mo et la limite métier de 50 000 lignes.
