#!/usr/bin/env bash
# Configures the `catamotive` Keycloak realm from scratch (idempotent: the
# realm is deleted and recreated). The resulting realm is then exported to
# infra/keycloak/realm-catamotive.json for docker-compose imports.
#
# What it sets up:
#   - OAuth2 scopes catalog:read / catalog:write / catalog:export
#   - audience `catamotive-api` and a `groups` claim (organization + role)
#   - browser flow with mandatory OTP (MFA) for every interactive login
#   - clients: catamotive-web (code + PKCE), partner-erp-demo,
#     partner-readonly-demo and partner-other-demo (client_credentials),
#     wso2-apim (key manager)
#   - groups /organizations/<organization-id>/{admin,operator,reviewer}
#   - demo users with a password and a pre-registered TOTP device
#
# LAB ONLY: the secrets below are public demo values. Override them with
# environment variables for any shared environment.
set -euo pipefail

KC_URL=${KC_URL:-http://127.0.0.1:8080}
KC_ADMIN=${KC_ADMIN:-admin}
KC_ADMIN_PASSWORD=${KC_ADMIN_PASSWORD:-admin-lab-only}
KCADM=${KCADM:-kcadm.sh}
REALM=catamotive
APP_URL=${APP_URL:-http://127.0.0.1:3000}
WEB_SECRET=${WEB_SECRET:-catamotive-web-secret-lab-only}
ERP_SECRET=${ERP_SECRET:-partner-erp-secret-lab-only}
READONLY_SECRET=${READONLY_SECRET:-partner-readonly-secret-lab-only}
OTHER_SECRET=${OTHER_SECRET:-partner-other-secret-lab-only}
APIM_SECRET=${APIM_SECRET:-wso2-apim-secret-lab-only}
DEMO_PASSWORD=${DEMO_PASSWORD:-Demo-Password-2026!}
# Raw TOTP secret of the demo users (base32 for an authenticator app:
# printf '%s' "$DEMO_TOTP_SECRET" | base32).
DEMO_TOTP_SECRET=${DEMO_TOTP_SECRET:-catamotive-lab-totp-secret}
ORG_DEMO=${ORG_DEMO:-9b2f5c7e-1d3a-4e8b-a6c4-0f1e2d3c4b5a}
ORG_OTHER=${ORG_OTHER:-3c8a1f0e-6b2d-4f7a-9e15-c2d4b6a8e0f1}

kc() { "$KCADM" "$@"; }
id_of() { sed -n 's/.*"id" : "\([^"]*\)".*/\1/p' | head -1; }

kc config credentials --server "$KC_URL" --realm master \
  --user "$KC_ADMIN" --password "$KC_ADMIN_PASSWORD" >/dev/null
kc delete "realms/$REALM" >/dev/null 2>&1 || true

kc create realms -s realm=$REALM -s enabled=true -s displayName=CataMotive \
  -s loginWithEmailAllowed=true -s duplicateEmailsAllowed=false \
  -s bruteForceProtected=true -s failureFactor=10 \
  -s 'passwordPolicy=length(12) and notUsername' \
  -s accessTokenLifespan=300 -s ssoSessionIdleTimeout=1800 \
  -s otpPolicyType=totp -s otpPolicyAlgorithm=HmacSHA1 \
  -s otpPolicyDigits=6 -s otpPolicyPeriod=30

# --- Client scopes -----------------------------------------------------------
for scope in catalog:read catalog:write catalog:export; do
  kc create client-scopes -r $REALM -s name=$scope -s protocol=openid-connect \
    -s 'attributes."include.in.token.scope"=true' \
    -s 'attributes."display.on.consent.screen"=false' >/dev/null
done
API_SCOPE=$(kc create client-scopes -r $REALM -s name=catamotive-api \
  -s protocol=openid-connect -s 'attributes."include.in.token.scope"=false' -i)
kc create "client-scopes/$API_SCOPE/protocol-mappers/models" -r $REALM \
  -s name=audience -s protocol=openid-connect \
  -s protocolMapper=oidc-audience-mapper \
  -s 'config."included.custom.audience"=catamotive-api' \
  -s 'config."access.token.claim"=true' -s 'config."id.token.claim"=false' >/dev/null
ORG_SCOPE=$(kc create client-scopes -r $REALM -s name=organizations \
  -s protocol=openid-connect -s 'attributes."include.in.token.scope"=false' -i)
kc create "client-scopes/$ORG_SCOPE/protocol-mappers/models" -r $REALM \
  -s name=groups -s protocol=openid-connect \
  -s protocolMapper=oidc-group-membership-mapper \
  -s 'config."claim.name"=groups' -s 'config."full.path"=true' \
  -s 'config."access.token.claim"=true' -s 'config."id.token.claim"=true' \
  -s 'config."userinfo.token.claim"=true' >/dev/null

scope_id() {
  kc get client-scopes -r $REALM --fields id,name |
    tr -d '\n ' | grep -o "{\"id\":\"[^\"]*\",\"name\":\"$1\"}" |
    sed 's/.*"id":"\([^"]*\)".*/\1/'
}
attach_scopes() { # client-uuid scope...
  local client=$1
  shift
  for scope in "$@"; do
    kc update "clients/$client/default-client-scopes/$(scope_id "$scope")" -r $REALM >/dev/null
  done
}

# --- Clients -----------------------------------------------------------------
WEB=$(kc create clients -r $REALM -s clientId=catamotive-web \
  -s name="CataMotive (application web)" -s publicClient=false \
  -s secret="$WEB_SECRET" -s standardFlowEnabled=true \
  -s directAccessGrantsEnabled=false -s implicitFlowEnabled=false \
  -s "redirectUris=[\"$APP_URL/api/auth/oidc/callback\"]" \
  -s "webOrigins=[\"$APP_URL\"]" \
  -s 'attributes."pkce.code.challenge.method"=S256' \
  -s "attributes.\"post.logout.redirect.uris\"=$APP_URL/connexion" -i)
attach_scopes "$WEB" catamotive-api organizations

ERP=$(kc create clients -r $REALM -s clientId=partner-erp-demo \
  -s name="Partenaire ERP (démo M2M)" -s publicClient=false \
  -s secret="$ERP_SECRET" -s serviceAccountsEnabled=true \
  -s standardFlowEnabled=false -s directAccessGrantsEnabled=false -i)
attach_scopes "$ERP" catamotive-api organizations catalog:read catalog:write catalog:export

RO=$(kc create clients -r $REALM -s clientId=partner-readonly-demo \
  -s name="Partenaire lecture seule (démo)" -s publicClient=false \
  -s secret="$READONLY_SECRET" -s serviceAccountsEnabled=true \
  -s standardFlowEnabled=false -s directAccessGrantsEnabled=false -i)
attach_scopes "$RO" catamotive-api organizations catalog:read

# A partner of another organization: used to prove tenant isolation.
OTHER=$(kc create clients -r $REALM -s clientId=partner-other-demo \
  -s name="Partenaire d'une autre organisation (démo)" -s publicClient=false \
  -s secret="$OTHER_SECRET" -s serviceAccountsEnabled=true \
  -s standardFlowEnabled=false -s directAccessGrantsEnabled=false -i)
attach_scopes "$OTHER" catamotive-api organizations catalog:read catalog:write catalog:export

# Client used by WSO2 API Manager to register its applications (DCR) and
# introspect tokens when Keycloak is configured as its Key Manager.
APIM=$(kc create clients -r $REALM -s clientId=wso2-apim \
  -s name="WSO2 API Manager (key manager)" -s publicClient=false \
  -s secret="$APIM_SECRET" -s serviceAccountsEnabled=true \
  -s standardFlowEnabled=false -s directAccessGrantsEnabled=false -i)
# The WSO2 Keycloak connector requests its token with `scope=default`.
kc create client-scopes -r $REALM -s name=default -s protocol=openid-connect \
  -s 'attributes."include.in.token.scope"=true' >/dev/null
attach_scopes "$APIM" default
REALM_MGMT=$(kc get clients -r $REALM -q clientId=realm-management --fields id | id_of)
APIM_SA=$(kc get "clients/$APIM/service-account-user" -r $REALM --fields id | id_of)
for role in manage-clients view-clients query-clients; do
  kc add-roles -r $REALM --uid "$APIM_SA" --cclientid realm-management --rolename $role >/dev/null
done
: "$REALM_MGMT"

# --- Organizations as groups ---------------------------------------------------
ROOT=$(kc create groups -r $REALM -s name=organizations -i)
declare -A GROUP
for entry in "$ORG_DEMO:Garage Démo" "$ORG_OTHER:Concession Test"; do
  org=${entry%%:*}
  label=${entry#*:}
  ORG_GROUP=$(kc create "groups/$ROOT/children" -r $REALM -s name="$org" \
    -s "attributes.display_name=[\"$label\"]" -i)
  for role in admin operator reviewer; do
    GROUP[$org/$role]=$(kc create "groups/$ORG_GROUP/children" -r $REALM -s name=$role -i)
  done
done

join() { # user-id org role
  kc update "users/$1/groups/${GROUP[$2/$3]}" -r $REALM -s realm=$REALM \
    -s userId="$1" -s groupId="${GROUP[$2/$3]}" -n >/dev/null
}

# Service accounts belong to an organization like any user.
join "$(kc get "clients/$ERP/service-account-user" -r $REALM --fields id | id_of)" "$ORG_DEMO" operator
join "$(kc get "clients/$RO/service-account-user" -r $REALM --fields id | id_of)" "$ORG_DEMO" reviewer
join "$(kc get "clients/$OTHER/service-account-user" -r $REALM --fields id | id_of)" "$ORG_OTHER" operator

# --- Demo users (password + TOTP device), via partial import ----------------
user_json() { # username first last
  cat <<JSON
{"username":"$1","email":"$1@catamotive.test","firstName":"$2","lastName":"$3",
 "enabled":true,"emailVerified":true,
 "credentials":[
  {"type":"password","value":"$DEMO_PASSWORD","temporary":false},
  {"type":"otp","userLabel":"Authenticator démo",
   "secretData":"{\"value\":\"$DEMO_TOTP_SECRET\"}",
   "credentialData":"{\"subType\":\"totp\",\"digits\":6,\"period\":30,\"algorithm\":\"HmacSHA1\",\"counter\":0}"}]}
JSON
}
cat >/tmp/catamotive-users.json <<JSON
{"ifResourceExists":"OVERWRITE","users":[
$(user_json alice.admin Alice Admin),
$(user_json oscar.operator Oscar Opérateur),
$(user_json rita.reviewer Rita Relectrice),
$(user_json victor.other Victor Autre)]}
JSON
kc create partialImport -r $REALM -f /tmp/catamotive-users.json >/dev/null
rm -f /tmp/catamotive-users.json
uid() { kc get users -r $REALM -q username="$1" -q exact=true --fields id | id_of; }
join "$(uid alice.admin)" "$ORG_DEMO" admin
join "$(uid oscar.operator)" "$ORG_DEMO" operator
join "$(uid rita.reviewer)" "$ORG_DEMO" reviewer
join "$(uid victor.other)" "$ORG_OTHER" admin

# --- MFA: OTP mandatory in the browser flow ------------------------------------
kc create authentication/flows/browser/copy -r $REALM -s newName=browser-mfa >/dev/null
# Send the whole execution back (a partial body would reset its priority).
EXEC=$(kc get authentication/flows/browser-mfa/executions -r $REALM |
  tr -d '\n' | grep -o '{[^{}]*"displayName" : "browser-mfa Browser - Conditional OTP"[^{}]*}' |
  sed 's/"requirement" : "CONDITIONAL"/"requirement" : "REQUIRED"/')
kc update authentication/flows/browser-mfa/executions -r $REALM -b "$EXEC" >/dev/null
kc update "realms/$REALM" -s browserFlow=browser-mfa >/dev/null
# New users (not the seeded ones) must enrol a TOTP device at first login.
kc update authentication/required-actions/CONFIGURE_TOTP -r $REALM \
  -s defaultAction=true -s enabled=true >/dev/null

echo "Realm $REALM configuré sur $KC_URL (organisations $ORG_DEMO, $ORG_OTHER)."
