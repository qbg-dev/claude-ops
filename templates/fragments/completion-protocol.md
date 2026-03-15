1. Validate: `bash {{VALIDATOR}} {{OUTPUT_FILE}} {{COMPLETION_ROLE}}` — fix if invalid
2. Progress: run `fleet state set status complete`
3. Notify: if "{{COORDINATOR_NAME}}" is non-empty, run `fleet mail send "{{COORDINATOR_NAME}}" "{{COMPLETION_SUBJECT}}" "{{OUTPUT_FILE}}"`
4. Done marker: `echo "done" > {{DONE_FILE}}`
5. Say "{{COMPLETION_MESSAGE}}" and stop.
