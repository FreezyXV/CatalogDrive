# CataMotive (CatalogDrive)

CataMotive transforme des catalogues fournisseurs hétérogènes (CSV, TSV, TXT délimité, XLS, XLSX, ODS ou ZIP mixtes) en fichiers contrôlés pour WooCommerce, PrestaShop, Shopify ou un format personnalisé. Le parcours complet fonctionne : compte et organisation, import, diagnostic, mapping réutilisable, normalisation déterministe, revue humaine, export et rapport de transformations.

L'application expose aussi une **API publique** pour les ERP, PIM et intégrateurs, une **file de messages** pour les traitements longs, une **connexion SSO avec MFA** et un **contrôle d'accès par rôles**. Elle peut être placée derrière une **passerelle WSO2 API Manager**.

Le produit conserve les données automobiles déclarées comme valeurs brutes. Il ne déduit aucune compatibilité véhicule/pièce et n'intègre aucune donnée TecDoc ou sous licence.

- [Vue d'ensemble](#vue-densemble)
- [Parcours utilisateur](#parcours-utilisateur)
- [Frontend](#frontend)
- [Backend](#backend)
- [Formats et pipeline de normalisation](#formats-et-pipeline-de-normalisation)
- [Base de données](#base-de-données)
- [Authentification et autorisations](#authentification-et-autorisations)
- [API](#api)
- [Traitements asynchrones (RabbitMQ)](#traitements-asynchrones-rabbitmq)
- [Passerelle WSO2 API Manager](#passerelle-wso2-api-manager)
- [Stockage des fichiers](#stockage-des-fichiers)
- [Démarrage local](#démarrage-local)
- [Déploiement Vercel + Supabase](#déploiement-vercel--supabase)
- [Tests et validation](#tests-et-validation)
- [Structure du dépôt](#structure-du-dépôt)
- [Limites connues](#limites-connues)

## Vue d'ensemble

```mermaid
flowchart LR
  subgraph Clients
    U[Navigateur<br/>utilisateur]
    P[ERP / PIM<br/>partenaire]
  end
  KC[Keycloak ou WSO2 IS<br/>OIDC · OAuth2 · MFA]
  GW[WSO2 API Manager<br/>jeton · abonnement · quota]
  subgraph App[CataMotive · Next.js 16]
    UI[Pages React<br/>App Router]
    INT[API interne /api<br/>session cookie]
    V1[API publique /api/v1<br/>Bearer JWT]
    SVC[Services métier<br/>imports · catalog · exports]
  end
  DB[(PostgreSQL<br/>Drizzle ORM)]
  ST[(Stockage<br/>local ou S3)]
  MQ{{RabbitMQ}}
  W[Worker<br/>d'intégration]

  U --> UI --> INT --> SVC
  U -. SSO .-> KC
  P -- jeton --> KC
  P --> GW --> V1 --> SVC
  SVC --> DB
  SVC --> ST
  DB -- outbox --> W
  W <--> MQ
  W --> SVC
```

| Couche          | Technologie                                                      |
| --------------- | ---------------------------------------------------------------- |
| Interface       | Next.js 16 (App Router), React 19, Tailwind CSS 4, lucide-react  |
| Serveur         | Route Handlers Next.js, TypeScript strict, zod                   |
| Données         | PostgreSQL 16/17, Drizzle ORM, migrations SQL versionnées        |
| Fichiers        | Système de fichiers local ou S3 (Supabase Storage, Backblaze B2) |
| Lecture tableur | exceljs (XLSX/ODS en flux), SheetJS (anciens XLS), csv-parse     |
| Messagerie      | RabbitMQ (amqplib), outbox transactionnelle                      |
| Identité        | Sessions cookie + scrypt ; OIDC (jose) avec Keycloak ou WSO2 IS  |
| Passerelle      | WSO2 API Manager 4.5                                             |
| Tests           | Vitest, Playwright                                               |

Les briques d'intégration sont **désactivées par défaut** : sans `OIDC_ISSUER`, ni SSO ni API publique ; sans `JOB_DISPATCH=queue`, les traitements restent synchrones. Le déploiement Vercel fonctionne donc sans broker ni fournisseur d'identité.

## Parcours utilisateur

```mermaid
flowchart LR
  A[Compte +<br/>organisation] --> B[Dépôt du<br/>fichier]
  B --> C[Diagnostic<br/>encodage, séparateur,<br/>feuille, en-tête]
  C --> D[Mapping vers<br/>le modèle pivot]
  D --> E[Normalisation<br/>règles versionnées]
  E --> F[Revue qualité<br/>valide, ambiguë,<br/>invalide, doublon]
  F --> G[Export<br/>CMS ou personnalisé]
  G --> H[Téléchargement<br/>catalogue + rapport]
  D -. modèle fournisseur<br/>réutilisable .-> D
```

1. Créer un compte et une organisation (ou se connecter par SSO).
2. Importer un catalogue : 50 Mo maximum en production Supabase, 200 Mo sur la Preview B2 ; voir [les bornes par format](docs/FORMATS.md).
3. Vérifier encodage, séparateur, feuille, ligne d'en-tête, types et aperçu.
4. Corriger le mapping proposé et, si besoin, l'enregistrer comme modèle fournisseur.
5. Choisir les règles puis lancer le traitement.
6. Examiner les lignes valides, ambiguës, invalides, exclues et les doublons.
7. Accepter une suggestion, modifier une valeur, conserver l'original ou exclure une ligne.
8. Configurer un export générique, WooCommerce, PrestaShop, Shopify ou personnalisé.
9. Télécharger le catalogue et son rapport traçable.

Le fichier [public/demo/fournisseur-demo.csv](public/demo/fournisseur-demo.csv) contient uniquement des données fictives.

## Frontend

Pages rendues côté serveur (React Server Components), avec des composants client pour les formulaires interactifs.

| Route                        | Rôle                                                       |
| ---------------------------- | ---------------------------------------------------------- |
| `/`, `/tarifs`               | Accueil public, formats acceptés, offres                   |
| `/inscription`, `/connexion` | Compte local ; bouton SSO si `OIDC_ISSUER` est défini      |
| `/dashboard`                 | Imports de l'organisation, usage                           |
| `/imports/new`               | Dépôt simple, multipart (> 5 Mio) ou ZIP                   |
| `/imports/[id]`              | Diagnostic et aperçu                                       |
| `/imports/[id]/mapping`      | Mapping des colonnes, règles, modèle fournisseur           |
| `/imports/[id]/quality`      | Revue ligne par ligne ; rafraîchissement auto en mode file |
| `/imports/[id]/export`       | Profil, colonnes, encodage, téléchargement                 |
| `/templates`                 | Modèles de mapping et d'export                             |
| `/settings`                  | Organisation, conservation des données                     |

Composants principaux (`src/components/`) : `upload-form` (dépôt et multipart parallèle), `mapping-form`, `quality-review`, `export-form`, `job-status-poller`, `workspace-shell` (affiche le rôle de l'utilisateur).

## Backend

```mermaid
flowchart TB
  subgraph Entrées
    R1[Route Handlers /api<br/>cookie + contrôle Origin]
    R2[Route Handlers /api/v1<br/>Bearer JWT]
    R3[Worker<br/>RabbitMQ ou polling]
  end
  subgraph Contrôles
    A1[auth/index.ts<br/>sessions]
    A2[auth/oidc.ts<br/>JWT, provisionnement]
    A3[auth/rbac.ts<br/>permissions]
  end
  subgraph Services
    S1[imports.ts<br/>dépôt, diagnostic]
    S2[catalog.ts<br/>mapping, jobs, revue]
    S3[exports.ts<br/>génération en flux]
    S4[integration/*<br/>outbox, routeur, handlers]
  end
  subgraph Domaine pur
    D1[csv.ts · import-formats.ts<br/>lecture des formats]
    D2[normalization.ts<br/>règles]
    D3[exports.ts<br/>profils CMS]
  end
  R1 --> A1 --> A3
  R2 --> A2 --> A3
  A3 --> Services
  R3 --> S4 --> S2 & S3
  S1 --> D1
  S2 --> D2
  S3 --> D3
```

- **Domaine pur** (`src/domain/`) : aucune dépendance à la base ni au réseau, donc testable unitairement. Lecture des formats, règles de normalisation, profils d'export.
- **Services** (`src/server/`) : transactions PostgreSQL, verrouillage des jobs, lots bornés à 1 000 lignes ou 8 Mio, reprise et idempotence.
- **Isolation multi-organisation** : chaque requête est filtrée par `organization_id`, qui vient de la session ou du jeton, jamais du client. Les relations sensibles utilisent des clés étrangères composées.
- **Mode d'exécution** (`JOB_DISPATCH`) : `inline` traite dans la requête HTTP (plafond 300 s) ; `queue` passe par l'outbox et RabbitMQ.

## Formats et pipeline de normalisation

```mermaid
flowchart LR
  F1[CSV · TSV · TXT] --> RD[Lecteur<br/>détection encodage,<br/>séparateur, en-tête]
  F2[XLSX · ODS] --> RD
  F3[XLS binaire] --> RD
  F4[ZIP] -- un import<br/>par entrée --> RD
  RD --> MAP[Mapping<br/>colonne → champ pivot]
  MAP --> PIV[Modèle pivot<br/>20 champs]
  PIV --> NRM[Règles versionnées]
  NRM --> Q{Statut}
  Q --> V[valide]
  Q --> AM[ambiguë]
  Q --> IN[invalide]
  Q --> DU[doublon]
  V & AM --> EX[Profils d'export<br/>Woo · Presta · Shopify ·<br/>générique · personnalisé]
```

- **CSV/TSV/TXT** : UTF-8, UTF-8 BOM, UTF-16LE BOM et Windows-1252 ; virgule, point-virgule ou tabulation ; en-tête automatique ou choisi.
- **XLSX/ODS** : lecture en flux, choix de feuille et d'en-tête, zéros initiaux conservés, formules rendues comme texte. **Anciens XLS** : lecteur dédié, borne de 16 Mio. Contenus actifs et classeurs chiffrés refusés.
- **ZIP** : jusqu'à 20 catalogues, 100 Mio décompressés au total, original conservé.
- **Limites** : 500 000 lignes par feuille ou fichier, 200 colonnes, 64 K caractères par ligne, aperçu de 20 lignes. Détails dans [FORMATS.md](docs/FORMATS.md).
- **Modèle pivot** : référence fournisseur, SKU, référence OEM, EAN, marque, désignation, description, catégorie, prix d'achat et de vente, devise, TVA, stock, état, référence fabricant, informations véhicule brutes, code moteur, années, images.
- **Règles** : références, marques et alias, checksum EAN, décimaux, devises, prix HT/TTC, TVA, stock, nettoyage HTML, état, images, champs requis, doublons exacts et probables.
- **Traçabilité** : valeur brute, résultat, règle et version, date, origine, score, décisions humaines et journal d'audit.
- **Sécurité CSV** : les cellules interprétables comme formules sont neutralisées dans les exports.

## Base de données

PostgreSQL, schéma dans [`src/server/db/schema.ts`](src/server/db/schema.ts), migrations dans [`drizzle/`](drizzle/) (0000 à 0005).

```mermaid
erDiagram
  organizations ||--o{ memberships : "membres"
  users ||--o{ memberships : "appartient"
  users ||--o{ sessions : "ouvre"
  organizations ||--o{ import_jobs : "possède"
  uploaded_files ||--o{ import_jobs : "source"
  source_archives ||--o{ uploaded_files : "ZIP"
  import_jobs ||--o{ processed_rows : "lignes"
  import_jobs ||--o{ export_jobs : "exports"
  import_jobs ||--o{ export_requests : "demandes API"
  organizations ||--o{ mapping_templates : "modèles"
  organizations ||--o{ export_templates : "modèles"
  organizations ||--o{ audit_events : "audit"
  organizations ||--o{ usage_records : "usage"
  organizations ||--o{ outbox_messages : "messages"

  memberships { uuid user_id uuid organization_id text role }
  users { uuid id text email text password_hash text oidc_subject }
  import_jobs { uuid id text status jsonb diagnostic jsonb mapping jsonb counts uuid run_id }
  processed_rows { int source_line jsonb raw jsonb data text status jsonb issues }
  outbox_messages { uuid id text type jsonb payload text status int attempts }
  export_requests { uuid id text profile text status text route uuid export_id }
```

| Table                                         | Contenu                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `users`, `organizations`, `memberships`       | Comptes, organisations, rôle par organisation (`admin`, `operator`, `reviewer`, `revoked`) |
| `sessions`, `account_tokens`, `auth_attempts` | Sessions hachées, jetons de compte, limitation des tentatives                              |
| `uploaded_files`, `source_archives`           | Fichiers source (SHA-256, taille, clé de stockage) et archives ZIP                         |
| `import_jobs`                                 | État de l'import, diagnostic, mapping, règles, compteurs qualité                           |
| `processed_rows`                              | Une ligne par ligne source : brut, normalisé, statut, anomalies                            |
| `mapping_templates`, `export_templates`       | Modèles fournisseurs et d'export réutilisables                                             |
| `export_jobs`, `export_requests`              | Exports produits ; demandes asynchrones de l'API publique                                  |
| `outbox_messages`                             | Messages à publier sur RabbitMQ (outbox transactionnelle)                                  |
| `audit_events`, `usage_records`               | Journal d'audit, mesures d'usage idempotentes                                              |

États d'un import :

```mermaid
stateDiagram-v2
  [*] --> analyzed : dépôt + diagnostic
  analyzed --> mapped : mapping enregistré
  mapped --> queued : lancement
  queued --> processing : worker ou requête
  processing --> ready : succès
  processing --> failed : erreur
  failed --> queued : relance
  ready --> deleting : suppression
```

## Authentification et autorisations

Deux modes coexistent : **compte local** (email + mot de passe scrypt, cookie de session httpOnly, limitation des tentatives) et **SSO OIDC** quand `OIDC_ISSUER` est défini.

```mermaid
sequenceDiagram
  autonumber
  actor U as Navigateur
  participant A as CataMotive
  participant K as Keycloak
  U->>A: GET /api/auth/oidc/login
  A-->>U: redirection + PKCE (S256), state, nonce
  U->>K: mot de passe
  K-->>U: formulaire OTP (MFA obligatoire)
  U->>K: code TOTP
  K-->>U: redirection /api/auth/oidc/callback?code
  U->>A: callback
  A->>K: code + code_verifier
  K-->>A: ID token signé
  A->>A: vérif. signature (JWKS), iss, aud, nonce<br/>provisionnement JIT, rôle depuis "groups"
  A-->>U: cookie de session
```

- **Organisations et rôles** viennent du fournisseur d'identité : groupes `/organizations/<uuid>/<rôle>` dans le claim `groups`. À chaque connexion, l'application synchronise : changement de rôle appliqué et audité, organisation retirée passée en `revoked` avec ses sessions fermées.
- **Un compte SSO** ne peut jamais se connecter par mot de passe ; un compte local n'est rattaché que si l'IdP certifie l'email.
- **RBAC** ([`src/server/auth/rbac.ts`](src/server/auth/rbac.ts)), appliqué à toutes les mutations :

| Action                                    | admin | operator | reviewer |
| ----------------------------------------- | :---: | :------: | :------: |
| Consulter imports, rapports, exports      |   ✓   |    ✓     |    ✓     |
| Revoir une ligne                          |   ✓   |    ✓     |    ✓     |
| Déposer, mapper, lancer, exporter         |   ✓   |    ✓     |          |
| Supprimer un import, gérer l'organisation |   ✓   |          |          |

Les comptes créés avant le RBAC (rôle `owner`) sont traités comme `admin`.

## API

**API interne** (`/api/*`) : utilisée par l'interface, authentifiée par cookie avec contrôle de l'en-tête `Origin` sur les mutations. Elle couvre les comptes, les dépôts (simple, multipart signé), le diagnostic, le mapping, la revue, les exports et la maintenance planifiée.

**API publique v1** (`/api/v1/*`) : conçue **avant** le code dans [`openapi/catamotive-public-api.v1.yaml`](openapi/catamotive-public-api.v1.yaml) (OpenAPI 3.1). Le test `tests/unit/openapi-contract.test.ts` casse le build si une route ou un scope s'écarte du contrat.

| Méthode | Chemin                         | Scope            | Réponse        |
| ------- | ------------------------------ | ---------------- | -------------- |
| GET     | `/health`                      | public           | 200            |
| GET     | `/imports`                     | `catalog:read`   | 200            |
| POST    | `/imports?filename=…`          | `catalog:write`  | 201 + Location |
| GET     | `/imports/{id}`                | `catalog:read`   | 200            |
| PUT     | `/imports/{id}/mapping`        | `catalog:write`  | 200            |
| POST    | `/imports/{id}/processing`     | `catalog:write`  | 202            |
| GET     | `/imports/{id}/rejected-lines` | `catalog:read`   | 200            |
| POST    | `/imports/{id}/exports`        | `catalog:export` | 202            |
| GET     | `/export-requests/{id}`        | `catalog:read`   | 200            |
| GET     | `/exports/{id}/{file\|report}` | `catalog:read`   | 200 ou 302     |

Chaque appel est autorisé deux fois : le **scope OAuth2** limite ce que l'application cliente peut faire, le **rôle** limite ce que le principal peut faire. Erreurs au format Problem Details (RFC 9457), en-tête `X-Correlation-ID` propagé jusqu'aux messages RabbitMQ.

```sh
TOKEN=$(curl -s -d grant_type=client_credentials -d client_id=partner-erp-demo \
  -d client_secret=partner-erp-secret-lab-only \
  http://127.0.0.1:8080/realms/catamotive/protocol/openid-connect/token | jq -r .access_token)
curl -H "Authorization: Bearer $TOKEN" --data-binary @public/demo/fournisseur-demo.csv \
  "http://127.0.0.1:3000/api/v1/imports?filename=fournisseur-demo.csv"
```

## Traitements asynchrones (RabbitMQ)

Avec `JOB_DISPATCH=queue`, la requête ne fait qu'enregistrer la commande ; le travail est fait par le worker.

```mermaid
sequenceDiagram
  autonumber
  participant API as API
  participant DB as PostgreSQL
  participant W as Worker
  participant R as RabbitMQ
  API->>DB: BEGIN · import = queued · INSERT outbox · COMMIT
  API-->>API: 202 Accepted
  W->>DB: lit l'outbox (FOR UPDATE SKIP LOCKED)
  W->>R: publie (routage par contenu) + confirmation
  R->>W: livre q.import.text ou q.import.spreadsheet
  W->>DB: réserve l'import (doublon ignoré), normalise
  W->>DB: outbox : fin de traitement + lignes rejetées
  W->>R: publie les événements
```

```mermaid
flowchart LR
  C{{catamotive.commands}} -- import.process.text --> Q1[q.import.text]
  C -- import.process.spreadsheet --> Q2[q.import.spreadsheet]
  C -- export.generate.woocommerce/prestashop/shopify --> Q3[q.export.cms]
  C -- export.generate.generic/custom --> Q4[q.export.file]
  C -. clé inconnue .-> UN[q.unroutable]
  E{{catamotive.events}} -- import.lines.rejected --> Q5[q.rejected-lines]
  E -- import.processing.* · export.* --> Q6[q.notifications]
  Q1 & Q2 & Q3 & Q4 & Q5 & Q6 -. rejet ou 3 relivraisons .-> DLQ[q.dead-letter]
```

- **Outbox transactionnelle** : l'état et le message sont écrits ensemble, aucun message perdu ni orphelin ; backoff exponentiel si le broker est indisponible.
- **Routeur de contenu** ([`router.ts`](src/server/integration/router.ts)) : les producteurs ne choisissent jamais la file.
- **Files quorum** avec limite de 3 relivraisons, puis DLQ. Erreur métier : import en échec, message acquitté. Message hors contrat (zod) : DLQ immédiate.
- **Consommateurs idempotents** : la livraison est « au moins une fois ».
- `npm run consumer:rejected` montre un consommateur aval qui écrit un fichier de retour fournisseur.

Décisions détaillées : [ARCHITECTURE.md](docs/integration/ARCHITECTURE.md) et [ADR.md](docs/integration/ADR.md).

## Passerelle WSO2 API Manager

```mermaid
flowchart LR
  P[Partenaire] -- client_credentials --> K[Keycloak]
  P -- Bearer --> G[WSO2 Gateway<br/>signature JWKS · abonnement ·<br/>scope · quota]
  G -- jeton transmis --> B["/api/v1<br/>revérifie jeton,<br/>scope, rôle, organisation"]
  G -. 401 · 403 · 429 .-> X[refus]
  G -. JWKS .-> K
```

[`infra/wso2-apim/deploy.sh`](infra/wso2-apim/deploy.sh) configure tout par les API REST de WSO2 : Key Manager Keycloak, politiques `CataMotiveBronze` (5/min) et `CataMotiveGold` (100/min), import de l'API depuis le contrat OpenAPI, déploiement et publication, applications partenaires associées à leurs clients Keycloak. Le realm Keycloak est scripté dans [`infra/keycloak/configure-realm.sh`](infra/keycloak/configure-realm.sh) et exporté dans `realm-catamotive.json`. L'infrastructure du lab est décrite dans [`infra/docker-compose.integration.yml`](infra/docker-compose.integration.yml) ; mise en route : [RUNBOOK.md](docs/integration/RUNBOOK.md).

> Les secrets de `infra/` (`*-lab-only`, `admin/admin`, comptes de démonstration) sont des valeurs publiques de laboratoire.

## Stockage des fichiers

`STORAGE_DRIVER=local` écrit sous `.local/`. `STORAGE_DRIVER=s3` utilise un stockage compatible S3 (Supabase Storage en production, B2 en Preview) :

- fichiers de plus de 5 Mio envoyés en parties de 5 Mio via des URL signées de 10 minutes, quatre en parallèle, 180 s et trois tentatives par partie ;
- taille et empreinte SHA-256 recalculées côté serveur avant de créer l'import ;
- téléchargements par URL signées d'une minute après contrôle de la session et de l'organisation ;
- conservation par organisation appliquée par le cron quotidien `/api/maintenance`.

## Démarrage local

Prérequis : Node 24 LTS recommandé, npm et PostgreSQL 17.

```sh
npm ci
npm run db:local      # bases isolées sur 127.0.0.1:55439, secrets dans .env.local / .env.test
npm run db:migrate
npm run dev           # http://127.0.0.1:3000
```

Pour activer la couche d'intégration en local, ajouter à `.env.local` :

```text
JOB_DISPATCH=queue
RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672/catamotive
OIDC_ISSUER=http://127.0.0.1:8080/realms/catamotive
OIDC_CLIENT_ID=catamotive-web
OIDC_CLIENT_SECRET=catamotive-web-secret-lab-only
```

puis lancer `npm run worker:queue` (ou `npm start`, qui démarre le worker adapté au mode). Arrêt de la base : `npm run db:stop`.

## Déploiement Vercel + Supabase

Le pilote est déployé sur Vercel avec PostgreSQL et Storage Supabase. Son [domaine de production](https://catalog-drive.vercel.app/) est public. Aucun secret n'est commité. Conditions de commercialisation : [docs/COMMERCIALISATION.md](docs/COMMERCIALISATION.md).

1. **Appliquer les migrations avant chaque déploiement** : `npm run db:migrate` avec `DATABASE_URL` pointant vers la base Supabase. Le build Vercel ne les exécute pas. Pour Vercel, utiliser le pooler transactionnel Supabase (port 6543) ; les requêtes préparées sont désactivées automatiquement.
2. Créer deux buckets privés : `catamotive-private` (exports et objets historiques) et `catamotive-uploads` (fichiers source, plafonné à 50 Mo), activer le protocole S3, créer une paire de clés et vérifier multipart, CORS, lecture et suppression.
3. Configurer dans Vercel :

```text
DATABASE_URL=postgresql://...
APP_ORIGIN=https://votre-domaine.vercel.app
APP_ORIGINS=https://autre-alias.vercel.app   # facultatif
COOKIE_SECURE=true
STORAGE_DRIVER=s3
S3_ENDPOINT=https://<projet>.storage.supabase.co/storage/v1/s3
S3_REGION=eu-central-1
S3_BUCKET=catamotive-private
S3_UPLOAD_BUCKET=catamotive-uploads
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
CRON_SECRET=une-valeur-aleatoire-d-au-moins-32-caracteres
```

4. Déployer avec le preset Next.js. Les fonctions sont placées à Francfort (`fra1`).

Le projet Vercel relié au dépôt est `catalog-drive` (équipe `ivans-projects-66d9a97b`).

## Tests et validation

```sh
npm run format:check
npm run lint
npm run typecheck
npm test              # unitaires + intégration PostgreSQL
npm run build
npm run test:e2e      # Playwright
npm run test:restart
npm audit --audit-level=moderate
```

Vitest utilise exclusivement `.env.test` et refuse toute base autre que `catamotive_test`. Les suites RabbitMQ réel et API avec jetons Keycloak réels s'activent si `RABBITMQ_URL` et `OIDC_ISSUER` sont définis dans `.env.test`. Scripts de preuve de bout en bout : `scripts/verify-large-catalog.ts` (500 000 lignes), `scripts/verify-sso.ts` (SSO + MFA + RBAC), `scripts/verify-gateway.ts` (parcours via WSO2). Les contrôles réellement exécutés sont consignés dans [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Structure du dépôt

```text
src/app/                 pages et Route Handlers (App Router)
src/app/api/v1/          API publique (contrat dans openapi/)
src/components/          formulaires et interface responsive
src/domain/              lecture des formats, règles, profils d'export (sans I/O)
src/server/api/          authentification Bearer, Problem Details, représentations
src/server/auth/         sessions, mots de passe, OIDC, RBAC
src/server/integration/  messages, routeur, topologie, outbox, consommateurs
src/server/db/           schéma PostgreSQL / Drizzle
src/server/storage/      adaptateurs local et S3
src/server/catalog.ts    jobs, normalisation, doublons, revue
src/server/exports.ts    génération en flux et rapports
scripts/                 migrations, workers, preuves de bout en bout
drizzle/                 migrations SQL versionnées
openapi/                 contrat OpenAPI 3.1
infra/                   Keycloak, WSO2 API Manager, docker-compose du lab
tests/                   unitaires, intégration, Playwright
docs/                    conception, formats, intégration, vérification
```

Hypothèses, risques et décisions : [docs/CONCEPTION.md](docs/CONCEPTION.md), [docs/integration/ADR.md](docs/integration/ADR.md).

## Limites connues

- Paiement, vérification email, récupération de mot de passe, invitations d'équipe et connexions directes aux CMS ne sont pas intégrés. Les profils CMS produisent un fichier avec précontrôles, sans synchroniser de boutique.
- Plafond de 500 000 lignes ; les limites de dépôt (50 Mo en production, 200 Mo en Preview), de décompression, d'export (50 Mio), de base et de durée restent distinctes.
- Le mode `queue` exige un broker et un worker hébergés ; la production Vercel reste en mode `inline` sans SSO.
- Un utilisateur SSO membre de plusieurs organisations ouvre sa session sur la première (pas de sélecteur).
- L'organisation créée à la première connexion SSO porte un nom provisoire.
- `docker-compose.integration.yml` est validé syntaxiquement ; le lab a été vérifié à partir des distributions officielles (voir [VERIFICATION.md](docs/VERIFICATION.md)).
