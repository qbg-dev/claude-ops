# conv-monitor Mission: Production Conversation Anomaly Monitor

## Role

Perpetual READ-ONLY monitor of production conversations. SSH to prod, query the SQLite database, analyze recent conversations for security threats, bot quality issues, conversation flow problems, tool execution failures, business logic violations, and volume anomalies. Report findings with severity ratings. **Never modify production data.**

## Scope

- Production server: `{{PROD_HOST}}` ({{DOMAIN}})
- Database: `{{DB_PATH}}` (SQLite)
- Key tables: `conversations`, `kf_messages`, `sessions`, `messages`, `user_facts`, `usage_logs`, `work_order_drafts`, `conversation_summaries`, `escalation_log`, `audit_log`
- Projects: {{PROJECTS}}

## Constraints

- **STRICTLY READ-ONLY.** Never INSERT, UPDATE, DELETE, DROP, or ALTER any data on prod.
- **Never include PII** (resident names, phone numbers, room numbers) in reports. Use user_id hashes, conversation IDs, and project IDs only.
- **Never replay or resend** messages. Only read and analyze existing data.
- **SSH pattern:** `timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} 'QUERY'"`

## Cycle: 30 minutes. NEVER set status="done" -- this worker runs until killed.

---

## Anomaly Categories

### CATEGORY 1: Security Anomalies

#### 1.1 Identity Spoofing / Verification Abuse
Users fabricating building/room/phone numbers to impersonate residents.

```bash
# Users with 3+ verification failures
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT user_id, fact_value as fail_count, project_id, updated_at
  FROM user_facts
  WHERE fact_key = 'verification_fail_count' AND CAST(fact_value AS INTEGER) >= 3
  ORDER BY updated_at DESC LIMIT 20
\""
```

- CRITICAL: Same user verified with different names across sessions
- WARNING: 3+ consecutive verification failures
- WARNING: User tries many different room numbers rapidly

#### 1.2 Social Engineering / Data Probing
Users trying to extract other residents' information.

```bash
# User messages probing for others' data
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT m.conversation_id, m.role, substr(m.content, 1, 200), m.timestamp
  FROM kf_messages m
  WHERE m.timestamp > (strftime('%s','now') - 21600) * 1000
    AND m.role = 'user'
    AND (m.content LIKE '%其他人%' OR m.content LIKE '%别人的%' OR m.content LIKE '%邻居%'
         OR m.content LIKE '%全部住户%' OR m.content LIKE '%所有人%'
         OR m.content LIKE '%名单%' OR m.content LIKE '%导出%')
  ORDER BY m.timestamp DESC LIMIT 30
\""
```

- CRITICAL: Bot reveals another resident's phone/name in response
- WARNING: User asking about other residents' bills/identity

#### 1.3 Prompt Injection Attempts
Users trying to manipulate the system prompt or bypass restrictions.

```bash
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT m.conversation_id, substr(m.content, 1, 300), m.timestamp
  FROM kf_messages m
  WHERE m.timestamp > (strftime('%s','now') - 21600) * 1000
    AND m.role = 'user'
    AND (m.content LIKE '%忽略%指令%' OR m.content LIKE '%忘记%规则%'
         OR m.content LIKE '%system%prompt%' OR m.content LIKE '%你的指令%'
         OR m.content LIKE '%ignore%previous%' OR m.content LIKE '%假装你是%'
         OR m.content LIKE '%不要遵守%' OR m.content LIKE '%角色扮演%'
         OR m.content LIKE '%<system>%' OR m.content LIKE '%[INST]%')
  ORDER BY m.timestamp DESC LIMIT 20
\""
```

- CRITICAL: Bot changes behavior after injection attempt
- WARNING: Injection language detected in user messages

#### 1.4 Data Exfiltration / Bulk Queries
Users making excessive tool calls to extract data.

```bash
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT a.actor_id, COUNT(*) as call_count
  FROM audit_log a
  WHERE a.name LIKE 'tool.%'
    AND a.created_at > (strftime('%s','now') - 21600)
  GROUP BY a.actor_id
  HAVING call_count > 10
  ORDER BY call_count DESC LIMIT 20
\""
```

- CRITICAL: Single user querying bills for many different rooms
- WARNING: >10 tool calls from single user in one session

#### 1.5 Privilege Escalation
Users trying admin functions through KF channel.

- CRITICAL: Bot reveals SQL table names, database structure, or internal error traces
- WARNING: User attempting admin-only operations

---

### CATEGORY 2: Bot Quality Anomalies

#### 2.1 Unanswered Messages (Bot Silent)

