use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use bytes::Bytes;
use tokio::sync::broadcast;

use crate::auth::AccountId;

pub type ConnectionId = u64;

/// A vault id as sent by clients (a UUID). Only its shape is checked; it is never interpreted.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct VaultId(String);

impl VaultId {
    pub fn parse(raw: &str) -> Option<Self> {
        let valid = (1..=64).contains(&raw.len()) && raw.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        valid.then(|| Self(raw.to_owned()))
    }
}

/// Frames fan out per vault of an account (BR-SEC-04): devices on different vaults of the same
/// Google account never receive each other's packets.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Channel {
    pub account: AccountId,
    pub vault: VaultId,
}

/// One opaque frame fanned out to a channel's other connections.
#[derive(Debug, Clone)]
pub struct Frame {
    pub sender: ConnectionId,
    pub data: Bytes,
}

/// In-memory fanout keyed by channel (account and vault). Holds no history: a restart loses nothing because
/// clients resync by state vector.
pub struct Hub {
    channels: Mutex<HashMap<Channel, broadcast::Sender<Frame>>>,
    /// Open connections per account, across its vaults; bounded so one account cannot hold the
    /// relay's memory (each channel buffers up to `capacity` frames).
    connections: Mutex<HashMap<AccountId, usize>>,
    capacity: usize,
    max_per_account: usize,
    next_connection: AtomicU64,
}

/// A connection's membership in its channel; leaving cleans up the channel.
pub struct Subscription {
    pub id: ConnectionId,
    pub sender: broadcast::Sender<Frame>,
    pub receiver: broadcast::Receiver<Frame>,
}

impl Hub {
    pub fn new(capacity: usize, max_per_account: usize) -> Self {
        Self {
            channels: Mutex::new(HashMap::new()),
            connections: Mutex::new(HashMap::new()),
            capacity: capacity.max(1),
            max_per_account: max_per_account.max(1),
            next_connection: AtomicU64::new(1),
        }
    }

    fn connections(&self) -> std::sync::MutexGuard<'_, HashMap<AccountId, usize>> {
        self.connections.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn channels(&self) -> std::sync::MutexGuard<'_, HashMap<Channel, broadcast::Sender<Frame>>> {
        // The map stays consistent even if a holder panicked: every critical section is one call.
        self.channels.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Joins the channel, or returns None when the account already has its maximum of connections.
    pub fn join(&self, channel: &Channel) -> Option<Subscription> {
        {
            let mut connections = self.connections();
            let open = connections.entry(channel.account.clone()).or_insert(0);
            if *open >= self.max_per_account {
                return None;
            }
            *open += 1;
        }
        let mut channels = self.channels();
        let sender = channels
            .entry(channel.clone())
            .or_insert_with(|| broadcast::channel(self.capacity).0)
            .clone();
        let receiver = sender.subscribe();
        Some(Subscription { id: self.next_connection.fetch_add(1, Ordering::Relaxed), sender, receiver })
    }

    /// Drops the subscription and removes the channel once nobody listens,
    /// so memory doesn't grow with every account ever seen.
    pub fn leave(&self, channel: &Channel, subscription: Subscription) {
        drop(subscription.receiver);
        {
            let mut connections = self.connections();
            if let Some(open) = connections.get_mut(&channel.account) {
                *open -= 1;
                if *open == 0 {
                    connections.remove(&channel.account);
                }
            }
        }
        let mut channels = self.channels();
        if channels.get(channel).is_some_and(|s| s.receiver_count() == 0) {
            channels.remove(channel);
        }
    }

    pub fn channel_count(&self) -> usize {
        self.channels().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str) -> Channel {
        vault(id, "v1")
    }

    fn vault(account: &str, vault: &str) -> Channel {
        Channel { account: AccountId(account.into()), vault: VaultId::parse(vault).unwrap() }
    }

    #[tokio::test]
    async fn fans_out_within_an_account_only() {
        let hub = Hub::new(8, 8);
        let a1 = hub.join(&account("a")).unwrap();
        let mut a2 = hub.join(&account("a")).unwrap();
        let mut b1 = hub.join(&account("b")).unwrap();
        a1.sender.send(Frame { sender: a1.id, data: Bytes::from_static(b"x") }).unwrap();
        let got = a2.receiver.recv().await.unwrap();
        assert_eq!((got.sender, got.data.as_ref()), (a1.id, b"x".as_ref()));
        assert!(b1.receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn separates_vaults_of_the_same_account() {
        let hub = Hub::new(8, 8);
        let work = hub.join(&vault("a", "work")).unwrap();
        let mut personal = hub.join(&vault("a", "personal")).unwrap();
        work.sender.send(Frame { sender: work.id, data: Bytes::from_static(b"x") }).unwrap();
        assert!(personal.receiver.try_recv().is_err());
    }

    #[test]
    fn accepts_only_short_uuid_like_vault_ids() {
        assert!(VaultId::parse("0b6f5c2e-3d1a-4c8e-9f7b-2a1d4e5f6a7b").is_some());
        for bad in ["", "../etc", "a b", "x".repeat(65).as_str()] {
            assert!(VaultId::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn limits_connections_per_account() {
        let hub = Hub::new(8, 2);
        let first = hub.join(&vault("a", "work")).unwrap();
        let _second = hub.join(&vault("a", "personal")).unwrap();
        assert!(hub.join(&vault("a", "work")).is_none());
        // Other accounts are not affected, and leaving frees a place.
        assert!(hub.join(&account("b")).is_some());
        hub.leave(&vault("a", "work"), first);
        assert!(hub.join(&vault("a", "work")).is_some());
    }

    #[test]
    fn removes_empty_channels() {
        let hub = Hub::new(8, 8);
        let first = hub.join(&account("a")).unwrap();
        let second = hub.join(&account("a")).unwrap();
        assert_ne!(first.id, second.id);
        hub.leave(&account("a"), first);
        assert_eq!(hub.channel_count(), 1);
        hub.leave(&account("a"), second);
        assert_eq!(hub.channel_count(), 0);
    }
}
