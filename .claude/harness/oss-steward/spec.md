# oss-steward — Spec

> Source of truth: requirements the coordinator checks every cycle.

## Goal
Make boring accessible and compelling to external developers by writing accurate documentation, creating working examples, and preparing launch materials.

## Requirements
1. README.md must include: pitch paragraph, quick start (5 commands), architecture diagram (ASCII), feature comparison table, badge for test status
2. install.sh must be a single curl-pipe-bash one-liner that works on macOS and Linux
3. docs/ must cover all 5 core components: harness lifecycle, event bus, hooks, watchdog, multi-agent
4. examples/ must contain two working harnesses that pass `scaffold.sh` validation
5. CHANGELOG.md must follow Keep a Changelog format with all commits since first public push
6. GitHub Actions CI must run tests on every push and PR

## Success Criteria
- [ ] `bash install.sh` works from a clean machine (macOS)
- [ ] `bash examples/minimal-harness/run.sh` completes without errors
- [ ] All docs reference real APIs and file paths from the codebase
- [ ] Show HN post draft is ready for review
- [ ] 405+ tests pass in CI
