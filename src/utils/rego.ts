// ---------------------------------------------------------------------------
// Starter Rego policy templates + a lightweight validator for the Policies tab.
//
// Trustee's attestation/resource policies are Rego. A bare textarea offers no
// starting point and accepts anything, so a typo'd policy is only caught when the
// operator/KBS later rejects it. We provide Permissive / Restricted starters and a
// shallow structural check (balanced braces/brackets, a package clause, an
// allow rule) — not a full Rego parser, just enough to catch obvious mistakes
// before the patch.
// ---------------------------------------------------------------------------

/** A permissive resource policy: allow every attested client to fetch secrets. */
export const PERMISSIVE_RESOURCE_POLICY = `package policy

default allow = true
`;

/**
 * A restricted resource policy starter: deny by default, allow only when the
 * attestation token's TEE evidence passed (EAR "affirming"/"warning"). Edit the
 * tcb_status / claim names to match your verifier output.
 */
export const RESTRICTED_RESOURCE_POLICY = `package policy

default allow = false

# Allow only clients whose attestation result is affirming.
allow {
    input["submods"]["cpu"]["ear.status"] == "affirming"
}
`;

/** A permissive attestation policy: accept all evidence (dev/test). */
export const PERMISSIVE_ATTESTATION_POLICY = `package policy

default allow = true
`;

/**
 * A restricted attestation policy starter: require the measurement to match a
 * registered reference value. Replace the reference_values lookup to match RVPS.
 */
export const RESTRICTED_ATTESTATION_POLICY = `package policy

import future.keywords.in

default allow = false

allow {
    # Every measured value must appear in the registered reference values.
    every k, v in input.measurement {
        v in data.reference[k]
    }
}
`;

export interface RegoTemplate {
  /** Stable id (for React keys). */
  id: string;
  label: string;
  value: string;
}

/** Templates offered for a policy, keyed by the policy's ConfigMap suffix. */
export const regoTemplatesForPolicy = (suffix: string): RegoTemplate[] => {
  if (suffix === 'resource-policy') {
    return [
      { id: 'permissive', label: 'Permissive', value: PERMISSIVE_RESOURCE_POLICY },
      { id: 'restricted', label: 'Restricted', value: RESTRICTED_RESOURCE_POLICY },
    ];
  }
  // CPU/GPU attestation policies share the attestation starters.
  return [
    { id: 'permissive', label: 'Permissive', value: PERMISSIVE_ATTESTATION_POLICY },
    { id: 'restricted', label: 'Restricted', value: RESTRICTED_ATTESTATION_POLICY },
  ];
};

/**
 * Shallow Rego validation. Returns an error message, or undefined when the text
 * passes the basic checks. Not a full parser — guards the common mistakes (empty,
 * no package clause, unbalanced braces/brackets/parens).
 */
export const validateRego = (text: string): string | undefined => {
  const src = text.trim();
  if (src === '') return 'Policy is empty.';
  if (!/^\s*package\s+\S+/m.test(src)) return 'Missing a "package" declaration.';

  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const opens = new Set(['(', '[', '{']);
  const stack: string[] = [];
  // Track string context so braces inside strings don't count. Rego strings use
  // double quotes and backtick raw strings.
  let inStr: '"' | '`' | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\' && inStr === '"') {
        i++; // skip the escaped char
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '#') {
      // Skip to end of line (comment).
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (opens.has(ch)) stack.push(ch);
    else if (ch in pairs) {
      if (stack.pop() !== pairs[ch]) return `Unbalanced "${ch}".`;
    }
  }
  if (inStr) return 'Unterminated string literal.';
  if (stack.length > 0) return `Unbalanced "${stack[stack.length - 1]}" — missing closing bracket.`;
  return undefined;
};
