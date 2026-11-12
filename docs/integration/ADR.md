# Décisions d'architecture — couche d'intégration

Format court : contexte, décision, alternatives écartées, conséquences.

## ADR-001 — RabbitMQ plutôt que Kafka pour les commandes

**Contexte.** Le besoin est de distribuer des **commandes** de travail (traiter un import, générer un export) à des workers concurrents, avec relivraison, file d'erreurs et routage selon le contenu. Le volume est de quelques milliers de commandes par jour, pas des millions d'événements par seconde.

**Décision.** RabbitMQ (AMQP 0-9-1), avec des exchanges _topic_ et des files _quorum_ répliquées (Raft) qui gèrent `x-delivery-limit`.

**Alternatives.**

- Kafka : c'est un journal d'événements rejouable, partitionné, à très haut débit. Il n'a pas d'acquittement par message, ni de DLQ ou de routage natifs, qu'il faudrait reconstruire. Le choix serait pertinent pour diffuser _toutes_ les lignes normalisées à plusieurs systèmes analytiques, avec relecture de l'historique.
- Jobs PostgreSQL seuls (l'existant) : simple, sans broker, mais sans routage, sans fan-out vers des consommateurs tiers et sans isolation par type de charge.

**Conséquences.** Un composant de plus à opérer. Les événements métier (`import.lines.rejected`, `import.processing.*`) passent aussi par RabbitMQ ; s'ils devaient être rejoués ou conservés longtemps, un pont vers Kafka ou vers des streams RabbitMQ serait à prévoir.

## ADR-002 — Outbox transactionnelle

**Contexte.** Passer l'import à `queued` (PostgreSQL) **et** publier la commande (RabbitMQ) sont deux écritures qui ne peuvent pas être atomiques. Avec une publication directe, un crash peut laisser un import en `queued` sans commande, ou envoyer une commande pour une transaction annulée.

**Décision.** Le message est inséré dans `outbox_messages` **dans la transaction métier**. Un relais le lit (`FOR UPDATE SKIP LOCKED`), le publie avec _publisher confirms_, puis le marque `published`. En cas d'échec, un backoff exponentiel plafonné est appliqué et l'ordre est conservé.

**Alternatives.** CDC (Debezium) sur le WAL PostgreSQL : plus robuste à grande échelle, mais une infrastructure de plus. Transactions XA ou 2PC : non supportées par RabbitMQ.

**Conséquences.** La livraison est au moins une fois, donc les consommateurs doivent être idempotents (voir ADR-006). Ajoute une latence de 0 à 500 ms, l'intervalle de scrutation du relais.

## ADR-003 — Routage par contenu dans le relais, pas chez les producteurs

**Contexte.** Le choix de la file dépend du contenu : famille de format source, cible d'export.

**Décision.** Un composant unique, `routeMessage()`, calcule exchange et clé de routage à partir du message validé. Le relais l'applique. Les producteurs n'écrivent qu'un message métier. Les clés sans destinataire sont capturées par un **échange alternatif** (`q.unroutable`) au lieu d'être perdues silencieusement.

**Alternatives.** Un _headers exchange_ RabbitMQ (routage déclaratif sur les en-têtes) : élégant, mais la règle devient de la configuration du broker, plus difficile à tester. Un routeur intermédiaire dédié (consommer puis republier) : un saut réseau de plus, sans bénéfice ici.

**Conséquences.** Ajouter une cible (par exemple Magento) se fait dans le routeur et la topologie, testés unitairement, sans toucher aux producteurs.

## ADR-004 — Keycloak comme fournisseur d'identité du lab, WSO2 Identity Server possible

**Contexte.** Il faut OIDC, OAuth2 `client_credentials`, MFA, groupes et un connecteur Key Manager pour WSO2 API Manager.

**Décision.** Keycloak 26 : léger à démarrer, configuration scriptable (`kcadm.sh`) et exportable en JSON, connecteur `KeyCloak` livré avec WSO2 APIM 4.5.

**Alternatives.** WSO2 Identity Server 7, également connecteur natif d'APIM : il apporterait l'authentification adaptative par scripts (risque, contexte) et le CIAM B2B (organisations, fédération). Le code applicatif ne dépend que des standards (découverte OIDC, JWKS, claims). Le remplacement ne touche que la configuration et le mapping du claim de groupes.

## ADR-005 — Valider le jeton à la passerelle **et** dans le backend

**Contexte.** La passerelle valide déjà le JWT, l'abonnement et le scope.

**Décision.** La passerelle transmet le jeton (`enable_outbound_auth_header = true`) et le backend le revalide entièrement, puis applique le RBAC. C'est le principe zero trust : le backend ne fait pas confiance au réseau.

**Conséquences.** Un appel direct au backend qui contourne la passerelle n'obtient rien sans jeton valide ; il échappe seulement au throttling, qu'il faudrait imposer par le réseau (backend non exposé). La vérification locale par JWKS en cache coûte quelques millisecondes et aucun appel à l'IdP.

## ADR-006 — Consommateurs idempotents par transition d'état conditionnelle

**Décision.** Chaque consommateur commence par un `UPDATE … WHERE status = 'queued'` (ou `processing` si le message est relivré après la mort d'un consommateur). Sans ligne mise à jour, le message est un doublon : il est acquitté. Les écritures par lots vérifient le `run_id`, ce qui fait perdre la main à un ancien propriétaire.

**Alternative.** Une table de messages déjà traités (`processed_messages`, clé `messageId`) : générique, mais redondante avec l'état métier, qui existe déjà.

## ADR-007 — Mode d'exécution explicite : `inline` par défaut, `queue` en option

**Contexte.** Le pilote public tourne sur Vercel, sans processus durable ni broker.

**Décision.** `JOB_DISPATCH=inline` (défaut) garde le comportement existant. `JOB_DISPATCH=queue` active l'outbox et RabbitMQ. L'interface et l'API fonctionnent dans les deux modes : dans le second, la page qualité se rafraîchit pendant le traitement asynchrone.

**Conséquences.** Aucun changement en production tant que la variable n'est pas définie. Le passage en `queue` exige un worker hébergé (conteneur, VM ou Choreo) : c'est la condition déjà notée pour les gros volumes.

## ADR-008 — Organisations et rôles portés par les groupes de l'IdP

**Décision.** Les groupes Keycloak `/organizations/<uuid>/<rôle>` sont exposés dans le claim `groups`. L'IdP est la source de vérité. L'application provisionne juste-à-temps et révoque ce qui n'est plus accordé.

**Alternatives.** Rôles applicatifs gérés uniquement en base : contraire à la centralisation de l'identité attendue en entreprise. Fonction _Organizations_ de Keycloak 26 : à évaluer quand elle exposera aussi les rôles par organisation.

**Conséquences.** Les arrivées, mobilités et départs se gèrent dans l'IdP (ou via SCIM depuis l'annuaire RH), et l'application suit à la connexion suivante.
