// ---------------------------------------------------------------------------
// Cross-plugin remediation links into the confidential-containers (CoCo) plugin.
//
// Some Trustee remediations point the user at a page the SEPARATE CoCo plugin
// (coco-openshift-console-plugin, shipped by the OSC operator) registers — e.g.
// "rebuild this pod with initdata" → CoCo's create-workload form. On a
// Trustee-only "hub" cluster the CoCo plugin is not installed, so those routes
// 404. We detect CoCo's presence best-effort from its console feature flag and
// degrade the link to plain text when it's absent.
//
// Pure logic only (no React) so it is unit-testable; the component passes the
// flag value in.
// ---------------------------------------------------------------------------

/**
 * The console feature flag the CoCo plugin gates its routes on (fires when the
 * KataConfig CRD exists and the CoCo plugin is loaded). Absent ⇒ no CoCo routes.
 */
export const COCO_KATACONFIG_FLAG = 'COCO_KATACONFIG';

/**
 * Best-effort: are the CoCo plugin's `/confidential-containers/*` routes present?
 *
 * `useFlag` returns `true`/`false` once resolved and `undefined` while pending or
 * when no plugin contributes the flag. We treat only an explicit `true` as
 * present, so links degrade to text on a Trustee-only cluster (flag never `true`)
 * and while the flag is still resolving (avoids briefly offering a 404 link).
 */
export const cocoRoutesPresent = (kataConfigFlag: boolean | undefined): boolean =>
  kataConfigFlag === true;

/**
 * Resolve a cross-plugin remediation target. When the CoCo routes are present we
 * return the href so the UI renders a link; otherwise we return `undefined` and
 * the UI renders the remediation as plain text (no dead link).
 */
export const crossPluginHref = (
  href: string | undefined,
  routesPresent: boolean,
): string | undefined => (routesPresent ? href : undefined);
