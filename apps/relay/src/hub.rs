use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use bytes::Bytes;
use tokio::sync::broadcast;

use crate::auth::AccountId;

pub type ConnectionId = u64;

/// One opaque frame fanned out to an account's other connections.
#[derive(Debug, Clone)]
pub struct Frame {
    pub sender: ConnectionId,
    pub data: Bytes,
}

/// In-memory fanout keyed by account. Holds no history: a restart loses nothing because
/// clients resync by state vector.
pub struct Hub {
    channels: Mutex<HashMap<AccountId, broadcast::Sender<Frame>>>,
    capacity: usize,
    next_connection: AtomicU64,
}

/// A connection's membership in its account channel; leaving cleans up the channel.
pub struct Subscription {
    pub id: ConnectionId,
    pub sender: broadcast::Sender<Frame>,
    pub receiver: broadcast::Receiver<Frame>,
}

impl Hub {
    pub fn new(capacity: usize) -> Self {
        Self { channels: Mutex::new(HashMap::new()), capacity: capacity.max(1), next_connection: AtomicU64::new(1) }
    }

    fn channels(&self) -> std::sync::MutexGuard<'_, HashMap<AccountId, broadcast::Sender<Frame>>> {
        // The map stays consistent even if a holder panicked: every critical section is one call.
        self.channels.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn join(&self, account: &AccountId) -> Subscription {
        let mut channels = self.channels();
        let sender = channels
            .entry(account.clone())
            .or_insert_with(|| broadcast::channel(self.capacity).0)
            .clone();
        let receiver = sender.subscribe();
        Subscription { id: self.next_connection.fetch_add(1, Ordering::Relaxed), sender, receiver }
    }

    /// Drops the subscription and removes the account's channel once nobody listens,
    /// so memory doesn't grow with every account ever seen.
    pub fn leave(&self, account: &AccountId, subscription: Subscription) {
        drop(subscription.receiver);
        let mut channels = self.channels();
        if channels.get(account).is_some_and(|s| s.receiver_count() == 0) {
            channels.remove(account);
        }
    }

    pub fn account_count(&self) -> usize {
        self.channels().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str) -> AccountId {
        AccountId(id.into())
    }

    #[tokio::test]
    async fn fans_out_within_an_account_only() {
        let hub = Hub::new(8);
        let a1 = hub.join(&account("a"));
        let mut a2 = hub.join(&account("a"));
        let mut b1 = hub.join(&account("b"));
        a1.sender.send(Frame { sender: a1.id, data: Bytes::from_static(b"x") }).unwrap();
        let got = a2.receiver.recv().await.unwrap();
        assert_eq!((got.sender, got.data.as_ref()), (a1.id, b"x".as_ref()));
        assert!(b1.receiver.try_recv().is_err());
    }

    #[test]
    fn removes_empty_channels() {
        let hub = Hub::new(8);
        let first = hub.join(&account("a"));
        let second = hub.join(&account("a"));
        assert_ne!(first.id, second.id);
        hub.leave(&account("a"), first);
        assert_eq!(hub.account_count(), 1);
        hub.leave(&account("a"), second);
        assert_eq!(hub.account_count(), 0);
    }
}
