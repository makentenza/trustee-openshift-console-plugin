# AI agent instructions — trustee-openshift-console-plugin

OpenShift Console dynamic plugin for **Trustee attestation** — deploy, manage, and observe the Red
Hat build of Trustee (TrusteeConfig → KBS, attestation/resource policies, reference values, delivered
secrets, GPU attestation). **Confidential containers (the `kata-cc` runtime, TEE nodes, `initdata`,
workloads) are a separate plugin, `coco-openshift-console-plugin`** — do not add Kata / KataConfig /
initdata management here.

This is a **sibling of `osc-openshift-console-plugin` and `coco-openshift-console-plugin`**; match
their stack and conventions exactly. When in doubt about a pattern, read the corresponding file in
those repos.

## Stack (OCP 4.21 — do not bump without reason)

React 17, PatternFly **6.2**, `@openshift-console/dynamic-plugin-sdk` **4.21-latest**,
`react-router-dom-v5-compat` (import `Link`/`useNavigate`/`useParams` from here, **not** `react-router`),
`ts-loader` (not swc), Yarn **4.14.1**. The 4.21 SDK uses the `loadPluginEntry` federation protocol —
required to load in a 4.21 console. Do not upgrade to the 4.22 stack (React 18 / `__load_plugin_entry__`)
unless the target console is 4.22+.

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

## Verify

`yarn install`, then `yarn lint` and `yarn build` must pass. `tsconfig` is `strict` with
`noUnusedLocals` — no unused imports/locals.
