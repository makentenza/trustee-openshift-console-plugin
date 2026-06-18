import {
  buildSetupSteps,
  requiredStepsReady,
  type SetupInputs,
  type SetupStep,
  type SetupStepId,
} from './setupChecklist';

const base: SetupInputs = {
  operatorReady: true,
  tcCreated: false,
  kbsReady: false,
  refValuesSet: false,
  routeAdmitted: false,
};

const step = (steps: SetupStep[], id: SetupStepId): SetupStep => {
  const s = steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

describe('buildSetupSteps', () => {
  it('returns the canonical ordered sequence', () => {
    expect(buildSetupSteps(base).map((s) => s.id)).toEqual([
      'operator',
      'trusteeconfig',
      'kbs',
      'reference-values',
      'policies',
      'secrets',
      'gpu',
      'route',
      'verify',
    ]);
  });

  it('flags the operator step for attention when the operator is absent', () => {
    expect(step(buildSetupSteps({ ...base, operatorReady: false }), 'operator').state).toBe(
      'attention',
    );
    expect(step(buildSetupSteps(base), 'operator').state).toBe('ok');
  });

  it('keeps automatic + required steps as todo until a TrusteeConfig exists', () => {
    const steps = buildSetupSteps(base);
    expect(step(steps, 'trusteeconfig').state).toBe('todo');
    expect(step(steps, 'kbs').state).toBe('todo');
    expect(step(steps, 'reference-values').state).toBe('todo');
  });

  it('marks the KBS step pending while the operator reconciles, ok once rolled out', () => {
    const pending = buildSetupSteps({ ...base, tcCreated: true, kbsReady: false });
    expect(step(pending, 'trusteeconfig').state).toBe('ok');
    expect(step(pending, 'kbs').state).toBe('pending');

    const up = buildSetupSteps({ ...base, tcCreated: true, kbsReady: true });
    expect(step(up, 'kbs').state).toBe('ok');
  });

  it('flags reference values for attention once the TC exists but none are set', () => {
    const missing = buildSetupSteps({ ...base, tcCreated: true });
    expect(step(missing, 'reference-values').state).toBe('attention');

    const present = buildSetupSteps({ ...base, tcCreated: true, refValuesSet: true });
    expect(step(present, 'reference-values').state).toBe('ok');
  });

  it('treats a missing hub-and-spoke Route as neutral, ok once admitted', () => {
    expect(step(buildSetupSteps(base), 'route').state).toBe('todo');
    expect(step(buildSetupSteps({ ...base, routeAdmitted: true }), 'route').state).toBe('ok');
  });

  it('marks the optional capability steps optional with a tab to configure them on', () => {
    const steps = buildSetupSteps(base);
    for (const id of ['policies', 'secrets', 'gpu'] as SetupStepId[]) {
      expect(step(steps, id).required).toBe(false);
      expect(step(steps, id).state).toBe('todo');
      expect(step(steps, id).tab).toBeTruthy();
    }
    // reference values are required but still configured on a tab.
    expect(step(steps, 'reference-values').required).toBe(true);
    expect(step(steps, 'reference-values').tab).toBe('reference-values');
  });
});

describe('requiredStepsReady', () => {
  it('is false until operator + TrusteeConfig + KBS + reference values are all satisfied', () => {
    expect(requiredStepsReady(base)).toBe(false);
    expect(requiredStepsReady({ ...base, tcCreated: true, kbsReady: true })).toBe(false);
    expect(
      requiredStepsReady({ ...base, tcCreated: true, kbsReady: true, refValuesSet: true }),
    ).toBe(true);
  });

  it('does not depend on the optional hub-and-spoke Route', () => {
    const ready: SetupInputs = {
      operatorReady: true,
      tcCreated: true,
      kbsReady: true,
      refValuesSet: true,
      routeAdmitted: false,
    };
    expect(requiredStepsReady(ready)).toBe(true);
  });
});
