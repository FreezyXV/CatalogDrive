# Vérification du MVP — 22 septembre 2026

## Résultat

Le parcours métier demandé fonctionne localement de bout en bout avec PostgreSQL et des fichiers réels : inscription, CSV/XLSX, diagnostic, mapping réutilisable, normalisation, catégories qualité, décisions manuelles, export et rapport. Le pilote est également déployé sur le projet Vercel `catalog-drive`, avec PostgreSQL et Storage Supabase réels. Le domaine de production `https://catalog-drive-ivans-projects-66d9a97b.vercel.app` est accessible publiquement, sur décision du propriétaire.

## Contrôles exécutés

| Contrôle                           | Résultat                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `npm run format:check`             | Formatage Prettier validé                                                     |
| `npm run lint`                     | Aucune erreur ni avertissement ESLint                                         |
| `npm run typecheck`                | TypeScript strict validé                                                      |
| `npm test`                         | **41 tests réussis** sur 8 fichiers                                           |
| `npm run build`                    | Build Next.js 16/Webpack réussi, 21 routes/pages compilées                    |
| `npm run test:e2e`                 | **7 parcours Chrome** : CSV, isolation, refus, mobile, métier complet et XLSX |
| `npm audit --audit-level=moderate` | 0 vulnérabilité après remplacement de la dépendance UUID transitive           |

Le 22 septembre, `npm run check` a de nouveau réussi : lint, typage, 41 tests et build. Le premier lancement sans autorisation réseau locale a échoué sur `EPERM 127.0.0.1:55439` ; la relance avec accès à la base locale a réussi.

## Vérification du pilote hébergé

- Les deux migrations Drizzle ont été appliquées à la base Supabase via le pooler de session ; le bucket `catamotive-private` existe avec `public=false`.
- Le protocole S3 est actif. Une écriture, une lecture et une suppression directes ont réussi avec la paire de clés du projet. Le précontrôle CORS depuis le domaine Vercel autorise `PUT` et `Content-Type`.
- Le preset Vercel a été corrigé de `Other` à `Next.js`. Le build redeployé répond `200` sur `/`, `/inscription`, `/connexion` et `/tarifs` ; `/dashboard` redirige vers la connexion sans session.
- Un compte temporaire a été créé sur le déploiement protégé. Le tableau de bord a répondu `200`, une URL d’upload signée a été émise, le CSV a été transféré directement vers S3, puis l’import et son diagnostic ont répondu `201` et `200`.
- Le téléchargement signé a rendu les octets originaux à l’identique. La suppression de l’import a répondu `200`, l’API a ensuite rendu `404`, et l’objet S3 était absent. La déconnexion a répondu `200` et le tableau de bord a de nouveau redirigé. Le compte et l’organisation de test ont été supprimés de la base.
- Un second parcours hébergé a vérifié le mapping suggéré, son enregistrement comme modèle, le traitement et l’export générique. Le catalogue signé contenait les deux références valides et excluait la ligne au prix invalide ; le rapport signé mentionnait cette ligne refusée.
- Un vrai XLSX à plusieurs feuilles a été transféré par URL signée et analysé en production : feuille `Catalogue`, référence `00123` et formule `=1+1` conservée comme texte. Les deux imports, les quatre objets S3 associés, les modèles et le second compte de test ont été supprimés après vérification.
- Après désactivation de la protection SSO Vercel, `/`, `/inscription`, `/connexion` et `/tarifs` répondent `200` sans authentification Vercel. `/dashboard` redirige vers `/connexion` sans session CataMotive.
- Les deux alias Vercel publics sont autorisés explicitement pour les requêtes de mutation ; une origine voisine ou absente est refusée par un test dédié.

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

## Sécurité et exploitation vérifiées dans le code

- Mots de passe scrypt salés ; jetons de session aléatoires stockés hachés ; cookie HttpOnly/SameSite/Secure configurable ; contrôle Origin et limitation des tentatives.
- Validation Zod des commandes, tailles HTTP et limites de parser ; noms et clés de fichiers contrôlés.
- Préflight XLSX contre chiffrement, macros, liens externes, embeddings, traversée de chemin et expansion excessive.
- Upload direct S3 signé 5 minutes et téléchargements signés 1 minute après autorisation. Le serveur recalcule taille et SHA-256 avant de persister un upload direct.
- Stockage local hors `public`; secrets dans l’environnement ; `.env*`, fichiers, rapports et sorties de tests ignorés par Git.
- Job PostgreSQL réclamé atomiquement avec verrou consultatif, heartbeat, trois tentatives et écritures par lots.
- Rétention configurable de 7 à 365 jours et tâche Vercel quotidienne protégée par `CRON_SECRET`.

## Limites assumées

- L’inscription est ouverte au public sur décision du propriétaire. La vérification email, la récupération de mot de passe et la limitation d’abus supplémentaire restent à réaliser avant de considérer une exploitation commerciale sans supervision.
- Le paiement est volontairement absent ; la page Tarifs n’effectue aucun débit.
- Aucune API CMS n’est simulée. Les sorties sont des fichiers d’import validés d’après les schémas publics, à requalifier lorsqu’un CMS modifie son format.
- Les invitations d’équipe ne sont pas incluses dans les critères d’acceptation fonctionnels de ce MVP.
- Le XLSX est chargé en mémoire seulement après un préflight plafonnant le contenu décompressé à 64 Mio. Cette décision contourne un défaut du lecteur streaming ExcelJS sur certains ordres d’entrées ZIP et reste compatible avec la limite d’upload de 5 Mio.
- Vercel exécute le traitement dans la requête, avec `maxDuration=300`. Les volumes supérieurs au MVP doivent passer sur un worker durable.

## Avant ouverture publique

1. Ajouter vérification de l’adresse email et récupération de mot de passe avec un service d’envoi réellement configuré ; valider le domaine d’expédition.
2. Tester la restauration d’une sauvegarde, ajouter alertes et supervision, et effectuer une revue externe sécurité/accessibilité.
3. Exécuter des essais d’import des fichiers WooCommerce, PrestaShop et Shopify dans les versions cibles réelles des CMS. Le parcours hébergé XLSX a été testé jusqu’au diagnostic et le parcours CSV jusqu’à l’export générique.
4. Revoir le traitement asynchrone et la capacité pour les volumes supérieurs aux limites du MVP avant de promettre ces volumes.
5. Surveiller l’inscription publique et fixer la politique d’accès à long terme ; le paiement reste hors périmètre MVP.
