# AI agent instructions — coco-openshift-console-plugin

OpenShift Console dynamic plugin for **confidential containers + Trustee attestation**. This is a
**sibling of `osc-openshift-console-plugin`** (at `../osc-openshift-console-plugin`); match its stack and conventions exactly. When in
doubt about a pattern, read the corresponding file in `osc-openshift-console-plugin`.

## Stack (OCP 4.21 — do not bump without reason)

React 17, PatternFly **6.2**, `@openshift-console/dynamic-plugin-sdk` **4.21-latest**,
`react-router-dom-v5-compat` (import `Link`/`useNavigate`/`useParams` from here, **not** `react-router`),
`ts-loader` (not swc), Yarn **4.14.1**. The 4.21 SDK uses the `loadPluginEntry` federation protocol —
required to load in a 4.21 console. Do not upgrade to the 4.22 stack (React 18 / `__load_plugin_entry__`)
unless the target console is 4.22+.

## Conventions

- i18n namespace **`plugin__coco-openshift-console-plugin`**; in components `useTranslation('plugin__coco-openshift-console-plugin')`;
  in `console-extensions.json` use `%plugin__coco-openshift-console-plugin~Label%`. Run `yarn i18n` after changing strings.
- CSS class prefix **`coco-openshift-console-plugin__`**. Only PatternFly `--pf-t--*` tokens — **no hex/named colors**
  (stylelint enforces this; it protects dark mode).
- Functional components (`FC`); custom hooks in `src/k8s/hooks.ts` wrap `useK8sWatchResource` and
  return `[data, loaded]`; all resource types extend `K8sResourceCommon` in `src/k8s/types.ts`;
  GVKs/models/constants in `src/k8s/resources.ts`.
- Any component referenced by `$codeRef` in `console-extensions.json` **must** be listed in
  `package.json` → `consolePlugin.exposedModules`. `package.json` `name` must equal `consolePlugin.name`.

## Domains

Two `console.flag/model`-gated nav sections, one image for every cluster:

- **Confidential Containers** — flag `COCO_KATACONFIG` on `KataConfig` (`kataconfiguration.openshift.io/v1`).
- **Trustee (Attestation)** — flag `COCO_TRUSTEECONFIG` on `TrusteeConfig`
  (`trustee.confidentialcontainers.org/v1`; it generates `KbsConfig` + ConfigMaps/Secrets).

## Verify

`yarn install`, then `yarn lint` and `yarn build` must pass. `tsconfig` is `strict` with
`noUnusedLocals` — no unused imports/locals.

See `docs/plan.md` for scope and roadmap.
