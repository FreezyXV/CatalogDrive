# Vérification du MVP — 22 septembre 2026

## Résultat

Le parcours métier demandé fonctionne localement de bout en bout avec PostgreSQL et des fichiers réels : inscription, CSV/XLSX, diagnostic, mapping réutilisable, normalisation, catégories qualité, décisions manuelles, export et rapport. Le build production Next.js réussit. L’adaptateur Supabase S3 et la configuration Vercel sont présents, mais leur test contre le projet distant exige les secrets S3 et `DATABASE_URL`, absents des captures et du dépôt.

## Contrôles exécutés

| Contrôle                           | Résultat                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `npm run format:check`             | Formatage Prettier validé                                                     |
| `npm run lint`                     | Aucune erreur ni avertissement ESLint                                         |
| `npm run typecheck`                | TypeScript strict validé                                                      |
| `npm test`                         | **40 tests réussis** sur 7 fichiers                                           |
| `npm run build`                    | Build Next.js 16/Webpack réussi, 21 routes/pages compilées                    |
| `npm run test:e2e`                 | **7 parcours Chrome** : CSV, isolation, refus, mobile, métier complet et XLSX |
| `npm audit --audit-level=moderate` | 0 vulnérabilité après remplacement de la dépendance UUID transitive           |

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

- Les secrets Supabase/Vercel n’ont pas été fournis. La migration et le stockage du projet distant ne peuvent donc pas être vérifiés depuis cette session.
- Le paiement est volontairement absent ; la page Tarifs n’effectue aucun débit.
- Aucune API CMS n’est simulée. Les sorties sont des fichiers d’import validés d’après les schémas publics, à requalifier lorsqu’un CMS modifie son format.
- La vérification email, la récupération de mot de passe et les invitations ne sont pas incluses dans les critères d’acceptation fonctionnels de ce MVP. Elles restent nécessaires avant une ouverture publique sans supervision.
- Le XLSX est chargé en mémoire seulement après un préflight plafonnant le contenu décompressé à 64 Mio. Cette décision contourne un défaut du lecteur streaming ExcelJS sur certains ordres d’entrées ZIP et reste compatible avec la limite d’upload de 5 Mio.
- Vercel exécute le traitement dans la requête, avec `maxDuration=300`. Les volumes supérieurs au MVP doivent passer sur un worker durable.

## Mise en production restante

1. Créer le bucket privé et les clés S3 dans Supabase, puis régler son CORS pour l’origine Vercel.
2. Fournir `DATABASE_URL`, les cinq variables S3, `APP_ORIGIN`, `COOKIE_SECURE=true` et `CRON_SECRET` dans Vercel.
3. Exécuter les migrations sur Supabase.
4. Déployer le dépôt et refaire le scénario CSV/XLSX/export sur l’URL publique.
5. Avant ouverture commerciale : configurer sauvegardes, surveillance, email transactionnel et revue externe de sécurité/accessibilité.
