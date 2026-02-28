# oss-steward — Acceptance Criteria

criteria:
  - id: "1.1"
    criterion: "TODO: First acceptance criterion"
    status: untested       # pass | fail | untested | regressed
    evidence: ""
    last_checked: null

  - id: "1.2"
    criterion: "TODO: Second acceptance criterion"
    status: untested
    evidence: ""
    last_checked: null

invariants:
  - id: "inv-1"
    name: "End-to-end verification"
    description: "Features work from user action through API to data and back. Not just endpoint pings — full round-trip with real data."
    status: untested
    evidence: ""
    last_checked: null

  - id: "inv-2"
    name: "Authorization & identity"
    description: "Correct permissions per role, session integrity across navigation, CSRF protection, restricted endpoints return 403."
    status: untested
    evidence: ""
    last_checked: null

  - id: "inv-3"
    name: "Latency & user experience"
    description: "Pages load within acceptable time, no layout shifts, no broken interactions, responsive at target breakpoints. Only required for UI-touching harnesses."
    status: untested
    evidence: ""
    last_checked: null
