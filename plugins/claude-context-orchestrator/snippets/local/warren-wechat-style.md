---
name: "Warren WeChat Message Style"
description: "Guide for writing WeChat messages in Warren's professional Chinese style - for deployment updates, feature explanations, polite replies, business coordination, owning mistakes, and technical proposals"
pattern: "\\b(WECHAT|微信)\\b[.,;:!?]?"
---

# Warren's WeChat Message Writing Guide

Use this guide when drafting WeChat messages for Warren in professional Chinese contexts.

## Core Style Principles

### 1. Plain Text (No Markdown)

WeChat does NOT render markdown. Write plain text only.

- ❌ **bold**, *italic*, `code`, [links](url), # headers
- ✓ Use line breaks and spacing for structure
- ✓ Use 1. 2. 3. or - for lists (plain text, not markdown)
- ✓ Use （parentheses）for emphasis when needed

### 2. Formality & Warmth

- Always use 您 (formal "you"), never 你
- Team references: Use "这边我们..." or "我们这边..." (on our end)
- Acknowledge first, then proceed: Start with "好的收到" or "好的谢谢" before adding content
- No excessive emojis — only [Facepalm] when owning mistakes, [傻笑] for self-deprecating humor about minor things, [流泪] for lamenting quality issues, [Rose] for thanks
- Use 老师 as honorific for counterparts (黄老师, 郭老师)

### 3. English Tech Terms Mixed Naturally

Warren freely mixes English technical terms into Chinese sentences. Never translate these:
- regression, debug, ssh, callback, API, script, IP, OSS, RAM, bucket, TTL, BI, ping, deploy, stage, config
- fallback, cache, build, dedup, edge case, enforcement, prompt, workaround, AST, parse, SOP, payload, bust, enricher, reconciler, jail break, defense in depth

Examples:
- "有可能在升级的时候出现了regression"
- "这样我们这边可以debug一下"
- "还在写权限控制的script"
- "越小化还是越好" (about permissions — principle-driven)

### 4. Rapid-Fire Short Messages

Warren often sends multiple short messages in quick succession instead of one long block. Each line can be a separate message:

```
找到问题了
感谢黄老师
120.77.216.196没有在微信白名单上面
这边我写一下
```

NOT one long paragraph combining all of this.

### 5. Common Opening Patterns

| Situation                  | Opening                          |
| -------------------------- | -------------------------------- |
| Acknowledging info         | 好的收到 / 好的谢谢 / 好的收到谢谢 |
| Greeting someone           | 您好 / @Name 您好                |
| After they share something | 收到。谢谢！/ 收到！谢谢          |
| Starting new topic         | 这边我看一下... / 这边想请教一下  |
| Confirming something       | 我确认一下 / 确认了              |
| After investigating        | 我看了一下 / 我看了              |
| Asking someone to wait     | 等我一下 / 稍等                  |

### 6. Common Closing Patterns

| Situation                  | Closing                                      |
| -------------------------- | -------------------------------------------- |
| Routine updates            | (No closing needed — just end with content)  |
| Large/complex issues ONLY  | 有任何问题直接ping我们                       |
| Promising action           | 我们这边尽快排查                             |
| Scheduling                 | 您们方便大概...点...钟左右我们可以快快开个会 |
| Gratitude                  | 感谢！/ 谢谢您 / 谢谢！                     |
| Reassuring others          | 没事的。这边您们看。我们有任何需求都可以接上的 |
| Delivering something       | 您们请查收                                   |
| Promising follow-up        | 我待会测试一下给您回复                       |
| Giving timeline            | 这边半个小时左右给过来                       |
| Incremental commitment     | 我先做一个版本... / 这边先把...跑通           |
| No rush / de-pressuring    | 不着急反馈 / 不着急的                        |
| Signing off for the night  | 我可能直接睡了。...麻烦告诉我一下，我明天... |

## Message Templates by Type

### Type 1: Deployment/Technical Update

```
好的收到
这边我们检查一下
是有[具体变化]方面设置的更新。[简短说明]
```

Or longer:

```
这边我们加了一个[功能名]
[1-2句功能说明]
您也可以在 [URL] 这里查看。这是我的测试机。
```