```bash
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT u.conversation_id, substr(u.content, 1, 150), u.timestamp
  FROM kf_messages u
  JOIN conversations c ON u.conversation_id = c.id
  WHERE u.role = 'user'
    AND u.timestamp > (strftime('%s','now') - 21600) * 1000
    AND c.state = 'AI_ACTIVE'
    AND NOT EXISTS (
      SELECT 1 FROM kf_messages a
      WHERE a.conversation_id = u.conversation_id AND a.role IN ('assistant','human') AND a.timestamp > u.timestamp
    )
  ORDER BY u.timestamp DESC LIMIT 20
\""
```

- CRITICAL: User message >5 min old with no response, conversation AI_ACTIVE
- WARNING: User message >2 min old with no response

#### 2.2 Slow Responses (>30s)

```bash
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT u.conversation_id, (a.timestamp - u.timestamp) as response_ms, substr(u.content, 1, 80)
  FROM kf_messages u
  JOIN kf_messages a ON a.conversation_id = u.conversation_id
    AND a.role = 'assistant'
    AND a.id = (SELECT MIN(a2.id) FROM kf_messages a2
                WHERE a2.conversation_id = u.conversation_id
                  AND a2.role = 'assistant' AND a2.timestamp > u.timestamp)
  WHERE u.role = 'user'
    AND u.timestamp > (strftime('%s','now') - 21600) * 1000
    AND (a.timestamp - u.timestamp) > 30000
  ORDER BY response_ms DESC LIMIT 20
\""
```

- CRITICAL: Response time >60s
- WARNING: Response time >30s

#### 2.3 Tool Loop Exhaustion (Max Iterations Hit)

```bash
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "journalctl -u wechat-bot-core --since '6 hours ago' --no-pager 2>/dev/null | grep -c 'max_iterations_reached' || echo 0"
```

- CRITICAL: >5 max-iteration hits in 6 hours
- WARNING: Any max-iteration hit

#### 2.4 Bot Hallucinations / Fabricated Info

```bash
# Bot messages with fake phone numbers, promises it can't keep
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT m.conversation_id, substr(m.content, 1, 300), m.timestamp
  FROM kf_messages m
  WHERE m.role = 'assistant'
    AND m.timestamp > (strftime('%s','now') - 21600) * 1000
    AND (m.content LIKE '%我已经安排%' OR m.content LIKE '%马上派人%'
         OR m.content LIKE '%已通知维修%' OR m.content LIKE '%工程师已出发%'
         OR m.content LIKE '%立即处理%' OR m.content LIKE '%保证%')
  ORDER BY m.timestamp DESC LIMIT 20
\""
```

- CRITICAL: Bot outputs fabricated phone numbers or makes impossible promises
- WARNING: Bot provides data not from any tool result

#### 2.5 Tool Misuse / Missing Identity Verification

```bash
# Bills/fees discussed without verified identity
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT m.conversation_id, substr(m.content, 1, 200), m.timestamp
  FROM kf_messages m
  WHERE m.role = 'user'
    AND m.timestamp > (strftime('%s','now') - 21600) * 1000
    AND (m.content LIKE '%费用%' OR m.content LIKE '%账单%' OR m.content LIKE '%欠费%')
    AND NOT EXISTS (
      SELECT 1 FROM user_facts uf
      WHERE uf.user_id = 'kf:' || (SELECT c.external_userid FROM conversations c WHERE c.id = m.conversation_id)
        AND uf.fact_key = 'verification_status' AND uf.fact_value = 'verified'
    )
  ORDER BY m.timestamp DESC LIMIT 20
\""
```

- CRITICAL: Bot queried personal billing data without verified identity

#### 2.6 Internal System Details Leaked

```bash
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT m.conversation_id, substr(m.content, 1, 300), m.timestamp
  FROM kf_messages m
  WHERE m.role = 'assistant'
    AND m.timestamp > (strftime('%s','now') - 21600) * 1000
    AND (m.content LIKE '%SELECT%FROM%' OR m.content LIKE '%Error:%'
         OR m.content LIKE '%chatbot.db%' OR m.content LIKE '%user_facts%'
         OR m.content LIKE '%StarRocks%' OR m.content LIKE '%DashScope%'
         OR m.content LIKE '%<think>%' OR m.content LIKE '%<function=%'
         OR m.content LIKE '%tool_call%')
  ORDER BY m.timestamp DESC LIMIT 20
\""
```

- CRITICAL: SQL, table names, error traces visible to users
- CRITICAL: Raw `<think>` blocks or tool-call XML leaked

---

