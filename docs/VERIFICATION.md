# Vérification du pilote — 23 septembre 2026

## Résultat

Le parcours métier demandé fonctionne localement de bout en bout avec PostgreSQL et des fichiers réels : inscription, CSV/XLSX, diagnostic, mapping réutilisable, normalisation, catégories qualité, décisions manuelles, export et rapport. Le pilote est également déployé sur le projet Vercel `catalog-drive`, avec PostgreSQL et Storage Supabase réels. Le domaine de production `https://catalog-drive-ivans-projects-66d9a97b.vercel.app` est accessible publiquement, sur décision du propriétaire.

## Contrôles exécutés

| Contrôle                           | Résultat                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `npm run format:check`             | Formatage Prettier validé                                                         |
| `npm run lint`                     | Aucune erreur ni avertissement ESLint                                             |
| `npm run typecheck`                | TypeScript strict validé                                                          |
| `npm test`                         | **63 tests réussis** sur 11 fichiers                                              |
| `npm run build`                    | Build Next.js 16/Webpack réussi                                                   |
| `npm run test:e2e`                 | **9 parcours Chrome** : CSV, ZIP, isolation, refus, mobile, métier, XLSX et 49 Mo |
| `npm audit --audit-level=moderate` | 0 vulnérabilité après remplacement de la dépendance UUID transitive               |

Le 23 septembre, `npm run check` a de nouveau réussi : lint, typage, 43 tests et build. Les 7 parcours Playwright ont également été relancés après le durcissement du stockage et de l'inscription.

Après l'ajout des ZIP, le formatage, le lint, le typage, les **48 tests**, le build et les **8 parcours Playwright** passent. Le test ZIP du navigateur dépose deux CSV et télécharge l'archive originale à l'octet près. Un test PostgreSQL importe un CSV et un XLSX du même ZIP, vérifie l'isolation et la suppression de l'archive après le dernier import ; un autre vérifie l'annulation complète après une entrée invalide.

Après le relèvement à 50 Mo et l'ajout du transfert multipart, `npm run format:check`, lint, typage, **54 tests**, build et **9 parcours Playwright** passent. Le neuvième parcours dépose un CSV de près de 49 Mo, vérifie son diagnostic et le supprime. Le test multipart sur le vrai bucket Supabase a transféré 48 875 008 octets en dix parties, relu un SHA-256 identique puis supprimé l'objet. Un second essai a transféré 6,1 Mo depuis Chromium à travers le CORS réel, puis vérifié empreinte et suppression. Le PUT simple de 48,9 Mo avait échoué avec HTTP 524, d'où le passage au multipart.

Sur la branche d'essai 200 Mo non activée en production, un import local CSV de **199 040 027 octets / 40 000 lignes** a parcouru diagnostic, mapping, traitement et export avec PostgreSQL local. La base de test mesurait environ 69 Mo à la fin de ce traitement, dont 60 Mo pour la table des lignes traitées ; cette mesure ne garantit pas les catalogues réels. Le test d'intégration vérifie maintenant qu'un upload signé est diagnostiqué et haché en une seule lecture, et qu'un mapping aux options inchangées ne relit pas l'original. D'autres tests vérifient la régulation du flux S3, la purge des versions B2, le nettoyage des multipart expirés, les origines des prévisualisations Vercel et la concurrence des uploads navigateur. Lint, typage, **63 tests**, build et **9 parcours Playwright** passent. Le traitement hébergé de 200 Mo n'est pas encore qualifié ; la limite déployée reste 50 Mo.

Un bucket Backblaze B2 dédié, privé et chiffré a été créé avec une clé limitée à ce bucket. Son CORS S3 est restreint à `https://catalog-drive.vercel.app` pour `GET`, `HEAD` et `PUT`. Un essai multipart séquentiel de 199 Mo a échoué sur la 17e partie après une rupture réseau `EPIPE` et a annulé sa session sans objet orphelin. Le nouvel essai depuis Chromium avec quatre parties simultanées et jusqu'à trois tentatives par partie a transféré **199 000 000 octets en 38 parties**, puis relu un SHA-256 identique et supprimé l'objet. Le bucket ne contenait ensuite aucun objet courant ni multipart inachevé. Les premières suppressions laissaient trois versions cachées, purgées manuellement ; l'adaptateur purge désormais ces versions sur B2. Un nouvel essai réel de 5,4 Mo a vérifié zéro objet, zéro version et zéro marqueur après suppression. Un premier essai de 6,1 Mo avait déjà validé le CORS réel. Un test de l'application locale construite avec `S3_ENDPOINT` B2 a ensuite transféré **199 040 027 octets depuis Chromium**, affiché le diagnostic de **40 000 lignes** et supprimé l'import en **58 secondes**. L'origine locale ajoutée au CORS pour cet essai a été retirée ; vérification finale : zéro objet, version, marqueur et multipart. Aucun fichier utilisateur existant n'a été migré.