### Type 2: Feature Walkthrough

```
我写一个文档给您们看一下。同时我们这边今天讨论了[主题]

[要点1]：
[简短说明]

[要点2]：
[简短说明]

这边我们在对比一下各个方案。您们方便大概[时间]左右我们可以快快开个会，对接一下。
```

### Type 3: Issue Apology + Resolution

Light issue:
```
抱歉！我们这边尽快排查
因为这个理论上应该不会有问题的。但是有可能[可能原因]。我们不确定
这边可以给我们[需要的权限/信息]吗？
这样我们这边可以debug一下
```

Serious issue (your fault):
```
实在抱歉。这边疏忽了
[简短解释原因]
这边我[具体补救措施]
```

### Type 4: Owning a Mistake

Warren owns mistakes directly, without deflecting. Pattern: admit → explain → fix.

```
这个是我的问题。我这边忘记要加这个了
```

```
[Facepalm]我看一下
这边上线了
我看一下什么问题
恢复然后上线了
```

```
我看了。原因是因为我这边阿里云没有钱了
抱歉[Facepalm]
```

```
实在抱歉。最新的哪个版本被写掉了。但是之前您保存的都在。我这里给到您之前存的最新版本
我现在看能不能通过日志恢复
```

### Type 5: Polite Acknowledgment/Reply

```
好的收到
这样可以的
```

Or with next step:

```
好的收到。谢谢！
这边我们接进来
```

Flexible agreement:
```
嗯好的。收到
```

### Type 6: Requesting Access/Info

```
请问这些[东西]有一个[具体需求]我们可以测试一下吗？
我看一下我们具体需要哪一些权限
谢谢您
```

With security principle:
```
这边我写一下需要的权限
越小化还是越好
```

### Type 7: Scheduling/Coordination

```
这边我们在对比一下各个方案。您们方便大概早上10点十一点钟左右我们可以快快开个会，对接一下。讨论完以后可以再出几个版本，我们可以快速迭代
```

### Type 8: Asking Technical Questions

```
您好，我们了解一下现在[系统]用的是什么[技术细节]？
并且之前[系统]升级的时候业务端出现了什么错误？
```

```
我确认一下，是最大生存时间200，最大空闲时间40吗？因为另外一边的话最大空闲时间不会被触发？
```

```
我也想问一下 @Name [具体技术问题]？
```

### Type 9: Introducing Research/External Expertise

```
关于之前[话题]我们的一些讨论我问了一下我同事 @Name。他之前在[公司]的[团队]工作过。这边是他这几天写的关于[话题]的一些想法。主要是看之后如果想要[目标]的话的一些方案参考。

这个只是初步的调研，很多细节还要根据我们的实际情况来定。现在的系统对于现在的用处来说够用了。这个作为一个长期的思路。可以开始讨论。
```

Note: Warren introduces team members by name + relevant credentials, then manages expectations about the research scope.

### Type 10: Proactive Feature Delivery

```
这边做出来了一个版本。您们看一下
我写一下文档。等我一下
```

```
嗯好的。这个可以的。您们觉得这个有需要我们20分钟就可以做出来
我先做一个版本放在我的测试服务器里面
可以对比一下
```

```
这边之前讨论的UI上面的改动也做出了新的一版本。您们请查收。我等会会给黄老师发一下部署细节
```

### Type 11: Technical Proposal (Structured)

For longer proposals, Warren uses numbered sections with colons. Plain text, no markdown headers.

```
关于几个需求，这边是我们的想法：

问题一：[标题]

[说明]

我们的流程现在是这样的：
[步骤] → [步骤] → [步骤] → [步骤]

您们唯一需要做的：[简短要求]

---

问题二：[标题]

[说明]

---

问题三：[标题]

需要完成的准备：
1. [步骤]
2. [步骤]
3. [步骤]

这是目前唯一需要您们完成的。主要是[总结]，其余我们这边对接处理
```

### Type 12: Investigation Progress (Rapid Updates)

Warren sends rapid short messages during live debugging:

```
我看了一下，没有转发给我们。转发给了这个IP：
120.24.84.12
(dig +short wx.baoyuansmartlife.com)
```

