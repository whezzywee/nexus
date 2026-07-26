# Nexus compatibility patches

This directory vendors
[`freenet-test-network`](https://github.com/freenet/freenet-test-network) at
commit `16795487ad9701b7bc127e90b486f51688ea9151` (upstream version 0.1.23)
under its original LGPL-3.0-only license.

Nexus carries four narrow compatibility changes:

1. `freenet-stdlib` is aligned from the upstream 0.1.x dependency to 0.8.4,
   matching Freenet Core 0.2.107. On MSVC, linking both generations exports
   `__frnt_set_id` twice and fails with `LNK2005`.
2. generated gateway public-key paths use forward slashes. Upstream writes
   native Windows backslashes into a TOML basic string, where `\U` is parsed as
   the start of a Unicode escape.
3. the diagnostics contract-state lookup uses the instance ID display string,
   matching the `HashMap<String, ContractState>` shape in stdlib 0.8.4.
4. three upstream dead-code warnings are locally allowed so Nexus's strict
   workspace validation output remains actionable.

The rest of the upstream source is unchanged. Remove this vendored copy when an
upstream release contains equivalent fixes.