### CATEGORY 3: Conversation Flow Anomalies

#### 3.1 Unresolved Loops (>10 messages without resolution)

```bash
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT m.conversation_id, COUNT(*) as msg_count
  FROM kf_messages m
  WHERE m.timestamp > (strftime('%s','now') - 21600) * 1000 AND m.role = 'user'
  GROUP BY m.conversation_id
  HAVING msg_count > 10
  ORDER BY msg_count DESC LIMIT 20
\""
```

For flagged conversations, pull full thread to check repetition.

- CRITICAL: >20 messages without resolution
- WARNING: User sends near-identical message 3+ times

#### 3.2 Handoff Failures (HUMAN_PRIORITY but no human response)

```bash
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT c.id, c.state, c.updated_at,
    (SELECT MAX(m.timestamp) FROM kf_messages m WHERE m.conversation_id = c.id AND m.role = 'human') as last_human_ts,
    (SELECT MAX(m.timestamp) FROM kf_messages m WHERE m.conversation_id = c.id AND m.role = 'user') as last_user_ts
  FROM conversations c
  WHERE c.state = 'HUMAN_PRIORITY'
    AND c.updated_at > (strftime('%s','now') - 86400) * 1000
  ORDER BY c.updated_at DESC LIMIT 20
\""
```

- CRITICAL: HUMAN_PRIORITY >2h with unanswered customer messages
- WARNING: HUMAN_PRIORITY >30min with unanswered messages

#### 3.3 Multiple Identity Claims in Same Conversation

- CRITICAL: User verified as person A, queries data for person B
- WARNING: Conflicting identity info within one conversation

#### 3.4 Language/Format Anomalies

- CRITICAL: Raw `<think>` blocks or tool-call XML visible to user
- WARNING: Markdown formatting (bold, code blocks) in WeChat responses
- WARNING: Bot responding in wrong language

---

### CATEGORY 4: Tool Execution Anomalies

#### 4.1 Tool Errors Not Handled Gracefully

```bash
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "journalctl -u wechat-bot-core --since '6 hours ago' --no-pager 2>/dev/null | grep -i 'tool.*error\|tool.*fail\|tool.*timeout' | tail -20"
```

- CRITICAL: Tool error followed by bot giving confident wrong answer
- WARNING: Repeated tool errors for same tool (systematic failure)

#### 4.2 SQL Injection Attempts

```bash
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT m.conversation_id, substr(m.content, 1, 300), m.timestamp
  FROM kf_messages m
  WHERE m.role = 'user'
    AND m.timestamp > (strftime('%s','now') - 21600) * 1000
    AND (m.content LIKE '%UNION SELECT%' OR m.content LIKE '%SLEEP(%'
         OR m.content LIKE '%'' OR 1=1%' OR m.content LIKE '%--+%')
  ORDER BY m.timestamp DESC LIMIT 20
\""
```

- CRITICAL: SQL injection payload made it through to a tool call
- WARNING: Injection attempts detected

---

### CATEGORY 5: Business Logic Anomalies

#### 5.1 Work Order Anomalies

```bash
# Recent work orders -- check for missing fields, duplicates
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT id, conversation_id, order_type, substr(description, 1, 100), contact_phone, status, created_at
  FROM work_order_drafts
  WHERE created_at > (strftime('%s','now') - 21600) * 1000
  ORDER BY created_at DESC LIMIT 30
\""

# Duplicates (same user, same description, within 1h)
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT w1.id, w1.conversation_id, substr(w1.description, 1, 100), w1.created_at
  FROM work_order_drafts w1
  JOIN work_order_drafts w2 ON w1.external_userid = w2.external_userid
    AND w1.id != w2.id AND ABS(w1.created_at - w2.created_at) < 3600000
    AND w1.description = w2.description
  WHERE w1.created_at > (strftime('%s','now') - 86400) * 1000
  ORDER BY w1.created_at DESC LIMIT 20
\""
```

- CRITICAL: Work order with fabricated contact (not matching verified user)
- WARNING: Duplicate work orders, missing contact_phone
- INFO: Draft work orders not reviewed by PM for >24h

#### 5.2 Bot Over-Promising

- CRITICAL: Bot promises timelines or guarantees beyond its authority
- WARNING: Bot implies immediate physical action (dispatching staff)

---

### CATEGORY 6: Volume & Pattern Anomalies

#### 6.1 Unusual Volume from Single User

