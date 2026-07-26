# External pilot operations

The pilot begins only after the critical device-authority correction,
independent retest, protected fuzz evidence, installed acceptance, production
TURN acceptance, and a clean 72-hour soak. It is not a substitute for those
gates.

## Cohort and consent

Start with 10–25 invited participants across at least two independent networks
and representative supported hardware. Explain that this is a limited pilot,
what metadata and diagnostics exist, retention, known limitations, how to
report a problem, how to leave, and how to remove local and operator-held data.
Do not use participants' sensitive or irreplaceable communication.

## Staged rollout

1. Two maintainers perform clean install/update/rollback/recovery and a
   relay-only call using the production service.
2. Add five participants for 48 hours. Stop on any critical privacy, authority,
   data-loss, update, or availability failure.
3. Expand to the full cohort for at least seven days only after the first
   cohort's blockers are repaired and retested.
4. Freeze the candidate during measurement except for an explicitly documented
   emergency fix; a new binary restarts the qualification boundary.

## Scenarios and evidence

Exercise public/private messaging, membership changes, device link/revocation,
recovery, attachments at boundaries, search, moderation, notifications,
offline/reconnect, sleep/wake, multi-device conflict, direct and relay-only
calls, upgrades, diagnostics, accessibility, and support/contact removal.

Collect only opt-in, data-minimized reliability events plus support reports.
Preserve release version/hash, service version, redacted timestamps, severity,
reproduction, resolution, and retest. Do not collect message plaintext,
attachment contents, private keys, recovery material, stable TURN credentials,
or unnecessary social graphs.

## Exit criteria

- Zero unresolved critical/high authority, privacy, data-loss, update, recovery,
  or remote-code findings.
- No unexplained contract divergence or failed migration.
- Successful revocation and recovery for every staged exercise.
- Notification and accessibility critical paths accepted by representative
  users.
- Production TURN meets documented availability/capacity and secret rotation
  succeeds without credential leakage.
- The top pilot failures are fixed, regression-tested, and represented in the
  support documentation.

The release owner signs a dated pilot summary that links the exact candidate,
soak evidence, incident register, fixes, and remaining accepted risks.
