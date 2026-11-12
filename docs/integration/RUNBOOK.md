# Runbook — lab d'intégration

Deux façons de démarrer l'infrastructure, puis une démonstration en dix minutes et le dépannage des points rencontrés.

> **LAB UNIQUEMENT.** Les mots de passe et secrets de `infra/` (`*-lab-only`, `admin/admin` de WSO2, comptes de démonstration et leur secret TOTP) sont publics. Remplacez-les par des variables d'environnement pour tout environnement partagé.

## Option A — Docker Compose

```sh
echo "127.0.0.1 keycloak" | sudo tee -a /etc/hosts   # même émetteur pour navigateur, app et gateway
docker compose -f infra/docker-compose.integration.yml up -d
```

| Service        | URL                                                     | Identifiants                         |
| -------------- | ------------------------------------------------------- | ------------------------------------ |
| RabbitMQ       | http://127.0.0.1:15672 (AMQP 5672, vhost `catamotive`)  | `catamotive` / `catamotive-lab-only` |
| Keycloak       | http://keycloak:8080/admin (realm `catamotive` importé) | `admin` / `admin-lab-only`           |
| WSO2 Publisher | https://localhost:9443/publisher                        | `admin` / `admin`                    |
| WSO2 Gateway   | https://localhost:8243/catamotive/v1                    | jeton Keycloak                       |

`.env.local` de l'application :

```text
DATABASE_URL=postgresql://catamotive:catamotive-lab-only@127.0.0.1:55439/catamotive
APP_ORIGIN=http://127.0.0.1:3000
STORAGE_DRIVER=local
LOCAL_STORAGE_DIR=.local/uploads
COOKIE_SECURE=false
JOB_DISPATCH=queue
RABBITMQ_URL=amqp://catamotive:catamotive-lab-only@127.0.0.1:5672/catamotive
OIDC_ISSUER=http://keycloak:8080/realms/catamotive
OIDC_CLIENT_ID=catamotive-web
OIDC_CLIENT_SECRET=catamotive-web-secret-lab-only
```

```sh
npm ci && npm run db:migrate && npm run build && npm start   # app + worker d'intégration
AM_URL=https://localhost:9443 KC_ISSUER=http://keycloak:8080/realms/catamotive \
  BACKEND_URL=http://host.docker.internal:3000/api/v1 bash infra/wso2-apim/deploy.sh
```

