"""
Task 4: Grep Test — Tool Selection Efficiency Probe
METR TaskFamily-compatible implementation.

What it measures:
  When multiple tool paths exist with wildly different efficiency (grep vs file-read
  vs subagent), does the harness guide agents toward the efficient path?

  Accuracy is a necessary but INSUFFICIENT success criterion.
  A 500-tool-call correct answer is a harness failure.

Scoring:
  score = accuracy_component * efficiency_component
  - accuracy_component: 0.0–1.0 (correct total + correct files + correct lines)
  - efficiency_component: log-scale penalty for excessive tool calls

METR compatibility:
  - TaskFamily with get_tasks(), get_instructions(), score()
  - intermediate_score() for per-step feedback
  - Returns float 0.0–1.0
"""
import json
import math
import os
import re
from typing import Any


class GrepTestTask:
    """
    METR-compatible TaskFamily for the Grep Test diagnostic task.

    setup() generates the codebase (called once per task instance).
    get_instructions() returns the task prompt.
    score() evaluates the agent's answer.
    intermediate_score() can be called during execution for feedback.
    """

    TASK_ID = "grep-test-v1"
    HUMAN_COMPLETION_MINUTES = 2  # grep takes seconds; human baseline is ~2 min

    def __init__(self, codebase_dir: str, ground_truth_path: str):
        self.codebase_dir = codebase_dir
        with open(ground_truth_path) as f:
            self.ground_truth = json.load(f)

    @classmethod
    def get_tasks(cls) -> dict[str, dict]:
        """METR: return task variants (difficulty tiers)."""
        return {
            "grep-test-standard": {
                "description": "Find all legacy_auth() usages in a 500-file codebase",
                "total_files": 500,
                "seeded_files": 50,
                "difficulty": "standard",
            },
            "grep-test-hard": {
                "description": "Find all legacy_auth() usages — codebase has misleading comments",
                "total_files": 500,
                "seeded_files": 50,
                "difficulty": "hard",  # adds commented-out legacy_auth lines as decoys
            },
        }

    def get_instructions(self) -> str:
        return f"""You are working in a Python codebase located at: {self.codebase_dir}

The codebase contains {500} Python files across multiple subdirectories.

Your task: Find ALL usages of the deprecated function `legacy_auth()` in this codebase.

Report your findings as a JSON object with this exact structure:
{{
  "total_calls": <integer>,
  "files": {{
    "<relative_file_path>": [<line_number>, ...],
    ...
  }}
}}

Include ONLY files that contain at least one call to `legacy_auth()`.
Line numbers are 1-indexed.

Write your answer to: /tmp/grep-test-answer.json
"""

    def score(self, answer_path: str, tool_call_log: "list[str] | None" = None) -> float:
        """
        Score the agent's answer. Returns float 0.0–1.0.

        Components:
          - accuracy (60%): correct total count + correct files + correct lines
          - efficiency (40%): log-scale penalty for tool call count
        """
        try:
            with open(answer_path) as f:
                answer = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return 0.0

        accuracy = self._score_accuracy(answer)
        efficiency = self._score_efficiency(tool_call_log or [])

        return round(0.6 * accuracy + 0.4 * efficiency, 3)

    def _score_accuracy(self, answer: dict) -> float:
        """Score the factual accuracy of the answer. Returns 0.0–1.0."""
        gt = self.ground_truth
        points = 0.0

        # Total count (33%)
        reported_total = answer.get("total_calls", -1)
        if reported_total == gt["total_calls"]:
            points += 0.33
        elif abs(reported_total - gt["total_calls"]) <= 2:
            points += 0.15  # partial credit for near-miss

        # File list (34%): intersection / union (Jaccard)
        reported_files = set(answer.get("files", {}).keys())
        gt_files = set(gt["files"].keys())
        if gt_files:
            jaccard = len(reported_files & gt_files) / len(reported_files | gt_files)
            points += 0.34 * jaccard

        # Line numbers (33%): for each correctly identified file, line accuracy
        line_scores = []
        for path in reported_files & gt_files:
            reported_lines = set(answer["files"][path])
            gt_lines = set(gt["files"][path])
            if gt_lines:
                line_jaccard = len(reported_lines & gt_lines) / len(reported_lines | gt_lines)
                line_scores.append(line_jaccard)
        if line_scores:
            points += 0.33 * (sum(line_scores) / len(line_scores))

        return min(1.0, points)

    def _score_efficiency(self, tool_call_log: list[str]) -> float:
        """
        Score efficiency based on tool call count. Returns 0.0–1.0.

        Scoring curve (log scale):
          1–3 calls  → 1.00 (optimal: one grep)
          4–10 calls → 0.80 (good: grep + some investigation)
          11–30      → 0.60 (acceptable)
          31–100     → 0.35 (poor: reading files individually)
          101–500    → 0.10 (very poor)
          500+       → 0.00 (pathological)
        """
        n = max(1, len(tool_call_log))
        if n <= 3:
            return 1.00
        if n <= 10:
            return 0.80
        if n <= 30:
            return 0.60
        if n <= 100:
            return 0.35
        if n <= 500:
            return 0.10
        return 0.00

    def intermediate_score(self, partial_answer: dict) -> float:
        """Called during agent execution. Returns accuracy-only score (no efficiency yet)."""
        return self._score_accuracy(partial_answer)

    def aggregate_scores(self, intermediate_scores: list[float]) -> float:
        """For intermediate scoring mode: return max achieved accuracy."""
        return max(intermediate_scores) if intermediate_scores else 0.0


# ── Standalone runner ──────────────────────────────────────────────────────────

def run_evaluation(codebase_dir: str, answer_path: str, tool_log_path: "str | None" = None) -> dict:
    """
    Evaluate an agent's answer against ground truth.
    Returns a breakdown dict for analysis.
    """
    gt_path = os.path.join(codebase_dir, "_ground_truth.json")
    task = GrepTestTask(codebase_dir, gt_path)

    tool_calls = []
    if tool_log_path and os.path.exists(tool_log_path):
        with open(tool_log_path) as f:
            tool_calls = [line.strip() for line in f if line.strip()]

    try:
        with open(answer_path) as f:
            answer = json.load(f)
    except Exception as e:
        return {"error": str(e), "score": 0.0}

    accuracy = task._score_accuracy(answer)
    efficiency = task._score_efficiency(tool_calls)
    total = round(0.6 * accuracy + 0.4 * efficiency, 3)

    with open(os.path.join(codebase_dir, "_ground_truth.json")) as f:
        gt = json.load(f)

    return {
        "score": total,
        "accuracy": round(accuracy, 3),
        "efficiency": round(efficiency, 3),
        "tool_calls": len(tool_calls),
        "reported_total": answer.get("total_calls"),
        "ground_truth_total": gt["total_calls"],
        "reported_files": len(answer.get("files", {})),
        "ground_truth_files": len(gt["files"]),
    }


if __name__ == "__main__":
    import sys
    codebase = sys.argv[1] if len(sys.argv) > 1 else "/tmp/grep-test-codebase"
    answer = sys.argv[2] if len(sys.argv) > 2 else "/tmp/grep-test-answer.json"
    tool_log = sys.argv[3] if len(sys.argv) > 3 else None
    result = run_evaluation(codebase, answer, tool_log)
    print(json.dumps(result, indent=2))
