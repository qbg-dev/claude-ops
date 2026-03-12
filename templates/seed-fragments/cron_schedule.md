## CronCreate Enforcement

Your `config.json` has a `cron_schedule`. A Stop hook blocks session exit until you've registered all expected crons via `CronCreate`. Call them **NOW**, at the start of your session.

The standard self-wake pattern: each CronCreate prompt tells you to re-read your seed context (mission, config, state) so you stay oriented across long sessions.
