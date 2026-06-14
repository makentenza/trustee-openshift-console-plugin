# coco-openshift-console-plugin — design & roadmap

OpenShift Console dynamic plugin to **create, configure, manage, and observe** confidential
containers and their attestation. Sibling of `osc-openshift-console-plugin`; built on the same OCP 4.21 stack.

Source docs analyzed: *OpenShift sandboxed containers 1.12 — Deploying confidential containers on
bare-metal servers* and *…Deploying Red Hat build of Trustee*.

## 1. Why this plugin

Confidential computing has two halves that today are assembled by hand from CLI/YAML:

| Half | What it does | Primary CR |
| --- | --- | --- |
| **Confidential Containers** | Runs a workload in a hardware TEE (Intel TDX / AMD SEV-SNP / NVIDIA CC) via the `kata-cc` runtime + per-pod `initdata` | `KataConfig` (`kataconfiguration.openshift.io/v1`) |
| **Trustee / Attestation** | Verifies TEE evidence and releases sealed secrets to attested workloads (KBS + AS + RVPS, + NVIDIA NRAS proxy for GPUs) | `TrusteeConfig` (`trustee.confidentialcontainers.org/v1`) → generates `KbsConfig` + ConfigMaps/Secrets |

CoCo **extends OpenShift sandboxed containers**: it is the same Kata/runtime-class world as
`osc-openshift-console-plugin`, plus a TEE (the `kata-cc` runtime) plus attestation. This plugin reuses that model
and adds the confidential + attestation surfaces.

## 2. Architecture

**One image, two `console.flag/model`-gated nav domains.** Each domain renders only where its CRD
is present, so the same artifact fits every topology:

- Workload cluster (`KataConfig`) → **Confidential Containers** only.
- Trusted cluster (`TrusteeConfig`) → **Trustee (Attestation)** only.
- Co-located cluster (both) → both domains.

Running Trustee on a separate trusted cluster (hub-and-spoke) is a best practice but **not
enforced** — the feature-flag design supports both single-cluster and split deployments with no
code change. Flags: `COCO_KATACONFIG`, `COCO_TRUSTEECONFIG`.

**Consistency with `osc-openshift-console-plugin`:** identical stack (React 17 / PF 6.2 / SDK 4.21 /
`react-router-dom-v5-compat` / `ts-loader` / Yarn 4.14.1), file layout (`src/{components,k8s,utils,types}`),
hook style (`useK8sWatchResource` wrappers returning `[data, loaded]`), and styling rules
(`coco-openshift-console-plugin__` prefix, `--pf-t--*` tokens only).

**Attestation CR pivot:** primary attestation object is **`TrusteeConfig`** (the productized,
simplified CR), not the lower-level `KbsConfig`. `KbsConfig` and the generated ConfigMaps/Secrets
are surfaced as advanced / read-through detail. API group is `trustee.confidentialcontainers.org`
(productized), **to be verified against the installed operator** before deep work (see Risks).

## 3. Feature scope

### Confidential Containers domain (gated by `KataConfig`)

| Capability | Create | Configure | Manage | Observe |
| --- | --- | --- | --- | --- |
| Enablement | "Enable CoCo" wizard: NFD + `NodeFeatureRule` → `osc-feature-gates` CM → `KataConfig` | Edit `KataConfig` (`logLevel`, peerPods, checkNodeEligibility) | Decode the install state machine (CoCo doc ch. 8) | **Overview ✅** (CC enabled?, KataConfig state, runtime classes, TEE nodes, workload health) |
| TEE nodes | — | NodeFeatureRule editor | — | Per-node TDX/SNP + GPU-CC readiness from NFD labels |
| initdata | **initdata builder**: form → `initdata.toml` → gzip+base64 annotation; `policy.rego` toggles; `PCR8_HASH` | per-workload templates | — | effective Kata-Agent policy; is `oc exec` blocked? |
| CC workloads | CoCo-aware create (`runtimeClassName: kata-cc` + initdata; LUKS block-volume helper) | convert workload to `kata-cc` | list workloads on `kata-cc*` (deep-link to `osc-openshift-console-plugin` for generic) | per-pod CC status |
| Attestation verify | — | — | — | one-click "Verify attestation" (CDH `…/attestation-status/status`) |
| GPU CoCo (TP) | guided checklist (IOMMU MC → NFD → GPU Operator `ClusterPolicy` → `kata-cc-nvidia-gpu`) | edit ClusterPolicy CC fields | — | GPU-CC node labels & operator health |
| Observe | — | — | — | embedded Prometheus `kata*` metrics; `must-gather` helper; component-log guidance |