## Vérification du pilote hébergé

- Les migrations Drizzle, dont l'ajout de `source_archives` et des références ZIP, ont été appliquées à la base Supabase via le pooler de session ; le bucket `catamotive-private` existe avec `public=false`.
- Le protocole S3 est actif. Une écriture, une lecture et une suppression directes ont réussi avec la paire de clés du projet. Le précontrôle CORS depuis le domaine Vercel autorise `PUT` et `Content-Type`. Le bucket privé `catamotive-uploads` avait initialement une limite serveur de 5 Mio, avec un refus `EntityTooLarge` (HTTP 413) au-delà. Sa limite a été relevée à 50 Mo le 23 septembre et un objet de 48 875 008 octets a été vérifié et supprimé.
- Le preset Vercel a été corrigé de `Other` à `Next.js`. Le build redeployé répond `200` sur `/`, `/inscription`, `/connexion` et `/tarifs` ; `/dashboard` redirige vers la connexion sans session.
- Un compte temporaire a été créé sur le déploiement protégé. Le tableau de bord a répondu `200`, une URL d’upload signée a été émise, le CSV a été transféré directement vers S3, puis l’import et son diagnostic ont répondu `201` et `200`.
- Le téléchargement signé a rendu les octets originaux à l’identique. La suppression de l’import a répondu `200`, l’API a ensuite rendu `404`, et l’objet S3 était absent. La déconnexion a répondu `200` et le tableau de bord a de nouveau redirigé. Le compte et l’organisation de test ont été supprimés de la base.
- Un second parcours hébergé a vérifié le mapping suggéré, son enregistrement comme modèle, le traitement et l’export générique. Le catalogue signé contenait les deux références valides et excluait la ligne au prix invalide ; le rapport signé mentionnait cette ligne refusée.
- Un vrai XLSX à plusieurs feuilles a été transféré par URL signée et analysé en production : feuille `Catalogue`, référence `00123` et formule `=1+1` conservée comme texte. Les deux imports, les quatre objets S3 associés, les modèles et le second compte de test ont été supprimés après vérification.
- Après désactivation de la protection SSO Vercel, `/`, `/inscription`, `/connexion` et `/tarifs` répondent `200` sans authentification Vercel. `/dashboard` redirige vers `/connexion` sans session CataMotive.
- Les deux alias Vercel publics sont autorisés explicitement pour les requêtes de mutation ; en production, un `POST` invalide depuis chaque domaine donne `400` et une origine voisine ou absente donne `403`.
- L'authentification applique une limite supplémentaire par IP de confiance fournie par Vercel : 10 inscriptions ou 60 tentatives de connexion par heure et par réseau. Un test PostgreSQL valide le dépassement ; la protection n'est pas considérée suffisante à elle seule contre des réseaux distribués.
- Sur la version `d8b9ef1` déployée publiquement, un compte temporaire a parcouru inscription, tableau de bord, URL signée vers `catamotive-uploads`, transfert CSV, import, diagnostic, téléchargement identique, suppression et déconnexion. Le compte et l'objet ont été supprimés ; les deux buckets ne contenaient plus d'objet de test lors de la vérification.
- La version `13e04b0` a été poussée sur `main` et la nouvelle route `/api/imports/[id]/archive` répond `401` sans session en production, ce qui confirme son déploiement et sa protection. Un dépôt ZIP complet n'a pas encore été répété sur l'hébergement ; le parcours complet ZIP a été exécuté localement avec PostgreSQL réel.
- La version `742ba9b` a été déployée avec succès sur `catalog-drive.vercel.app` : accueil `200`, nouvelle route multipart `401` sans session. Un compte temporaire a déposé un CSV de **48 875 008 octets** par le navigateur, obtenu le diagnostic sous la limite visible de **50 Mo**, puis supprimé l'import. Le compte et ses données de test ont été retirés ; un comptage de vérification ne trouve plus d'organisation de test.

## Preuves fonctionnelles

