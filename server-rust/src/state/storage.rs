//! Pluggable storage abstraction.
//!
//! [`InMemoryStorage`] is the default. Downstream callers can plug in a
//! file- or DB-backed implementation by satisfying [`RevTurbineStorage`].
//!
//! The browser backends (`localStorage` / `sessionStorage`) are deliberately
//! absent — browser-only, and a REQ-14 non-goal for the headless server SDK.
//!
//! Source: revturbine-scaffold/src/core/state/storage.ts

use std::collections::HashMap;

/// Minimal storage interface, mirroring the Web Storage API subset the TS
/// core uses.
///
/// Source: storage.ts:17-21 (RevTurbineStorage)
pub trait RevTurbineStorage {
    /// Read a value, or `None` when the key is absent.
    fn get_item(&self, key: &str) -> Option<String>;
    /// Write a value, replacing any existing one.
    fn set_item(&mut self, key: &str, value: &str);
    /// Delete a key. Absent keys are not an error.
    fn remove_item(&mut self, key: &str);
}

/// Lets a **borrowed** store satisfy the trait, so a caller can share one
/// backing store across several consumers instead of moving it into the first
/// one. Without this, `CapEnforcer<&mut dyn RevTurbineStorage>` does not
/// compile and every consumer needs its own store — which would silently
/// partition the state they are all supposed to see.
impl<T: RevTurbineStorage + ?Sized> RevTurbineStorage for &mut T {
    fn get_item(&self, key: &str) -> Option<String> {
        (**self).get_item(key)
    }
    fn set_item(&mut self, key: &str, value: &str) {
        (**self).set_item(key, value);
    }
    fn remove_item(&mut self, key: &str) {
        (**self).remove_item(key);
    }
}

/// Process-local storage. Data does not persist beyond the current process.
///
/// This is the only backend the headless SDK ships: `LocalRuntime` is
/// stateless and in-memory by design, and injecting durable storage is a
/// deliberate caller decision rather than a default.
///
/// Source: storage.ts:29-43 (InMemoryStorage)
#[derive(Debug, Default)]
pub struct InMemoryStorage {
    store: HashMap<String, String>,
}

impl InMemoryStorage {
    /// An empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl RevTurbineStorage for InMemoryStorage {
    fn get_item(&self, key: &str) -> Option<String> {
        self.store.get(key).cloned()
    }

    fn set_item(&mut self, key: &str, value: &str) {
        self.store.insert(key.to_string(), value.to_string());
    }

    fn remove_item(&mut self, key: &str) {
        self.store.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_values() {
        let mut s = InMemoryStorage::new();
        assert_eq!(s.get_item("k"), None);
        s.set_item("k", "v");
        assert_eq!(s.get_item("k"), Some("v".to_string()));
        s.set_item("k", "v2");
        assert_eq!(s.get_item("k"), Some("v2".to_string()));
        s.remove_item("k");
        assert_eq!(s.get_item("k"), None);
    }

    #[test]
    fn removing_an_absent_key_is_not_an_error() {
        let mut s = InMemoryStorage::new();
        s.remove_item("never-set");
        assert_eq!(s.get_item("never-set"), None);
    }
}
