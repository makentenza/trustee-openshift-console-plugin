# Confidential Containers & Trustee — OpenShift Console plugin

> [!WARNING]
> **Unofficial and unsupported.** This is a community/personal project — **not** an official Red Hat
> or OpenShift product, and **not** covered by Red Hat support, subscriptions, or any SLA. It is
> provided **as-is** under the Apache-2.0 license. Validate in a
> non-production environment before use, at your own risk.

`coco-openshift-console-plugin` is an OpenShift Console **dynamic plugin** to **create, configure, manage, and
observe** confidential containers and their attestation, end to end:

- **Confidential Containers** — OpenShift sandboxed containers running in a hardware Trusted
  Execution Environment (Intel TDX / AMD SEV-SNP / NVIDIA CC) via the `kata-cc` runtime, plus
  per-pod `initdata` and on-cluster attestation verification.
- **Trustee (Attestation)** — the Red Hat build of Trustee: Key Broker Service, attestation &
  resource policies, reference values, and the secrets delivered to attested workloads.

It is a **sibling of [`osc-openshift-console-plugin`](https://github.com/makentenza/osc-openshift-console-plugin)** and shares its
stack and conventions. Confidential containers *are* sandboxed containers plus confidential
computing, so this plugin extends the same Kata/runtime-class model with TEE and attestation.

## Two feature-flagged domains, one image

Each domain is a console nav section gated by `console.flag/model` on its CRD, so the plugin
adapts to wherever it runs:

| Domain | Nav section | Shown when present |
| --- | --- | --- |
| Confidential Containers | **Confidential Containers** | `KataConfig` (`kataconfiguration.openshift.io/v1`) |
| Trustee / Attestation | **Trustee (Attestation)** | `TrusteeConfig` (`trustee.confidentialcontainers.org/v1`) |

Running Trustee on a separate trusted cluster (hub-and-spoke) is a best practice but **not
required**. Deploy the same image everywhere: a workload cluster shows Confidential Containers,
a trusted cluster shows Trustee, and a co-located cluster shows both.

## Stack

Matches `osc-openshift-console-plugin` (OCP **4.21**): React 17, PatternFly 6.2, `@openshift-console/dynamic-plugin-sdk`
`4.21-latest`, `react-router-dom-v5-compat`, `ts-loader`, Yarn 4.14.1.

## Develop

```bash
yarn install
yarn start          # plugin dev server on :9001
yarn start-console  # OpenShift console in a container (requires `oc login`)
# open http://localhost:9000
```

- `yarn lint` — eslint + stylelint (`--fix`)
- `yarn build` — production bundle
- `yarn i18n` — regenerate `locales/en/plugin__coco-openshift-console-plugin.json`

## Conventions

- i18n namespace `plugin__coco-openshift-console-plugin`; CSS class prefix `coco-openshift-console-plugin__`.
- PatternFly `--pf-t--*` tokens only (no hex/named colors — dark-mode safe).
- Functional components; hooks wrap `useK8sWatchResource`; types extend `K8sResourceCommon`.

See [docs/plan.md](docs/plan.md) for the full design and roadmap.
