# AI agent instructions — trustee-openshift-console-plugin

OpenShift Console dynamic plugin for **Trustee attestation** — deploy, manage, and observe the Red
Hat build of Trustee (TrusteeConfig → KBS, attestation/resource policies, reference values, delivered
secrets, GPU attestation). **Confidential containers (the `kata-cc` runtime, TEE nodes, `initdata`,
workloads) are a separate plugin, `coco-openshift-console-plugin`** — do not add Kata / KataConfig /
initdata management here.

This is a **sibling of `osc-openshift-console-plugin` and `coco-openshift-console-plugin`**; match
their stack and conventions exactly. When in doubt about a pattern, read the corresponding file in
those repos.

## Packaging (two operators total)

Plugins are **operator-delivered** — a plugin's menu never appears without its operator. There are
**two operators total**: the **OSC operator** (`openshift/sandboxed-containers-operator`) ships
**both** osc + coco from one operator (coco is flipped on by the `osc-feature-gates`
`confidential:true` gate — there is **no** "CoCo operator"), and the **Trustee operator** (separate)
ships **this** plugin. Consequence: confidential containers and attestation are **decoupled at the
operator level**, so the attestation service commonly runs on a different cluster (hub-and-spoke).
Do **not** add "install the operator" guidance here — a plugin can't guide installing the operator
that delivers it.

## Stack (OCP 4.22 — do not bump without reason)

React **18**, PatternFly **6.4**, `@openshift-console/dynamic-plugin-sdk` **4.22-latest**,
`react-router` **v7** (import `Link`/`useNavigate`/`useParams` from `react-router` — the v5-compat
shim is gone), `swc-loader` (not ts-loader), Yarn **4.14.1**. The 4.22 SDK uses the
`__load_plugin_entry__` federation protocol — required to load in a 4.22 console. Do not downgrade to
the 4.21 stack (React 17 / `loadPluginEntry`) unless the target console is 4.21.

## Conventions

- i18n namespace **`plugin__trustee-openshift-console-plugin`**; in components `useTranslation('plugin__trustee-openshift-console-plugin')`;
  in `console-extensions.json` use `%plugin__trustee-openshift-console-plugin~Label%`. Run `yarn i18n` after changing strings.
- CSS class prefix **`trustee-openshift-console-plugin__`**. Only PatternFly `--pf-t--*` tokens — **no hex/named colors**
  (stylelint enforces this; it protects dark mode).
- Functional components (`FC`); custom hooks in `src/k8s/hooks.ts` wrap `useK8sWatchResource` and
  return `[data, loaded]`; all resource types extend `K8sResourceCommon` in `src/k8s/types.ts`;
  GVKs/models/constants in `src/k8s/resources.ts`.
- Any component referenced by `$codeRef` in `console-extensions.json` **must** be listed in
  `package.json` → `consolePlugin.exposedModules`. `package.json` `name` must equal `consolePlugin.name`.

## CRD group/version (important — this was the nav 404)

TrusteeConfig and KbsConfig are **`confidentialcontainers.org/v1alpha1`** on-cluster — **not**
`trustee.confidentialcontainers.org/v1` (the productized docs' group). Using the wrong group makes the
`console.flag/model` never match a CRD, so the `/trustee` routes never register → 404. The flag is
`TRUSTEE_TRUSTEECONFIG` on `TrusteeConfig`; **`TrusteeConfig` is the user-facing CR** (the operator
generates `KbsConfig` + ConfigMaps/Secrets from it — surface KbsConfig only as advanced/generated).

## Domain

One `console.flag/model`-gated nav section — **Trustee (Attestation)**. Co-located with CoCo on one
cluster is supported (hub-and-spoke is best practice, **not** required); `ClusterIP` / in-cluster KBS
is the default, `NodePort`/`LoadBalancer` for a separate trusted cluster.

## Cross-plugin ConfigMap contracts (guard operator skew)

Trustee and the OSC-shipped CoCo plugin version independently but exchange two ConfigMaps. Both carry
a `schema` data field = `SHARED_CONFIGMAP_SCHEMA_VERSION` (`src/k8s/resources.ts`, currently `"1"`).
**Write it; tolerate missing/older on read** (treat as `1`) and ignore a newer one you don't
understand — see `isEvidenceSchemaSupported` in `src/utils/evidence.ts`.

- **`<tc>-shared-initdata`** — label `trustee.attestation/shared-initdata=true`; **Trustee writes**
  (Initdata tab), CoCo reads same-cluster. Keys: `schema`, `cc_init_data`, `kbs-url`, `pcr8`,
  `README`.
- **`attestation-evidence-<pod>`** — label `trustee.attestation/evidence=true`; CoCo's sidecar/probe
  writes, **Trustee reads** (Attestation status). Key: `evidence.json` (`EvidenceRecord`).

Keep the label strings and the schema constant in sync with the CoCo repo if you touch either side.

## Verify

`yarn install`, then `yarn lint`, `yarn build`, and `yarn test` must pass. `tsconfig` is `strict`
with `noUnusedLocals` — no unused imports/locals. Put pure logic in `src/utils/*` with `*.spec.ts`
Jest tests (the eslint `strictTypeChecked` config also forbids `!` non-null assertions and
setState-in-effect — derive state instead).
