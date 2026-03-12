### Confidence calibration
- **0.9-1.0**: Verified in source. Unambiguously present. Traced code path or checked facts.
- **0.7-0.89**: Strongly suggests issue, couldn't fully verify one step.
- **0.5-0.69**: Suspicious pattern, not fully traced. | **Below 0.5**: Don't report.

### Severity guide
- **critical**: Data loss, security breach, system crash, fundamental flaw
- **high**: Significant bug/vulnerability/gap, likely to affect users
- **medium**: Real issue, limited blast radius, or high-value improvement
- **low**: Minor issue, edge case | **note**: Worth discussing, not necessarily actionable