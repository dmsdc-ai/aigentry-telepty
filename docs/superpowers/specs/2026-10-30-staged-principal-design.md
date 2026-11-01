# Staged authenticated-principal transition

The user approved keeping REPORT authority at its original target, staging strict
authentication around authenticated registration, and retaining current foreign
principal trust. This slice makes static preparation inspectable; it never switches
authentication mode or enrolls a client.

Stages are: inventory declared clients and required grants; separately prove key
possession and authenticated registration in isolated fixtures; record compatibility
acceptance for every actual writer; obtain authorization for an operational cutover.
Legacy clients cannot fall through a strict endpoint. Parallel preparation means
separate fixture endpoints, not adding shared-token fallback to strict authentication.

Implement `node scripts/principal-preflight.js --trust /absolute/public-trust.json
--inventory /absolute/client-inventory.json`. Both files use the existing checked
Linux authority-file reader. No private key, session store or environment-selected
default file is read. Bound inventory to 64 KiB, 128 clients and 128 requirements
per client. Reject ambiguous JSON, unknown fields, duplicate clients/requirements,
invalid identifiers/actions, audience mismatch, unsafe paths and unsupported OSes.

Inventory v1 has fields `schema: telepty.strict-client-inventory/v1`, `audience`,
and nonempty `clients`. Each client has `id`, `authentication` (`principal-v1` or
`legacy`), and nonempty `requirements: [{action,target}]`. Principal clients also
require `key_id` and `principal_id`; legacy clients cannot supply identity fields.
Requirements compare only declared exact action/target grants using the existing
principal verifier's wildcard semantics. They do not establish runtime ownership,
operator eligibility, route support, client implementation or complete inventory.

Output only schema, counts, caller-chosen client labels and fixed reason codes.
Always include `mutated:false`, `network_contacted:false`,
`activation_permitted:false`, `authenticated_registration:unverified`,
`inventory_completeness:unverified`, `report_delegation:disabled`, and
`foreign_trust_expansion:disabled`. A static grant match is explicitly distinct
from authentication. Never output key material, signatures, tokens, input paths
or raw invalid input. Exit zero for all declared grant matches, one for valid
inventory blockers, two for invalid/unsafe input. None authorizes cutover.

No live configuration changes, enrollment, external transmission, installations,
restarts or deployment are permitted. Native acceptance and actual fleet coverage
remain separate. Test production reader/parser/grant checks and invoke the actual
script with private files; independent review must check misleading success and
credential disclosure as well as mutation/network refusal.