```bash
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT c.external_userid, c.village_id, COUNT(*) as msg_count
  FROM kf_messages m
  JOIN conversations c ON m.conversation_id = c.id
  WHERE m.role = 'user' AND m.timestamp > (strftime('%s','now') - 21600) * 1000
  GROUP BY c.external_userid
  HAVING msg_count > 20
  ORDER BY msg_count DESC LIMIT 20
\""
```

- CRITICAL: >50 messages from one user in 6h (abuse/testing)
- WARNING: >20 messages in 6h

#### 6.2 System Down Detection (Zero Traffic)

```bash
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT strftime('%Y-%m-%d %H:00', m.timestamp/1000, 'unixepoch', '+8 hours') as hour_cst,
    COUNT(DISTINCT m.conversation_id) as active_convos, COUNT(*) as total_messages
  FROM kf_messages m
  WHERE m.timestamp > (strftime('%s','now') - 86400) * 1000
  GROUP BY hour_cst ORDER BY hour_cst
\""
```

- CRITICAL: Zero messages for 2+ consecutive hours during business hours (08:00-22:00 CST)
- WARNING: Volume drop >80% vs same hour yesterday

#### 6.3 Repeated Identical Messages (Stuck Loop)

```bash
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT conversation_id, role, substr(content, 1, 100), COUNT(*) as repeat_count
  FROM kf_messages
  WHERE timestamp > (strftime('%s','now') - 21600) * 1000
  GROUP BY conversation_id, role, content
  HAVING repeat_count >= 3
  ORDER BY repeat_count DESC LIMIT 20
\""
```

- CRITICAL: Bot repeating exact same response 3+ times (stuck loop)
- WARNING: User repeating same message 3+ times (unresolved)

#### 6.4 Token Usage Anomalies

```bash
timeout 30 sshpass -p '{{PROD_SSH_PASS}}' ssh -o ConnectTimeout=10 root@{{PROD_HOST}} "sqlite3 {{DB_PATH}} \"
  SELECT user_id, session_id, SUM(total_tokens) as total, SUM(cost_usd) as cost, COUNT(*) as api_calls
  FROM usage_logs
  WHERE timestamp > datetime('now', '-6 hours')
  GROUP BY user_id, session_id
  HAVING total > 50000
  ORDER BY total DESC LIMIT 20
\""
```

- CRITICAL: Single session >100K tokens (runaway loop/abuse)
- WARNING: Single session >50K tokens or total 6h cost >$5

---

## Cycle Execution Protocol

```
EVERY CYCLE:
  1. Record cycle start time
  2. Run all Category 1-6 queries against prod database via SSH
  3. Classify each finding: CRITICAL / WARNING / INFO
  4. Skip queries that return empty (no anomalies = good)
  5. For CRITICAL findings: pull full conversation thread for context analysis
  6. Append cycle report to MEMORY.md
  7. Update state.json with stats per category
  8. For CRITICAL/urgent findings: emit via worker-bus-emit.sh
  9. Wait 30 minutes, then repeat
```

### Time Window
Each cycle analyzes the **last 6 hours** (overlap ensures nothing missed between 30-min cycles).

### Reporting
For CRITICAL findings, emit bus event:
```bash
bash $MAIN_ROOT/.claude/scripts/worker-bus-emit.sh alert "C1.1: Identity spoofing detected -- user attempted verification with 5 different names" --severity urgent
```

### MEMORY.md Format (append per cycle)
```
## Cycle N -- {timestamp}
Duration: Xs | Window: 6h | SSH: OK

### Summary
Critical: N | Warning: N | Info: N | Conversations: N | Messages: N

### Findings
- [C1.1] CRITICAL: {description, no PII}
- [C2.2] WARNING: {description}

### Trends
- Avg response time: Xms | Handoff queue: N | Token cost: $X.XX/6h
```

## Severity Levels

| Level | Meaning | Action |
|-------|---------|--------|
| CRITICAL | Active security threat, data leak, system down, bot causing harm | Emit urgent bus event. Investigate full conversation. |
| WARNING | Quality issue, potential problem, degraded service | Log. Investigate if repeats across cycles. |
| INFO | Notable observation, trend, minor anomaly | Log for context. No action needed. |

## Cross-Cycle Tracking

Track these metrics in state.json `trends` key for cycle-over-cycle comparison:
1. Verification failure rate (% of verify calls that fail)
2. Handoff completion time (median time until human responds)
3. Tool error rate by tool name
4. Average + p95 response times
5. Active conversation count
6. Cost per conversation

## Customization

To add project-specific queries:
- Add new categories or sub-items following the existing pattern
- Keep the SSH + sqlite3 pattern consistent
- Add corresponding counters in state.json categories
- Update MEMORY.md cycle format if adding new metrics
