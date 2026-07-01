// ---------------------------------------------------------------------------
// Guided Trustee setup checklist. The setup page walks an admin through the full
// sequence to make a Trustee deployment able to attest confidential workloads —
// not just "create the TrusteeConfig". This pure helper derives, from observable
// cluster state, the ordered list of steps with a per-step status and a
// required/optional flag. Text + deep-links live in the component (i18n); the
// ordering and state logic live here so they're unit-testable.
//
// Order mirrors the bare-metal Trustee deployment guide: install the operator,
// create the TrusteeConfig, let the operator deploy the KBS, register reference
// values (required — attestation is denied without them), then the optional
// capabilities (policies, delivered secrets, GPU attestation), expose the KBS for
// hub-and-spoke if workloads live on another cluster, and finally verify.
// ---------------------------------------------------------------------------

/**
 * - `ok`        — done / satisfied (green check)
 * - `pending`   — an automatic step the operator is still reconciling (spinner)
 * - `attention` — a REQUIRED step that is created but still missing something that
 *                 blocks attestation (e.g. no reference values) — needs the admin
 * - `todo`      — not started yet, or an optional capability not configured (neutral)
 */
export type SetupStepState = 'ok' | 'pending' | 'attention' | 'todo';

export type SetupStepId =
  | 'operator'
  | 'trusteeconfig'
  | 'reference-values'
  | 'initdata'
  | 'policies'
  | 'secrets'
  | 'gpu'
  | 'route'
  | 'verify';

export interface SetupStep {
  id: SetupStepId;
  /** Required steps gate attestation; optional steps add capabilities. */
  required: boolean;
  state: SetupStepState;
  /**
   * TrusteeConfig horizontal-nav tab slug this step is configured on, if any. The
   * component turns it into a deep-link once a TrusteeConfig exists.
   */
  tab?: string;
}

export interface SetupInputs {
  /** Trustee operator present (CRDs installed) and/or its controller running. */
  operatorReady: boolean;
  /** At least one TrusteeConfig exists on the cluster. */
  tcCreated: boolean;
  /** The operator has rolled out the KBS deployment (or the TC reports Ready). */
  kbsReady: boolean;
  /** RVPS reference values are registered and non-empty. */
  refValuesSet: boolean;
  /** The initdata measurement (init_data / PCR8) is registered in RVPS reference values. */
  initdataRegistered: boolean;
  /** An external Route to the KBS Service has been admitted (hub-and-spoke). */
  routeAdmitted: boolean;
}

/**
 * Build the ordered setup checklist. Optional/automatic steps only leave `todo`
 * once a TrusteeConfig exists, so the list reads as a genuine sequence rather than
 * lighting everything up at once.
 */
export const buildSetupSteps = (i: SetupInputs): SetupStep[] => {
  const started = i.tcCreated;
  return [
    { id: 'operator', required: true, state: i.operatorReady ? 'ok' : 'attention' },
    // Creating the TrusteeConfig makes the operator deploy the KBS automatically, so we
    // fold KBS rollout into this step rather than showing a separate can't-fail "operator
    // deploys KBS" step (#18): ok once the KBS is up, pending while it rolls out.
    {
      id: 'trusteeconfig',
      required: true,
      state: !i.tcCreated ? 'todo' : i.kbsReady ? 'ok' : 'pending',
    },
    {
      id: 'reference-values',
      required: true,
      state: !started ? 'todo' : i.refValuesSet ? 'ok' : 'attention',
      tab: 'reference-values',
    },
    // Initdata carries the KBS endpoint + Kata Agent policy into each confidential pod
    // and is measured into PCR8; its measurement must be registered as a reference value
    // (init_data) or workloads can't attest to this KBS with a custom config.
    {
      id: 'initdata',
      required: true,
      state: !started ? 'todo' : i.initdataRegistered ? 'ok' : 'todo',
      tab: 'initdata',
    },
    { id: 'policies', required: false, state: 'todo', tab: 'policies' },
    { id: 'secrets', required: false, state: 'todo', tab: 'secrets' },
    { id: 'gpu', required: false, state: 'todo', tab: 'gpu-attestation' },
    // Only meaningful for hub-and-spoke; co-located workloads don't need a Route, so
    // its absence is neutral (todo), never an alarm.
    { id: 'route', required: false, state: i.routeAdmitted ? 'ok' : 'todo' },
    { id: 'verify', required: true, state: 'todo' },
  ];
};

/**
 * True once every required, non-manual step is satisfied — i.e. the deployment can
 * actually attest a workload. Gates the final "verify" action so it isn't offered
 * before reference values exist.
 */
export const requiredStepsReady = (i: SetupInputs): boolean =>
  i.operatorReady && i.tcCreated && i.kbsReady && i.refValuesSet;
