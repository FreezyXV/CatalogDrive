# CataMotive

CataMotive transforme des catalogues fournisseurs CSV ou XLSX en fichiers contrôlés pour WooCommerce, PrestaShop, Shopify ou un format personnalisé. Le parcours complet fonctionne : compte et organisation, import, diagnostic, mapping réutilisable, normalisation déterministe, revue humaine, export et rapport de transformations.

Le produit conserve les données automobiles déclarées comme valeurs brutes. Il ne déduit aucune compatibilité véhicule/pièce et n’intègre aucune donnée TecDoc ou sous licence.

## Démarrage local

Prérequis : Node 24 LTS recommandé, npm et PostgreSQL 17.

```sh
npm ci
npm run db:local
npm run db:migrate
npm run dev
```

Ouvrir `http://127.0.0.1:3000`. `db:local` crée deux bases isolées sur `127.0.0.1:55439`, écrit les secrets dans `.env.local` et `.env.test`, et conserve les fichiers sous `.local/`. Pour arrêter la base : `npm run db:stop`.

## Parcours disponible

1. Créer un compte et une organisation.
2. Importer un CSV ou un XLSX de 5 Mio maximum.
3. Vérifier encodage, séparateur, feuille, ligne d’en-tête, types et aperçu.
4. Corriger le mapping proposé et, si nécessaire, l’enregistrer comme modèle fournisseur.
5. Choisir les règles puis lancer le traitement.
6. Examiner les lignes valides, ambiguës, invalides, exclues et les doublons.
7. Accepter une suggestion, modifier une valeur, conserver l’original ou exclure une ligne.
8. Configurer un export générique, WooCommerce, PrestaShop, Shopify ou personnalisé.
9. Télécharger le catalogue et son rapport traçable.

Le fichier [public/demo/fournisseur-demo.csv](public/demo/fournisseur-demo.csv) contient uniquement des données fictives.

## Fonctionnement

- CSV : UTF-8, UTF-8 BOM, UTF-16LE BOM et Windows-1252 ; virgule, point-virgule ou tabulation ; en-tête automatique ou sélectionné.
- XLSX : choix automatique ou manuel de feuille/en-tête, zéros initiaux conservés, formules rendues comme texte, macros/liens externes/classeurs chiffrés et archives suspectes refusés. Le contenu décompressé est borné à 64 Mio.
- Limites : 50 000 lignes par feuille, 200 colonnes, 64 K caractères par ligne et aperçu de 20 lignes.
- Règles versionnées : références, marques/alias, EAN, décimaux, devises, prix, TVA, stock, HTML, état, images, champs requis et doublons exacts/probables.
- Traçabilité : brut, résultat, règle/version, date, origine, score, décisions humaines et audit des actions.
- Isolation : toutes les données métier sont liées à `organization_id`; les relations sensibles emploient des clés étrangères composées et des tests inter-organisations.
- Sécurité CSV : les cellules susceptibles d’être interprétées comme formules sont neutralisées dans les exports dérivés. L’original reste inchangé et est signalé comme tel.
- Traitement : jobs PostgreSQL, verrouillage, lots de 100 lignes, reprise bornée et idempotence des mesures d’usage. Le traitement HTTP du MVP est synchrone et plafonné à 300 secondes ; un worker local est également fourni.

## Déploiement Vercel + Supabase

Le dépôt est configuré pour Vercel et le projet Supabase montré par le propriétaire. Aucun secret n’est commité.

1. Dans Supabase, appliquer `npm run db:migrate` avec `DATABASE_URL` pointant vers la base du projet. Pour Vercel, utiliser de préférence l’URL du pooler Supabase compatible IPv4.
2. Créer un bucket privé `catamotive-private`, activer le protocole S3 et créer une paire de clés S3. Vérifier le précontrôle CORS des requêtes `PUT` directes depuis l’origine Vercel.
3. Configurer dans Vercel :

```text
DATABASE_URL=postgresql://...
APP_ORIGIN=https://votre-domaine.vercel.app
COOKIE_SECURE=true
STORAGE_DRIVER=s3
S3_ENDPOINT=https://fifzvqbrepohffamxyap.storage.supabase.co/storage/v1/s3
S3_REGION=eu-central-1
S3_BUCKET=catamotive-private
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
CRON_SECRET=une-valeur-aleatoire-d-au-moins-32-caracteres
```

4. Déployer avec le preset Next.js. Le cron quotidien de [vercel.json](vercel.json) applique la durée de conservation configurée par organisation.

Le projet Vercel relié à ce dépôt est `catalog-drive` dans l’équipe `ivans-projects-66d9a97b`. Le projet `catalog-drive-gbla` construit un autre dépôt et ne doit pas recevoir les variables de CataMotive. Les variables `NEXT_PUBLIC_SUPABASE_URL` et `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` ne sont pas utilisées par l’application actuelle : elle accède à PostgreSQL côté serveur et à Supabase Storage via l’adaptateur S3.

En production S3, le navigateur reçoit une URL d’upload signée valable 5 minutes. Le serveur relit le fichier, vérifie taille, empreinte et format avant de créer l’import. Les téléchargements utilisent des URL signées d’une minute après contrôle de la session et de l’organisation.

## Commandes de validation

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:restart
npm audit --audit-level=moderate
```

Vitest utilise exclusivement `.env.test` et refuse une base dont le nom n’est pas `catamotive_test`. Playwright démarre le build compilé sur le port 3100 et vérifie les parcours desktop, mobile, CSV, XLSX, isolation, correction et export.

## Structure

```text
src/app/                 pages et Route Handlers App Router
src/components/          formulaires et interface responsive
src/domain/              schéma, règles, CSV et profils d’export
src/server/auth/         comptes, sessions et mots de passe
src/server/db/           schéma PostgreSQL/Drizzle
src/server/storage/      adaptateurs local et S3/Supabase
src/server/catalog.ts    jobs, normalisation, doublons et revue
src/server/exports.ts    génération en flux et rapports
drizzle/                 migrations SQL versionnées
tests/                   tests unitaires, intégration et Playwright
docs/                    conception, risques et preuves de vérification
```

Les hypothèses, risques et décisions d’architecture sont détaillés dans [docs/CONCEPTION.md](docs/CONCEPTION.md). Les contrôles réellement exécutés sont consignés dans [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Limites connues

Le paiement, la vérification email, la récupération de mot de passe, les invitations d’équipe et les connexions API aux CMS ne sont pas intégrés. Les offres tarifaires sont présentées sans débit. Le profil CMS produit un fichier et effectue des précontrôles, sans prétendre synchroniser une boutique externe. Les volumes du MVP restent bornés à 5 Mio/50 000 lignes ; au-delà, il faudra déplacer l’exécution vers un worker hébergé durable.