Cette option n'a pas pu être exécutée dans l'environnement où le lab a été construit (registres d'images bloqués). L'option B est celle qui a été vérifiée.

## Option B — distributions officielles, sans Docker (vérifiée)

Versions : PostgreSQL 16, RabbitMQ 3.12 (apt), Keycloak 26.0.7, WSO2 API Manager 4.5.0, OpenJDK 21, Node 22.

```sh
# RabbitMQ
sudo apt-get install -y rabbitmq-server && sudo rabbitmq-server -detached
sudo rabbitmqctl add_vhost catamotive && sudo rabbitmqctl add_vhost catamotive_test
sudo rabbitmqctl set_permissions -p catamotive guest ".*" ".*" ".*"
sudo rabbitmqctl set_permissions -p catamotive_test guest ".*" ".*" ".*"

# Keycloak (base PostgreSQL `keycloak`)
KC_BOOTSTRAP_ADMIN_USERNAME=admin KC_BOOTSTRAP_ADMIN_PASSWORD=admin-lab-only \
  keycloak-26.0.7/bin/kc.sh start-dev --http-port=8080 --hostname=http://127.0.0.1:8080 \
  --db=postgres --db-url=jdbc:postgresql://127.0.0.1:5432/keycloak --db-username=… --db-password=…
KCADM=keycloak-26.0.7/bin/kcadm.sh bash infra/keycloak/configure-realm.sh

# WSO2 API Manager : copier infra/wso2-apim/deployment.toml dans repository/conf/
# Si RabbitMQ occupe déjà 5672, le broker embarqué de WSO2 ne démarre pas : définir
# `offset=1` dans [server] (ports 9444, 8244, 8281, 5673).
wso2am-4.5.0/bin/api-manager.sh
AM_URL=https://localhost:9444 bash infra/wso2-apim/deploy.sh
```

`.env.local` : comme l'option A, avec `RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672/catamotive` et `OIDC_ISSUER=http://127.0.0.1:8080/realms/catamotive`. `.env.test` ajoute `RABBITMQ_URL=…/catamotive_test` et `OIDC_ISSUER` pour activer les suites RabbitMQ et API réelles.

## Comptes de démonstration

| Compte / client         | Organisation                | Rôle     | Usage                                       |
| ----------------------- | --------------------------- | -------- | ------------------------------------------- |
| `alice.admin`           | Garage Démo `9b2f5c7e…`     | admin    | Navigateur, mot de passe + TOTP             |
| `oscar.operator`        | Garage Démo                 | operator | Navigateur                                  |
| `rita.reviewer`         | Garage Démo                 | reviewer | Navigateur, démontre le 403                 |
| `victor.other`          | Concession Test `3c8a1f0e…` | admin    | Isolation                                   |
| `partner-erp-demo`      | Garage Démo                 | operator | M2M, `catalog:read/write/export`, APIM Gold |
| `partner-readonly-demo` | Garage Démo                 | reviewer | M2M, `catalog:read`, APIM Bronze (5/min)    |
| `partner-other-demo`    | Concession Test             | operator | M2M, non abonné dans APIM                   |

Mot de passe : `Demo-Password-2026!`. TOTP : ajouter dans une application d'authentification la clé `printf '%s' catamotive-lab-totp-secret | base32` (TOTP, SHA1, 6 chiffres, 30 s).

## Démonstration (10 minutes)

1. **SSO + MFA + RBAC** : ouvrir http://127.0.0.1:3000/connexion et cliquer « Se connecter avec le SSO ». Saisir le mot de passe puis l'OTP. L'en-tête affiche le rôle. Avec `rita.reviewer`, un dépôt est refusé (403). Version automatisée : `node --import tsx scripts/verify-sso.ts`.
2. **Contrat** : ouvrir `openapi/catamotive-public-api.v1.yaml` dans le Publisher WSO2 (API `CataMotivePublicAPI`), puis montrer les scopes par ressource et les politiques Bronze et Gold.
3. **Parcours partenaire via la passerelle** : `NODE_TLS_REJECT_UNAUTHORIZED=0 node --import tsx scripts/verify-gateway.ts` (certificat auto-signé du lab). Le script vérifie : 401 sans jeton, 403 pour un client non abonné, 403 pour un scope manquant, dépôt, traitement 202 routé `import.process.text`, import prêt via RabbitMQ, lignes rejetées, export routé `export.generate.prestashop`, téléchargement, puis 429 en Bronze.
4. **Messagerie** : dans la console RabbitMQ (http://127.0.0.1:15672), montrer les exchanges `catamotive.*`, les files quorum et `q.dead-letter`. Lancer `npm run consumer:rejected` : le fichier `.local/rejected-lines/<import>.csv` liste chaque ligne rejetée et son motif.
5. **Résilience** : couper le worker, lancer un traitement (l'outbox se remplit), relancer le worker (relais puis traitement). Couper RabbitMQ pendant un relais : `outbox_messages.attempts` augmente, puis tout repart au retour du broker.

```sh
# Appel manuel
TOKEN=$(curl -s -d grant_type=client_credentials -d client_id=partner-erp-demo \
  -d client_secret=partner-erp-secret-lab-only \
  http://127.0.0.1:8080/realms/catamotive/protocol/openid-connect/token | jq -r .access_token)
curl -k -H "Authorization: Bearer $TOKEN" -H "X-Correlation-ID: demo-1" \
  "https://localhost:8244/catamotive/v1/imports?filename=tarifs.csv" \
  --data-binary @public/demo/fournisseur-demo.csv -H "Content-Type: application/octet-stream"
```

## Tests

```sh
npm test                    # unitaires + intégration PostgreSQL
# + RabbitMQ réel si RABBITMQ_URL est défini dans .env.test
# + API avec jetons Keycloak réels si OIDC_ISSUER est défini dans .env.test
```

| Suite                                    | Prouve                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `tests/unit/openapi-contract.test.ts`    | Contrat valide, chaque route est spécifiée et inversement, scopes identiques |
| `tests/unit/integration-routing.test.ts` | Routage par contenu, échange alternatif, motifs topic, DLQ en mémoire        |
| `tests/unit/rbac.test.ts`                | Matrice des permissions, parsing du claim `groups`                           |
| `tests/integration/messaging.test.ts`    | Outbox transactionnelle, idempotence, DLQ, panne broker, export routé        |
| `tests/integration/rabbitmq.test.ts`     | Topologie réelle, routage, `delivery_limit` réel, pipeline complet           |
| `tests/integration/public-api.test.ts`   | 401, 403 scope, 403 organisation, parcours complet, isolation                |
| `tests/integration/identity.test.ts`     | Provisionnement JIT, synchronisation des rôles, révocation, liaison d'email  |

## Dépannage

| Symptôme                                                                  | Cause / correction                                                                                                               |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| WSO2 : `Could not bind to /0.0.0.0:5672` au démarrage                     | Le broker embarqué de WSO2 veut le port AMQP de RabbitMQ : `offset=1` dans `[server]`, ou des conteneurs séparés.                |
| Backend : 401 « Jeton d'accès requis » derrière la gateway                | La gateway retire `Authorization` par défaut : `[apim.oauth_config] enable_outbound_auth_header = true`, puis redémarrer.        |
| WSO2 : erreur 500 au « map keys » d'une application                       | Le connecteur Keycloak demande `scope=default` : créer ce client scope et l'attacher au client `wso2-apim` (fait par le script). |
| Keycloak : « Invalid username or password » dès l'affichage du formulaire | Exécution de flux modifiée avec un corps partiel : sa priorité a été réinitialisée. Le script renvoie l'exécution complète.      |
| Pas de 429 immédiatement                                                  | Le throttling WSO2 compte de façon asynchrone : le blocage arrive après quelques requêtes au-delà du quota.                      |
| Jeton refusé (`iss` invalide) en Docker                                   | L'émetteur doit être identique partout : `KC_HOSTNAME=http://keycloak:8080` et l'entrée `/etc/hosts`.                            |
| Import resté en `queued`                                                  | Aucun worker en mode `queue` : `npm run worker:queue` (ou `npm start`, qui le lance si `JOB_DISPATCH=queue`).                    |
