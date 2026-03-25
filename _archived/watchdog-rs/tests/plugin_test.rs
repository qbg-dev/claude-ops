use std::time::Instant;

/// Test the unread mail notification logic (pure, no HTTP)
mod unread_mail {
    use super::*;
    use std::collections::HashMap;

    struct MockUnreadMail {
        first_seen: HashMap<String, Instant>,
    }

    impl MockUnreadMail {
        fn new() -> Self {
            Self {
                first_seen: HashMap::new(),
            }
        }

        fn check(&mut self, worker_name: &str, token: Option<&str>, count: usize) -> Option<String> {
            // No token → skip
            token?;

            if count == 0 {
                self.first_seen.remove(worker_name);
                return None;
            }

            let since = self
                .first_seen
                .entry(worker_name.to_string())
                .or_insert(Instant::now());
            let mins = since.elapsed().as_secs() / 60;

            Some(format!(
                "{}: {} unread message{} ({}min)",
                worker_name,
                count,
                if count > 1 { "s" } else { "" },
                mins,
            ))
        }
    }

    #[test]
    fn no_token_returns_none() {
        let mut plugin = MockUnreadMail::new();
        assert!(plugin.check("worker1", None, 5).is_none());
    }

    #[test]
    fn zero_unread_returns_none() {
        let mut plugin = MockUnreadMail::new();
        assert!(plugin.check("worker1", Some("tok"), 0).is_none());
    }

    #[test]
    fn unread_returns_notification() {
        let mut plugin = MockUnreadMail::new();
        let result = plugin.check("merger", Some("tok"), 3);
        assert!(result.is_some());
        let msg = result.unwrap();
        assert!(msg.contains("merger"));
        assert!(msg.contains("3 unread messages"));
        assert!(msg.contains("0min"));
    }

    #[test]
    fn single_message_no_plural() {
        let mut plugin = MockUnreadMail::new();
        let msg = plugin.check("w1", Some("tok"), 1).unwrap();
        assert!(msg.contains("1 unread message "));
        assert!(!msg.contains("messages"));
    }

    #[test]
    fn cleared_unread_resets_timer() {
        let mut plugin = MockUnreadMail::new();
        // First detection
        plugin.check("w1", Some("tok"), 2);
        assert!(plugin.first_seen.contains_key("w1"));

        // Clear
        plugin.check("w1", Some("tok"), 0);
        assert!(!plugin.first_seen.contains_key("w1"));
    }
}

/// Test liveness monitoring logic (pure, no filesystem)
mod liveness {
    #[derive(Debug)]
    struct MockLiveness;

    impl MockLiveness {
        fn check(
            &self,
            status: &str,
            liveness_epoch: Option<i64>,
            now: i64,
            sleep_duration: i64,
        ) -> Option<String> {
            if status != "active" {
                return None;
            }
            let liveness = liveness_epoch?;
            let stale_sec = now - liveness;
            let threshold = sleep_duration.max(1200);

            if stale_sec > threshold {
                Some(format!(
                    "heartbeat stale {}s (threshold {}s)",
                    stale_sec, threshold
                ))
            } else {
                None
            }
        }
    }

    #[test]
    fn skip_non_active() {
        let mon = MockLiveness;
        assert!(mon.check("sleeping", Some(100), 200, 300).is_none());
        assert!(mon.check("standby", Some(100), 200, 300).is_none());
    }

    #[test]
    fn skip_no_liveness_file() {
        let mon = MockLiveness;
        assert!(mon.check("active", None, 200, 300).is_none());
    }

    #[test]
    fn healthy_within_threshold() {
        let mon = MockLiveness;
        // 200 - 100 = 100s, threshold = max(300, 1200) = 1200s
        assert!(mon.check("active", Some(100), 200, 300).is_none());
    }

    #[test]
    fn stale_beyond_threshold() {
        let mon = MockLiveness;
        // now - liveness = 5000 - 100 = 4900s > max(300, 1200) = 1200s
        let result = mon.check("active", Some(100), 5000, 300);
        assert!(result.is_some());
        let msg = result.unwrap();
        assert!(msg.contains("4900s"));
        assert!(msg.contains("1200s"));
    }

    #[test]
    fn large_sleep_duration_uses_as_threshold() {
        let mon = MockLiveness;
        // sleep_duration = 3600 > 1200, so threshold = 3600
        // stale = 5000 - 2000 = 3000s < 3600 → healthy
        assert!(mon.check("active", Some(2000), 5000, 3600).is_none());

        // stale = 5000 - 1000 = 4000s > 3600 → stale
        let result = mon.check("active", Some(1000), 5000, 3600);
        assert!(result.is_some());
    }

    #[test]
    fn minimum_threshold_is_1200() {
        let mon = MockLiveness;
        // sleep_duration = 60, threshold = max(60, 1200) = 1200
        // stale = 2000 - 500 = 1500s > 1200 → stale
        let result = mon.check("active", Some(500), 2000, 60);
        assert!(result.is_some());
        assert!(result.unwrap().contains("1200s"));
    }
}