```
找到问题了
感谢黄老师
120.77.216.196没有在微信白名单上面
这边我写一下
```

```
这边可以了
我写一下流程
```

### Type 13: Clarifying Understanding

Warren is transparent about prior misunderstandings:

```
好的。我之前的理解是[之前的理解]。这边[实际情况]？
```

```
我们之前以为是ECS。还在想这个怎么做的
现在了解了
```

### Type 14: Concept Explanation (for non-technical audience)

```
我们这边现在想了想，区分了这两个：

[概念A]（[位置]）：
[1-2句解释核心作用]。[举例]。

[概念B]：
[1-2句解释核心作用]。[举例]。[类比帮助理解]。

总结为：[A]保证[X]，[B]保证[Y]。不知这个清楚不清楚。
```

### Type 15: Bug Fix Report (修复报告)

Two versions: Short and Detailed. These are two ends of a spectrum—adapt elements as needed. For example, a medium bug might use the Short format but add one line about prevention. Not every field needs to be filled for every report.

**Version A — Short (for small-medium bugs)**

Structure: what broke → why → what we did. 3-5 rapid messages.

Template:
```
这边修复了[功能/系统]的一个问题
之前的情况：[一句话现象]
原因：[一句话root cause]
修复：[一句话fix]
已经上线了
```

Example 1 (bug nobody reported yet):
```
这边修复了工单系统的一个问题
之前的情况：部分工单创建后状态没有同步到田丁
原因：webhook的callback URL配置在上次deploy的时候被覆盖了
修复：恢复了正确的callback配置，同时加了deploy时候的config保护
已经上线了
```

Example 2 (bug someone reported — open with thanks):
```
感谢刘瑶老师反馈
这边修好了
之前客服平台偶尔会显示不了历史消息。原因是session过期的逻辑有一个edge case
这边修了逻辑同时加了自动重连
已经上线了。您再试一下
```

Example 3 (trivial bug, even shorter):
```
这边修了一个小的显示问题
之前日期在某些情况下会显示英文格式
已经改好了
```

---

**Version B — Detailed Report (for bigger bugs / incidents with user-visible impact)**

Structure: numbered sections. Include impact, root cause, fix, and prevention. Use for bugs that caused downtime, data issues, or stakeholder concern.

Template:
```
关于[系统/功能]之前出现的问题，这边修复了。给您们汇报一下：

问题现象：
[用户看到了什么，影响了谁，持续多久]

问题原因：
[root cause]

修复措施：
1. [具体做了什么]
2. [如有多步]

后续预防：
[可选——加了什么机制防止复发]

当前状态：已修复并上线
```

Example 1 (API failure affecting customers):
```
关于今天上午客服消息发不出去的问题，这边修复了。给您们汇报一下：

问题现象：
今天上午大概9:30到9:50之间，部分业主的咨询没有收到AI回复。影响了大概15条消息

问题原因：
微信客服API的access_token过期后刷新失败了。原因是token刷新的请求和正常消息发送并发冲突，导致用了一个已经失效的token

修复措施：
1. 修复了token刷新的并发问题，加了lock机制
2. 对那15条未回复的消息做了补发

后续预防：
加了token健康检查。每5分钟自动检测，如果快过期会提前刷新

当前状态：已修复并上线。从10点开始一直稳定运行
```

Example 2 (data display error in BI):
```
关于财务看板数据不一致的问题，这边修复了。给您们汇报一下：

问题现象：
BI看板里面深蓝公寓2月的收缴率显示为0%，实际数据是有的

问题原因：
StarRocks里面的view在月初刷新的时候有一个时区问题。query用的是UTC时间，但数据写入用的是北京时间，导致2月1号的数据落在了1月31号

修复措施：
1. 统一了query和写入的时区为Asia/Shanghai
2. 重新刷新了2月的聚合数据

当前状态：已修复。数据已恢复正常显示
```

Example 3 (serious incident with timeline):
```
关于昨天下午系统短暂中断的情况，这边整理了一下：

问题现象：
昨天下午14:20到14:45之间，整个系统无法访问，包括客服消息和管理后台。持续约25分钟

时间线：
14:20 系统开始无响应
14:25 我们收到报警开始排查
14:35 定位到原因
14:40 修复部署
14:45 确认全部恢复

问题原因：
阿里云ECS的系统盘空间满了。日志文件没有配置自动清理，积累了几个月占满了磁盘

修复措施：
1. 清理了历史日志，释放了空间
2. 配置了日志自动轮转（保留最近7天）
3. 加了磁盘空间监控，80%时自动报警

实在抱歉给您们造成不便
```

