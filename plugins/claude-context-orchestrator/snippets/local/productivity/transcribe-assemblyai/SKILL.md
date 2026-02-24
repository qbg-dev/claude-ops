---
name: "AssemblyAI Transcription"
description: "Use when transcribing audio files with speaker diarization. Triggers on TRANSCRIBE keyword."
pattern: "\\b(TRANSCRIBE)\\b[.,;:!?]?"
---

# AssemblyAI Audio Transcription with Speaker Diarization

## Default Behavior

When the user says "TRANSCRIBE" without specifying a file, **automatically find the latest audio file in `~/Downloads/`**:

```bash
/bin/ls -lt ~/Downloads/ | grep -iE '\.(m4a|mp3|mp4|wav|flac|ogg|webm|mov|avi|mkv)$' | head -1
```

Then transcribe that file. Always confirm which file you found before proceeding.

## Environment

- **Python venv**: `/Users/wz/Desktop/.venv` (assemblyai is installed here)
- **API key**: Set via `ASSEMBLYAI_API_KEY` environment variable (see ~/.zshrc or ~/.zprofile)

## Required Configuration (CRITICAL)

The API **requires** `speech_models` parameter. Without it, transcription will fail with:
> `"speech_models" must be a non-empty list containing one or more of: "universal-3-pro", "universal-2"`

**Always use this config:**
```python
aai.settings.http_timeout = 300.0  # CRITICAL: prevents upload timeout on large files (>20MB)

config=aai.TranscriptionConfig(
    speaker_labels=True,
    speech_models=['universal-3-pro', 'universal-2'],
    language_detection=True
)
```

## Workflow: Single Bash Script Pipeline

**CRITICAL: Do the entire pipeline in ONE bash script.** Do NOT use multiple sequential tool calls for transcribe → read → rename speakers → rename file → archive. Write a single script that handles everything.

### How it works

1. **Find the file** — Confirm which audio file was found (one tool call)
2. **Run the full pipeline** — ONE bash script that does everything (one tool call)
3. **Read and summarize** — Read the final transcript and provide summary (one tool call)

That's 3 tool calls max, not 5+.

### The Script Template

Write a bash script like this (adapt speaker names, dates, filenames, archive paths):

```bash
#!/bin/bash
set -e

AUDIO_FILE='/path/to/audio.m4a'
TEMP_OUTPUT='/path/to/audio - transcript.md'
FINAL_NAME='/path/to/YYYY-MM-DD - Topic Summary.md'
ARCHIVE_DIR="$HOME/.transcripts/<subdirectory>"
EXTRA_COPY='/path/to/project/claude_files/'  # optional, omit if not applicable

# Step 1: Transcribe
cd /Users/wz/Desktop && source .venv/bin/activate && python3 -c "
import assemblyai as aai
import os
aai.settings.api_key = os.environ['ASSEMBLYAI_API_KEY']
aai.settings.http_timeout = 300.0

transcript = aai.Transcriber().transcribe(
    '$AUDIO_FILE',
    config=aai.TranscriptionConfig(
        speaker_labels=True,
        speech_models=['universal-3-pro', 'universal-2'],
        language_detection=True
    )
)

if transcript.status == aai.TranscriptStatus.error:
    print(f'ERROR: {transcript.error}')
    exit(1)
else:
    for u in transcript.utterances:
        print(f'Speaker {u.speaker}: {u.text}')
        print()
" > "$TEMP_OUTPUT" 2>&1

# Step 2: Check for errors
if grep -q '^ERROR:' "$TEMP_OUTPUT" || grep -q 'Traceback' "$TEMP_OUTPUT"; then
    echo "TRANSCRIPTION FAILED — check $TEMP_OUTPUT"
    exit 1
fi

# Step 3: Rename speakers (use sed — this is the one case where sed is correct)
# Determine speaker names from context before running. Examples:
sed -i '' 's/^Speaker A:/Warren:/g' "$TEMP_OUTPUT"
sed -i '' 's/^Speaker B:/Matt:/g' "$TEMP_OUTPUT"

# Step 4: Rename file
mv "$TEMP_OUTPUT" "$FINAL_NAME"

# Step 5: Archive
mkdir -p "$ARCHIVE_DIR"
cp "$FINAL_NAME" "$ARCHIVE_DIR/"

# Step 6: Extra copy (if applicable)
if [ -n "$EXTRA_COPY" ]; then
    mkdir -p "$EXTRA_COPY"
    cp "$FINAL_NAME" "$EXTRA_COPY/"
fi

echo "DONE: $(wc -l < "$FINAL_NAME") lines"
echo "Filed to: $FINAL_NAME"
echo "Archived: $ARCHIVE_DIR/"
[ -n "$EXTRA_COPY" ] && echo "Copied to: $EXTRA_COPY/"
```

