# Paiement Stripe et quotas par offre

Première version : abonnement mensuel par Stripe Checkout, gestion par le portail client Stripe, droits mis à jour par webhook et quotas appliqués côté serveur.

## Offres et quotas

Source unique : [`src/domain/plans.ts`](../src/domain/plans.ts). La page Tarifs, la page Paramètres et les contrôles serveur lisent ce fichier.

| Offre    | Prix HT/mois | Lignes par import | Lignes traitées/mois | Exports/mois | Fichiers conservés | Profils CMS et modèles | Conservation max |
| -------- | ------------ | ----------------- | -------------------- | ------------ | ------------------ | ---------------------- | ---------------- |
| Essai    | 0 €          | 1 000             | 2 000                | 10           | 100 Mo             | non                    | 30 jours         |
| Starter  | 59 €         | 20 000            | 100 000              | 200          | 2 Go               | oui                    | 90 jours         |
| Pro      | 199 €        | 100 000           | 1 000 000            | 2 000        | 20 Go              | oui                    | 365 jours        |
| Business | 499 €        | 500 000           | 5 000 000            | illimité     | 100 Go             | oui                    | 365 jours        |

Ces chiffres sont des **hypothèses de départ** : à valider commercialement avant l'ouverture.

## Où les quotas sont appliqués

| Contrôle                       | Moment                                                                                                                   | Code                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Lignes par import, lignes/mois | Lancement du traitement (interface et API v1), sous verrou par organisation ; les imports en file réservent leurs lignes | `queueImport` → `assertProcessingQuota`                          |
| Exports/mois, profils CMS      | Demande d'export (interface, API v1, worker)                                                                             | `createExport`, `requestExport` → `assertExportQuota`            |
| Modèles enregistrés            | Enregistrement d'un modèle de mapping ou d'export                                                                        | `saveMapping`, `createExport`                                    |
| Stockage                       | Début de dépôt (signé, multipart, direct, API v1) avec la taille déclarée                                                | routes `uploads`, `imports`, `v1/imports` → `assertStorageQuota` |
| Durée de conservation          | Mise à jour de l'organisation ; réduite automatiquement lors d'un passage à une offre inférieure                         | `updateOrganization`, webhook                                    |

Un dépassement répond **402** avec un message qui oriente vers Paramètres > Abonnement. Les compteurs mensuels repartent le 1er du mois (UTC).

**Activation** : les quotas s'appliquent dès que Stripe est configuré (clé + trois prix). Sans Stripe, le pilote reste illimité comme aujourd'hui. `QUOTAS_ENFORCED=true` force les quotas sans Stripe (vente accompagnée), `QUOTAS_ENFORCED=false` les coupe même avec Stripe.

## Droits et statuts d'abonnement

L'offre payante n'est accordée qu'avec un statut `active`, `trialing`, `past_due` (délai de grâce pendant les relances Stripe) ou `manual` (client facturé hors Stripe, positionné à la main en base). `canceled`, `unpaid`, `incomplete`, `incomplete_expired` et `paused` ramènent à Essai, **sans supprimer de données** : l'organisation garde ses imports, seuls les nouveaux traitements sont bornés.

Pour un client facturé manuellement :

```sql
update organizations set plan = 'pro', subscription_status = 'manual' where id = '…';
```

## Webhook

Route : `POST /api/billing/webhook`. Événements à cocher dans Stripe :

- `checkout.session.completed`
- `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`

Garanties : signature vérifiée sur le corps brut ; l'abonnement est **relu chez Stripe** à chaque événement (les livraisons dans le désordre convergent vers l'état réel) ; l'identifiant d'événement est enregistré dans `stripe_events` **dans la même transaction** que la mise à jour (rejeu sans effet) ; un événement tardif sur un ancien abonnement terminé n'écrase pas l'abonnement courant. Toute erreur autre qu'une signature invalide répond 5xx pour que Stripe réessaie.

## Mise en service

1. Dans Stripe (mode test d'abord) : créer trois produits Starter, Pro, Business avec un prix mensuel récurrent en EUR, HT.
2. Activer le **portail client** (Paramètres > Billing > Customer portal) : moyen de paiement, factures, résiliation en fin de période, et changement d'offre entre les trois prix.
3. Créer l'endpoint webhook `https://<domaine>/api/billing/webhook` avec les événements ci-dessus.
4. Variables Vercel (Production et Preview) : `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`, optionnellement `STRIPE_AUTOMATIC_TAX=true` si Stripe Tax est configuré.
5. Appliquer la migration `0007_billing_plans` (workflow `migrate.yml`), puis redéployer : la page Tarifs est statique et lit la configuration au build.
6. Recette en mode test : carte `4242 4242 4242 4242` → offre active ; `stripe trigger customer.subscription.updated` ; carte `4000 0000 0000 0341` pour un impayé ; résiliation depuis le portail ; vérifier chaque fois la page Paramètres et un dépassement de quota.

En local : `stripe listen --forward-to 127.0.0.1:3000/api/billing/webhook` donne le `STRIPE_WEBHOOK_SECRET`.

## Hors périmètre de cette version

- Facturation à l'usage (dépassement payant) et traitement ponctuel 199–999 € : non branchés ; le traitement ponctuel reste sur devis.
- Remboursements et avoirs : depuis le tableau de bord Stripe ; aucun effet automatique sur les droits tant que l'abonnement reste actif.
- Mentions légales, CGV, TVA intracommunautaire et entité vendeuse : prérequis de [COMMERCIALISATION.md](COMMERCIALISATION.md), non traités ici.
- Quota de stockage vérifié sur la taille déclarée au début du dépôt ; les exports générés ne sont pas comptés.
- Le compteur d'exports n'est pas verrouillé : deux exports simultanés au tout dernier crédit peuvent dépasser d'une unité.
