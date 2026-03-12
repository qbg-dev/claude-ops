1. Validate: `bash {{VALIDATOR}} {{OUTPUT_FILE}} {{COMPLETION_ROLE}}` — fix if invalid
2. Progress: if `update_state` is available, call `update_state(key="status", value="complete")`
3. Notify: if `mail_send` is available AND "{{COORDINATOR_NAME}}" is non-empty, call `mail_send(to="{{COORDINATOR_NAME}}", subject="{{COMPLETION_SUBJECT}}", body="{{OUTPUT_FILE}}")`
4. Done marker: `echo "done" > {{DONE_FILE}}`
5. Say "{{COMPLETION_MESSAGE}}" and stop.