**Set bash timeout to 600000ms (10 min)** — transcription + upload can take a while for large files.

### Before running the script

You must decide these things FIRST (read the first few lines of transcript output if needed to determine topic/speakers):

1. **Speaker names** — If you can identify from context (e.g., Warren + Matt), set the sed replacements. If not, leave as Speaker A/B.
2. **Final filename** — `YYYY-MM-DD - <Topic Summary>.md` (3-6 words, Title Case)
3. **Archive subdirectory** — Choose from the table below
4. **Extra copy path** — Only if there's an obvious project context

### Content-based rename guidelines

Generate a descriptive filename: `YYYY-MM-DD - <Topic Summary>.md`
- Use today's date (or recording date if known from filename)
- Topic summary should be 3-6 words, Title Case
- Examples:
  - `2026-02-05 - Product Permissions Architecture Discussion.md`
  - `2026-01-28 - Client Onboarding Call.md`
  - `2026-02-03 - Weekly Team Standup.md`

### Archive subdirectories

| Subdirectory | When to use |
|---|---|
| `work/poly/` | Poly/Baoyuan property management business calls |
| `work/meetings/` | General work meetings, standups |
| `work/interviews/` | Job interviews, candidate screens |
| `personal/` | Personal calls, conversations |
| `academic/` | Lectures, office hours, study groups |
| `misc/` | Anything that doesn't fit above |

Use best judgment to categorize. When unsure, use `misc/`.

### Contextual copy (if applicable)

If there's an obvious project-specific location, **also** copy there:
- If discussing a specific codebase project → `./claude_files/` or relevant docs folder
- If it's a client/contact call → check if a `contacts/` directory exists
- If no obvious project context → skip (the `~/.transcripts/` archive is sufficient)

### Two-pass approach for unknown speakers

If you can't determine speaker names upfront, do a lightweight two-pass:
1. Run the transcription script WITHOUT sed renames (leave as Speaker A/B)
2. Read the first ~20 lines to identify speakers
3. Run sed in the same script or as a quick follow-up, then rename + archive

Even in this case, keep the rename + archive in one script—don't do 5 separate tool calls.

## Pricing

| Feature | Cost |
|---------|------|
| Core transcription | $0.37/hour ($0.00617/min) |
| Speaker diarization | +$0.36/hour ($0.006/min) |
| **Total with diarization** | **$0.73/hour (~$0.012/min)** |

## Supported Formats

Audio: mp3, mp4, wav, flac, ogg, webm, m4a
Video: mp4, mov, avi, mkv (extracts audio)
Max file size: 5GB

## Common Options

```python
config = aai.TranscriptionConfig(
    speaker_labels=True,                    # Enable diarization (always use)
    speech_models=['universal-3-pro', 'universal-2'],  # REQUIRED
    language_detection=True,                # Auto-detect language
    speakers_expected=2,                    # Hint for expected speakers (optional)
    punctuate=True,                         # Add punctuation
    format_text=True,                       # Format numbers, dates, etc.
    word_boost=["specific", "terms"],       # Boost recognition of specific words
)
```

## Speaker Identification

After transcription, **identify speakers by name if obvious from context**:
- If the user provides context about who the speakers are, label them accordingly (e.g., "Warren:", "Jenny:")
- If identity is obvious from the conversation content (e.g., someone says their name, references their role, or the context makes it clear), label them
- If identity is **not** obvious, leave as generic "Speaker A:", "Speaker B:" etc.—do not guess. Only ask the user if they volunteer the info or if it's needed for the task

When renaming speakers, do a find-and-replace across the entire transcript.

## Post-Transcription Summary

After all copies are done, provide a brief summary:
- **Speakers**: Number detected, with identified names if known
- **Language**: Detected language
- **Topics**: Key subjects discussed
- **Action items**: Any commitments or next steps mentioned
- **Filed to**: List all locations the transcript was saved/copied to