- Les octets et l’empreinte SHA-256 de l’original sont conservés et le téléchargement reste identique.
- Un classeur réel à plusieurs feuilles choisit la feuille catalogue, détecte un en-tête après préambule, garde `00123` et affiche `=1+1` sans l’exécuter.
- Plus de dix règles déterministes sont exercées : trim, HTML, espaces, référence proposée, SKU de repli, casse et alias marque, décimal localisé, devise, stock, état, images, EAN, prix négatif/incohérent et champs requis.
- Les transformations possèdent champ, original, résultat, règle/version, date et origine.
- Les doublons exacts et probables sont signalés avec une ligne liée et un score ; aucune fusion n’est automatique.
- Les actions accepter, modifier, conserver, exclure, restaurer et réinitialiser sont persistées avec contrôle de version optimiste.
- L’export n’inclut par défaut que les lignes valides non exclues. Le rapport contient refus, transformations et neutralisations de formules CSV.
- Les profils générique, WooCommerce, PrestaShop et Shopify possèdent des validations spécifiques ; la sélection, le nom et l’ordre des colonnes restent éditables.
- Un modèle fournisseur enregistré apparaît dans la page Modèles et peut remapper un fichier par nom d’en-tête.
- Deux organisations ne peuvent ni lire, télécharger, modifier ni supprimer leurs données respectives. Une relation inter-organisation est aussi refusée par PostgreSQL.
- La vue mobile 390 × 844 ne déborde pas horizontalement ; les tableaux gardent leur propre défilement.
- La suppression d’un import retire original, exports et rapports.
- Un ZIP conserve sa provenance par entrée et l'archive originale jusqu'au retrait du dernier import issu du lot.

## Sécurité et exploitation vérifiées dans le code

- Mots de passe scrypt salés ; jetons de session aléatoires stockés hachés ; cookie HttpOnly/SameSite/Secure configurable ; contrôle Origin et limitation des tentatives.
- Validation Zod des commandes, tailles HTTP et limites de parser ; noms et clés de fichiers contrôlés.
- Préflight XLSX contre chiffrement, macros, liens externes, embeddings, traversée de chemin et expansion excessive.
- Upload direct S3 signé 5 minutes pour les petits fichiers ; au-delà de 5 Mio, parties signées 10 minutes, session liée à l'organisation et à la taille annoncée, vérification des parties et de la taille finale. Téléchargements signés 1 minute après autorisation. Le serveur recalcule taille et SHA-256 avant de persister un upload direct.
- Stockage local hors `public`; secrets dans l’environnement ; `.env*`, fichiers, rapports et sorties de tests ignorés par Git.
- Job PostgreSQL réclamé atomiquement avec verrou consultatif, heartbeat, trois tentatives et écritures par lots.
- Rétention configurable de 7 à 365 jours et tâche Vercel quotidienne protégée par `CRON_SECRET`.

## Limites assumées

- L’inscription est ouverte au public sur décision du propriétaire. La vérification email, la récupération de mot de passe et la limitation d’abus supplémentaire restent à réaliser avant de considérer une exploitation commerciale sans supervision.
- Le paiement est volontairement absent ; la page Tarifs n’effectue aucun débit.
- Aucune API CMS n’est simulée. Les sorties sont des fichiers d’import validés d’après les schémas publics, à requalifier lorsqu’un CMS modifie son format.
- Les invitations d’équipe ne sont pas incluses dans les critères d’acceptation fonctionnels de ce MVP.
- Le XLSX est chargé en mémoire seulement après un préflight plafonnant le contenu décompressé à 64 Mio. Cette décision contourne un défaut du lecteur streaming ExcelJS sur certains ordres d’entrées ZIP ; les fichiers XLSX de 50 Mo proches du plafond ne sont pas tous garantis.
- Vercel exécute le traitement dans la requête, avec `maxDuration=300`. Les volumes supérieurs au MVP doivent passer sur un worker durable.
- Les ZIP sont actuellement limités à 50 Mo compressés, 20 entrées CSV/XLSX, 50 Mo par entrée et 100 Mio décompressés au total. La cible de 1 Gio par fichier n'est pas encore disponible ; voir [COMMERCIALISATION.md](COMMERCIALISATION.md).

## Avant exploitation commerciale

1. Ajouter vérification de l’adresse email et récupération de mot de passe avec un service d’envoi réellement configuré ; valider le domaine d’expédition.
2. Tester la restauration d’une sauvegarde, ajouter alertes et supervision, et effectuer une revue externe sécurité/accessibilité.
3. Exécuter des essais d’import des fichiers WooCommerce, PrestaShop et Shopify dans les versions cibles réelles des CMS. Le parcours hébergé XLSX a été testé jusqu’au diagnostic et le parcours CSV jusqu’à l’export générique.
4. Revoir le traitement asynchrone et la capacité pour les volumes supérieurs aux limites du MVP avant de promettre ces volumes.
5. Surveiller l’inscription publique et fixer la politique d’accès à long terme ; le paiement reste hors périmètre MVP.

Le plan de lancement détaillé et ses dépendances externes se trouvent dans [COMMERCIALISATION.md](COMMERCIALISATION.md). L’accès public actuel est un pilote gratuit et ne constitue pas une qualification commerciale.
