#!/usr/bin/env bash
# Publishes the CataMotive public API on WSO2 API Manager 4.5 from its
# OpenAPI contract, with Keycloak as Key Manager and subscription throttling.
# Re-runnable: existing objects are kept, missing ones are created.
#
#   1. admin token (DCR + password grant on the APIM management port)
#   2. Key Manager "Keycloak" (JWT validated locally through JWKS; existing
#      Keycloak clients can be mapped to APIM applications)
#   3. subscription policies CataMotiveBronze (5/min) and CataMotiveGold (100/min)
#   4. API imported from openapi/catamotive-public-api.v1.yaml (scopes per
#      resource come from the contract), /health left public
#   5. revision deployed to the Default gateway, lifecycle -> Published
#   6. applications mapped to existing Keycloak clients:
#      PartnerERP (partner-erp-demo) on CataMotiveGold,
#      PartnerTrial (partner-readonly-demo) on CataMotiveBronze
#
# Prerequisite in repository/conf/deployment.toml (token forwarded to the
# backend, which validates it again):
#   [apim.oauth_config]
#   enable_outbound_auth_header = true
#
# LAB ONLY: admin/admin and the demo secrets are public lab values.
set -euo pipefail
cd "$(dirname "$0")"

AM=${AM_URL:-https://localhost:9444}
AM_USER=${AM_USER:-admin}
AM_PASSWORD=${AM_PASSWORD:-admin}
export KC_ISSUER=${KC_ISSUER:-http://127.0.0.1:8080/realms/catamotive}
export APIM_KM_SECRET=${APIM_KM_SECRET:-wso2-apim-secret-lab-only}
export BACKEND_URL=${BACKEND_URL:-http://127.0.0.1:3000/api/v1}
ERP_SECRET=${ERP_SECRET:-partner-erp-secret-lab-only}
READONLY_SECRET=${READONLY_SECRET:-partner-readonly-secret-lab-only}
SPEC=../../openapi/catamotive-public-api.v1.yaml

expand() { python3 -c 'import os,sys;print(os.path.expandvars(open(sys.argv[1]).read()))' "$1"; }
field() { python3 -c 'import sys,json
d=json.load(sys.stdin)
for k in sys.argv[1].split("."): d=d[int(k)] if isinstance(d,list) else d.get(k) if d else None
print(d if d is not None else "")' "$1"; }
find_in_list() { # json-list-on-stdin key value -> id field of the match
  python3 -c 'import sys,json
items=json.load(sys.stdin).get("list",[])
m=[i for i in items if i.get(sys.argv[1])==sys.argv[2]]
print(m[0].get(sys.argv[3]) if m else "")' "$1" "$2" "$3"; }

echo "1. Jeton d'administration"
REG=$(curl -sfk -u "$AM_USER:$AM_PASSWORD" -H 'Content-Type: application/json' \
  -d '{"callbackUrl":"https://localhost","clientName":"catamotive_lab_cli","owner":"admin","grantType":"password refresh_token","saasApp":true}' \
  "$AM/client-registration/v0.17/register")
CID=$(field clientId <<<"$REG")
CSECRET=$(field clientSecret <<<"$REG")
TOKEN=$(curl -sfk -u "$CID:$CSECRET" \
  -d "grant_type=password&username=$AM_USER&password=$AM_PASSWORD" \
  --data-urlencode "scope=apim:admin apim:api_create apim:api_publish apim:api_view apim:api_manage apim:subscribe apim:app_manage apim:sub_manage apim:tier_manage apim:admin_operations" \
  "$AM/oauth2/token" | field access_token)
H=(-H "Authorization: Bearer $TOKEN")
J=(-H 'Content-Type: application/json')

echo "2. Key Manager Keycloak"
KM=$(curl -sfk "${H[@]}" "$AM/api/am/admin/v4/key-managers" | find_in_list name Keycloak id)
if [ -z "$KM" ]; then
  KM=$(expand key-manager-keycloak.json |
    curl -sfk "${H[@]}" "${J[@]}" -d @- "$AM/api/am/admin/v4/key-managers" | field id)
fi
echo "   id=$KM"

echo "3. Politiques de throttling"
EXISTING=$(curl -sfk "${H[@]}" "$AM/api/am/admin/v4/throttling/policies/subscription")
for policy in CataMotiveBronze CataMotiveGold; do
  if [ -z "$(find_in_list policyName $policy policyId <<<"$EXISTING")" ]; then
    curl -sfk "${H[@]}" "${J[@]}" -d @"policy-$policy.json" \
      "$AM/api/am/admin/v4/throttling/policies/subscription" >/dev/null
    echo "   $policy créée"
  else
    echo "   $policy existe"
  fi
done

echo "4. API depuis le contrat OpenAPI"
PUB=$AM/api/am/publisher/v4
API=$(curl -sfk "${H[@]}" "$PUB/apis?query=name:CataMotivePublicAPI" | find_in_list version v1 id)
if [ -z "$API" ]; then
  API=$(curl -sfk "${H[@]}" -F "file=@$SPEC" \
    -F "additionalProperties=$(expand api-properties.json)" \
    "$PUB/apis/import-openapi" | field id)
  # /health stays public at the gateway, as in the contract (security: []).
  curl -sfk "${H[@]}" "$PUB/apis/$API" | python3 -c 'import sys,json
a=json.load(sys.stdin)
for o in a["operations"]:
    if o["target"]=="/health": o["authType"]="None"
print(json.dumps(a))' | curl -sfk -X PUT "${H[@]}" "${J[@]}" -d @- "$PUB/apis/$API" >/dev/null
  echo "5. Révision, déploiement, publication"
  REV=$(curl -sfk "${H[@]}" "${J[@]}" -d '{"description":"Contrat v1"}' \
    "$PUB/apis/$API/revisions" | field id)
  curl -sfk "${H[@]}" "${J[@]}" \
    -d '[{"name":"Default","vhost":"localhost","displayOnDevportal":true}]' \
    "$PUB/apis/$API/deploy-revision?revisionId=$REV" >/dev/null
  sleep 3
  curl -sfk -X POST "${H[@]}" "$PUB/apis/change-lifecycle?apiId=$API&action=Publish" >/dev/null
else
  echo "   API existante ($API) : publiez une nouvelle révision depuis le Publisher si le contrat a changé."
fi
echo "   id=$API"

echo "6. Applications partenaires et abonnements"
DP=$AM/api/am/devportal/v3
subscribe() { # app-name keycloak-client secret tier description
  local app
  app=$(curl -sfk "${H[@]}" "$DP/applications?query=$1" | find_in_list name "$1" applicationId)
  if [ -z "$app" ]; then
    app=$(curl -sfk "${H[@]}" "${J[@]}" \
      -d "{\"name\":\"$1\",\"throttlingPolicy\":\"Unlimited\",\"description\":\"$5\",\"tokenType\":\"JWT\"}" \
      "$DP/applications" | field applicationId)
    # Map the existing Keycloak client instead of creating new keys.
    curl -sfk "${H[@]}" "${J[@]}" \
      -d "{\"consumerKey\":\"$2\",\"consumerSecret\":\"$3\",\"keyType\":\"PRODUCTION\",\"keyManager\":\"Keycloak\"}" \
      "$DP/applications/$app/map-keys" >/dev/null
    curl -sfk "${H[@]}" "${J[@]}" \
      -d "{\"apiId\":\"$API\",\"applicationId\":\"$app\",\"throttlingPolicy\":\"$4\"}" \
      "$DP/subscriptions" >/dev/null
  fi
  echo "   $1 ($2) -> $4"
}
subscribe PartnerERP partner-erp-demo "$ERP_SECRET" CataMotiveGold \
  "Intégration ERP du Garage Démo"
subscribe PartnerTrial partner-readonly-demo "$READONLY_SECRET" CataMotiveBronze \
  "Partenaire en essai, lecture seule"
# partner-other-demo is deliberately not subscribed: the gateway refuses it.
echo "API disponible sur https://localhost:8244/catamotive/v1 (offset de ports 1)."