---

Usage guidance:

| 情况 | 用哪个版本 |
|------|-----------|
| 小bug，没人注意到 | Version A（最短形式，3行就够） |
| 有人反馈的bug | Version A（开头加感谢） |
| 用户可见的影响 | Version B（不需要时间线） |
| 导致停机/数据问题 | Version B（加时间线 + 后续预防） |

Note: 这是一个spectrum，不需要严格按照模板。根据bug的严重程度和影响范围，自由组合元素。

### Type 16: Pre-launch Checklist / Cross-team Dependency Request

Listing what you need from multiple teams before a milestone. Organized by topic with numbered items.

```
您们好，这边整理了一下我们上线前还需要的几个东西。收到之后我们这边花一些时间接进来就可以上线了

1. [需求名]
这边请问可以给一下[具体内容]吗？这样我们这边可以将[具体逻辑]写好

2. [需求名]

3. [需求名]

4. [需求名]
```

### Type 17: End-of-day Handoff / Signing Off

Telling the team you're done for the day, what they should test, and what you'll do tomorrow.

```
半个小时左右就好了。我可能直接睡了。您们测试一下。有任何[问题类型]的问题麻烦告诉我一下，我明天[具体计划]。谢谢！
```

Or when needing a break mid-day:

```
这边可能需要一个小时。这边有点事情要处理
```

Or giving a time commitment then handing off:

```
麻烦有任何问题可以在[链接]上面录入。我这边先睡了，明天继续将[具体任务]修复。现在看就差[剩余步骤]了。
```

### Type 18: New Project Onboarding Spec

Structured list of what's needed to onboard a new project. Organized by category with clear ownership.

```
关于新项目上线[系统名]，我这边需要以下信息：

1. [类别]
   - [具体需要的信息]
   - [具体需要的信息]

2. [类别]（需要[具体团队/人]操作）
   - [步骤]
   - 创建后提供给我：[需要什么]
   - [我方承诺，如：回调地址我来配，IP白名单我来加]

3. [类别]（需要[具体人]配合）@Name
   - [具体需要的数据/配置]

其余[技术配置]我这边搞定，不需要额外操作。

以上信息齐全后，我可以在[时间]内完成上线。
```

### Type 19: Multi-stakeholder Status Update

Addressing 3-4 people at once with structured findings, categorized by status.

```
@Name1 @Name2 @Name3

[简短结论/动作]

[验证/测试结果]：
- [类别A]（[路径/方法]）：[已覆盖/已完成/具体人名]
- [类别B]（[路径/方法]）：[已覆盖（本次新增）]

暂时无法[做到的事情]：
- [类别C]（如[具体例子]）

[类别C]数据目前只在[系统]里，[数据源]查不到

所以目前状态：
1. [类别A]——已覆盖
2. [类别B]——已覆盖（本次新增）
3. [类别C]——待解决（[原因]，需要[谁]配合）

下一步需要跟[谁]沟通：[具体需求]。@Name4
```

### Type 20: Asking Back for Available Data

Instead of prescribing a rigid format, ask what the other side can provide.

```
这边您们能够拿到哪些参数？
能拿到的都发给我们就好了
```

Or with a suggested format:

```
比如说这样可以的：
[具体示例格式]

其他额外字段也可以传，我们这边会一并接收记录。
```

## Key Vocabulary