### Trustee / Attestation domain (gated by `TrusteeConfig`)

| Capability | Create | Configure | Manage | Observe |
| --- | --- | --- | --- | --- |
| Deployment | **Deploy Trustee wizard** (`profileType`, `kbsServiceType`, HTTPS/token secrets) → `TrusteeConfig` | edit `TrusteeConfig`; switch profile/service type | show generated `<name>-*` CMs/Secrets, `KbsConfig`, Service/Route | **Overview ✅** (profile, service type, HTTPS, token verification, readiness) |
| Policies | — | Rego editors for `-attestation-policy-cpu/-gpu`, `-resource-policy` | versioned edits | which policies set |
| Reference values | add `PCR8_HASH`/measurements | edit `-rvps-reference-values` (`veritas` guidance) | update on platform change | reference-value count |
| Delivered secrets | client secrets, image-signature (`img-sig` + `security-policy` + policy.json builder) | manage `kbsSecretResources` | — | secrets brokered |
| GPU / NRAS (TP) | — | verify remote-verifier (`type="Remote"`, `verifier_url`) | — | NRAS connectivity test; attestation claims |
| Observe | — | — | — | KBS pod/deploy health & logs; attestation-flow visualization |

✅ = shipped in the first slice.

## 4. Roadmap

- **M0 — Foundation ✅** scaffold (sibling of osc-openshift-console-plugin), k8s layer (KataConfig, RuntimeClass,
  TrusteeConfig, KbsConfig, Node, NFD), both feature-flagged nav domains, **Confidential Containers
  Overview** + **Trustee Overview**.
- **M1 — CC read/observe.** Workloads list (confidential), TEE-nodes page, runtime-classes page,
  KataConfig status detail; embedded `kata*` metrics.
- **M2 — CC guided create.** Enable-CoCo wizard, **initdata builder**, CoCo-aware workload create,
  **Verify-attestation** pod action.
- **M3 — Attestation config.** Deploy-Trustee wizard, policy/reference-value editors, delivered
  secrets + image-signature flows, advanced `KbsConfig`.
- **M4 — GPU / NRAS + troubleshooting.** GPU-CoCo checklist, NRAS connectivity/claims,
  attestation-flow visualization, must-gather/log helpers.

Each milestone keeps `yarn lint && yarn build` green; domains are flag-isolated and independently
shippable.

## 5. Risks & open questions

1. **`TrusteeConfig` CRD fidelity** — confirm exact `apiVersion`/fields/status and the generated
   `KbsConfig` group/version against the installed operator before M3.
2. **`KataConfig` reboots** — create/edit flows must warn (mutating it reboots workers).
3. **initdata correctness** — gzip+base64 + `PCR8_HASH` must match what the runtime/RVPS expect;
   validate against a live cluster (browser `CompressionStream` vs. documented fallback).
4. **`osc-openshift-console-plugin` overlap** — keep generic workload browsing in `osc-openshift-console-plugin`; own only CC-specific
   surfaces here, deep-linking across.
5. **RBAC** — NFD/MachineConfig/must-gather need elevated permissions; degrade gracefully.
6. **GPU is Tech Preview** — gate GPU/NRAS UI behind a clear TP label; H100-only.

## Appendix — canonical identifiers

- Runtime classes: `kata`, `kata-cc`, `kata-remote`, `kata-cc-nvidia-gpu` (confidential handlers are
  TEE-specific, e.g. `kata-cc` → handler `kata-tdx`).
- Pod annotation: `io.katacontainers.config.hypervisor.cc_init_data` (gzip+base64 `initdata.toml`).
- Verify endpoint: `http://127.0.0.1:8006/cdh/resource/default/attestation-status/status`.
- TrusteeConfig generates: CMs `<name>-{kbs-config,rvps-reference-values,attestation-policy-cpu,attestation-policy-gpu,resource-policy}`; Secrets `<name>-{kbs-auth,https,attestation-token}`; CR `<name>-kbsconfig`.
- NRAS: `kbs-config` `[attestation_service.verifier_config.nvidia_verifier] type="Remote"`, default `verifier_url https://nras.attestation.nvidia.com/v4/attest`.
- TEE / GPU-CC node labels: `intel.feature.node.kubernetes.io/tdx`, `amd.feature.node.kubernetes.io/snp`, `nvidia.com/cc.mode.state=on`, `nvidia.com/cc.ready.state=true`.
- Feature gate: `osc-feature-gates` ConfigMap (`confidential: "true"`) in `openshift-sandboxed-containers-operator`.
- must-gather: `registry.redhat.io/openshift-sandboxed-containers/osc-must-gather-rhel9:1.12.0`.
