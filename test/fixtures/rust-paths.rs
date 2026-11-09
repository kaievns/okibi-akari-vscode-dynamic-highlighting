// Path keywords for the detached-file restore: Self, crate and super.
// A Self, crate or super in a comment stays a comment.

mod inner {
    pub fn helper() -> u32 {
        super::BASE + 1
    }

    pub(crate) fn twice(n: u32) -> u32 {
        n * 2
    }
}

use crate::inner::helper;

const BASE: u32 = 40;

#[derive(Debug, Clone, Copy)]
pub struct Counter {
    count: u32,
}

impl Counter {
    pub fn new() -> Self {
        Self { count: helper() }
    }

    pub fn bumped(self) -> Self {
        let label = "Self crate super";
        println!("{} {}", label, self.count);
        Self { count: crate::inner::twice(self.count) }
    }
}

impl Default for Counter {
    fn default() -> Self {
        Self::new()
    }
}

fn main() {
    let c = Counter::new().bumped();
    println!("{}", c.count);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_at_base() {
        assert_eq!(Counter::new().count, super::BASE + 1);
    }
}