| Chinese    | Usage                                                |
| ---------- | ---------------------------------------------------- |
| 这边       | "On this end" — use to refer to your team            |
| 给到       | "Deliver/provide to" — EXTREMELY frequent. "我这边给到接口", "给到您一个全部的手册" |
| 上线       | "Go live / deploy to production" — "新版本上线了"    |
| 跑通       | "Get working end-to-end" — "先把全部流程跑通"        |
| 兜底       | "Fallback / safety net" — "作为兜底方案"             |
| 接进来     | "Integrate / connect" — "我们这边接进来"             |
| 接上       | "Hook up / connect" — "我们有任何需求都可以接上的"   |
| 双线进行   | "Dual-track approach" — "我们双线进行"               |
| 对接       | "Sync up / align / interface with"                   |
| 方便       | "Convenient" — use when making polite requests       |
| 排查       | "Investigate/troubleshoot"                           |
| 快快       | "Quickly" — casual urgency                           |
| 迭代       | "Iterate"                                            |
| ping       | Acceptable English loanword in tech context          |
| 实在抱歉   | Stronger apology (vs regular 抱歉)                   |
| 疏忽       | "Oversight" — used when owning mistakes              |
| 请查收     | "Please check/review" — formal delivery              |
| 老师       | Honorific for counterparts (黄老师, 郭老师)           |
| 越...越好  | "The more X the better" — principle statements       |
| 不着急     | "No rush" — de-pressuring others                     |
| 辛苦您了   | "Thanks for the hard work" — toward ops/infra people |
| 麻烦您了   | "Sorry for the trouble" — expressing gratitude       |
| 我看一下   | "Let me look into this" — very common investigation opener |
| 我确认一下 | "Let me confirm" — promising to check before committing |

## Anti-Patterns (Avoid)

- ❌ Using markdown formatting (WeChat doesn't render it)
- ❌ Starting with just "您好" without context (too abrupt)
- ❌ Using 你 instead of 您
- ❌ Excessive apologies WITHOUT an action plan — always pair "抱歉" with what you're doing about it
- ❌ Long paragraphs — use short sentences and multiple messages
- ❌ Too many emojis — only [Facepalm] for self-blame, [傻笑] for self-deprecating humor, [流泪] for lamenting quality
- ❌ Ending routine updates with "有任何问题直接ping我们" (overused, save for large issues)
- ❌ Adding unnecessary closings to simple messages
- ❌ Deflecting blame — Warren owns mistakes directly ("这个是我的问题")
- ❌ Being vague about timelines — give rough estimates ("半个小时左右", "20分钟就可以做出来")
- ❌ Translating English tech terms into Chinese — keep them in English

## Context-Specific Adjustments

**When addressing seniors/clients:** More 谢谢, 感谢, 实在抱歉, use 老师 honorific
**When addressing peers:** Can be more direct, use "快快"
**When urgent:** "这边我们尽快..." / "我们这边今天..."
**When uncertain:** "有可能..." / "我们不确定" / "不知道有没有用" / "不知道要不要"
**When owning mistakes:** Lead with "实在抱歉" or "这个是我的问题", then immediately state the fix
**When delivering something:** "这边做出来了一个版本。您们看一下" + "我写一下文档。等我一下"
**When managing expectations:** "这个只是初步的...", "很多细节还要根据实际情况来定"
**When being flexible:** "或者您觉得[alternative]也好的"
**When willingness to try without committing:** "我这边研究一下看" / "我看我们能不能够..."
**When transparent about blockers:** "这边还在测试。现有的数据库里面暂时没有找到..." / "这边好像是AI本身的问题"
**When soft agreement before substance:** "嗯好的。收到" / "嗯。这边..." / "嗯好的。这个可以的"

### Person-Specific Addressing Guide

Warren adjusts tone and formality based on the relationship:

| Person | Address | Style |
|--------|---------|-------|
| 谢阳老师 | "谢阳老师您好" | Formal. Structured numbered questions. Always 您. Technical API discussions. |
| 刘瑶老师 | "刘瑶老师" / "@刘瑶" | Warm, collaborative. He is the product manager. "感谢帮忙测试！" |
| 廖翥 | "@廖翥" | Direct. Short replies. "收到感谢". |
| Jenny/李总 | "李总" / direct | Candid, strategic. Discusses tradeoffs openly. Uses 我 more than 我们这边. |
| 陈永华 | "永华老师好" / "永华老师" | Technical peer. Asks precise data questions. |
| 黄冠中 | "黄老师" | Appreciative of ops work. "谢谢！辛苦您了". |
| 易少强 | "易总" | Business-level. Proposals framed as "不知道有没有用" / "不知道会不会更加好用". |
