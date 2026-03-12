use crate::plugin::{Plugin, PluginAction};
use crate::worker::WorkerSnapshot;
use async_trait::async_trait;
use dashmap::DashMap;
use std::time::{Duration, Instant};
use tracing::debug;

pub struct UnreadMailNotifier {
    http: reqwest::Client,
    fleet_mail_url: String,
    /// Tracks when unread mail was first detected per worker
    first_seen: DashMap<String, Instant>,
}

#[derive(serde::Deserialize)]
struct MailResponse {
    messages: Option<Vec<serde_json::Value>>,
}

impl UnreadMailNotifier {
    pub fn new(fleet_mail_url: String) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .expect("HTTP client"),
            fleet_mail_url,
            first_seen: DashMap::new(),
        }
    }

    async fn get_unread_count(&self, token: &str) -> Option<usize> {
        let url = format!("{}/api/messages?label=UNREAD", self.fleet_mail_url);
        let resp = self
            .http
            .get(&url)
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
            .ok()?;
        let body: MailResponse = resp.json().await.ok()?;
        Some(body.messages.map(|m| m.len()).unwrap_or(0))
    }
}

#[async_trait]
impl Plugin for UnreadMailNotifier {
    fn name(&self) -> &str {
        "unread-mail"
    }

    fn interval(&self) -> Duration {
        Duration::from_secs(60)
    }

    async fn check(&self, worker: &WorkerSnapshot) -> Option<PluginAction> {
        let token = worker.token.as_ref()?;
        let count = self.get_unread_count(token).await?;

        if count == 0 {
            self.first_seen.remove(&worker.name);
            return None;
        }

        let since = self
            .first_seen
            .entry(worker.name.clone())
            .or_insert(Instant::now());
        let mins = since.elapsed().as_secs() / 60;

        debug!(
            worker = %worker.name,
            count,
            mins,
            "unread mail detected"
        );

        Some(PluginAction::Notify(format!(
            "{}: {} unread message{} ({}min)",
            worker.name,
            count,
            if count > 1 { "s" } else { "" },
            mins,
        )))
    }
}
