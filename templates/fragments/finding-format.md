```json
{
  "pass": {{PASS_NUMBER}},
  "specialization": "{{SPECIALIZATION}}",
  "completed_at": "<ISO timestamp>",
  "findings": [
    {
      "location": "path/to/file.ts:42 OR 'Section: heading' OR 'overall'",
      "severity": "critical|high|medium|low|note",
      "kind": "bug|security|performance|design|ux|completeness|gap|risk|error|ambiguity|alternative|improvement",
      "confidence": 0.0-1.0,
      "confidence_reasoning": "Brief justification for your confidence level",
      "title": "Short title (under 80 chars)",
      "description": "Clear explanation of the issue and its impact",
      "evidence": "Chain-of-thought: what you read, what you traced, why it's real (file:lines checked)",
      "suggestion": "Concrete recommendation for how to fix or address it",
      "effort": "trivial|small|medium|large",
      "pre_existing": false
    }
  ],
  "enumerated_paths": [
    {
      "id": "P1",
      "path": "Login as admin -> /app/settings -> click 'Save' with empty name",
      "verify_method": "chrome|curl|script|test|code-review|query",
      "expected": "Shows validation error, no save occurs",
      "related_findings": ["finding index if applicable"]
    }
  ]
}
```

### Finding kinds
**Code**: bug, security, performance, design, ux, completeness, improvement | **Content**: gap, risk, error, ambiguity, alternative, improvement