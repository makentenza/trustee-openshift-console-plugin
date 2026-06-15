# Trustee (Attestation) — OpenShift Console plugin

> [!WARNING]
> **Unofficial and unsupported.** This is a community/personal project — **not** an official Red Hat
> or OpenShift product, and **not** covered by Red Hat support, subscriptions, or any SLA. It is
> provided **as-is** under the Apache-2.0 license. Validate in a
> non-production environment before use, at your own risk.

`trustee-openshift-console-plugin` is an OpenShift Console **dynamic plugin** to **deploy, manage, and
observe the Red Hat build of Trustee** — the confidential containers attestation service. From a
single `TrusteeConfig` the operator stands up the Key Broker Service (KBS) plus its attestation and
resource policies, reference values, and the secrets it delivers to attested workloads.

> **Confidential containers live in a separate plugin.** Enabling the `kata-cc` runtime, labeling
> TEE nodes, building `initdata`, and running confidential workloads is handled by
> **[`coco-openshift-console-plugin`](https://github.com/makentenza/coco-openshift-console-plugin)**.
> This plugin owns the *attestation* side: it exposes the KBS URL the workload side needs, and
> consumes the reference values (PCR8) the workload side produces.

## What it covers

A single **Trustee (Attestation)** admin nav section (gated by `console.flag/model` on `TrusteeConfig`),
organized as **deploy / manage / observe**:

- **Deploy** — a `TrusteeConfig` wizard: Permissive (dev/test) or Restricted (production) profile,
  KBS service type (ClusterIP / NodePort / LoadBalancer), and HTTPS / attestation-token TLS secrets.
  It detects an already-deployed Trustee and surfaces the out-of-cluster prerequisites (HTTPS cert,
  the `veritas` tool for reference values, image-signing keys, Intel PCCS key, NVIDIA NRAS).
- **Manage** — `TrusteeConfig` resource tabs: **Policies** (resource + attestation policies),
  **Reference values** (RVPS), **Delivered secrets**, and **GPU attestation** (the NVIDIA NRAS remote
  verifier).
- **Observe** — a Trustee **overview**, and a per-pod **attestation verify** page plus a *Verify
  attestation* action on confidential (`kata-cc`) pods.

### CRD group/version

Targets the Red Hat build of Trustee CRDs as installed on-cluster — **`TrusteeConfig` and `KbsConfig`
at `confidentialcontainers.org/v1alpha1`** (not `trustee.confidentialcontainers.org/v1`). The
high-level `TrusteeConfig` is the resource you create; the operator generates `KbsConfig` and the
config maps / secrets from it.

### Same cluster or separate

Running Trustee on a separate trusted cluster (hub-and-spoke) is a best practice but **not required** —
Trustee and confidential containers can run on the **same cluster**. `ClusterIP` keeps the KBS
in-cluster (the co-located default); use `NodePort`/`LoadBalancer` to reach it from a separate
cluster.

## Stack

Matches `coco-openshift-console-plugin` / `osc-openshift-console-plugin` (OCP **4.21**): React 17,
PatternFly 6.2, `@openshift-console/dynamic-plugin-sdk` `4.21-latest`, `react-router-dom-v5-compat`,
`ts-loader`, Yarn 4.14.1.

## Develop

```bash
yarn install
yarn start          # plugin dev server on :9001
yarn start-console  # OpenShift console in a container (requires `oc login`)
# open http://localhost:9000
```

- `yarn lint` — eslint + stylelint (`--fix`)
- `yarn build` — production bundle
- `yarn i18n` — regenerate `locales/en/plugin__trustee-openshift-console-plugin.json`

## Conventions

- i18n namespace `plugin__trustee-openshift-console-plugin`; CSS class prefix `trustee-openshift-console-plugin__`.
- PatternFly `--pf-t--*` tokens only (no hex/named colors — dark-mode safe).
- Functional components; hooks wrap `useK8sWatchResource`; types extend `K8sResourceCommon`.
