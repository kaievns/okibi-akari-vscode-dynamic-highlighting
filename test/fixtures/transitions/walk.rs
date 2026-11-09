use crate::config::Config;
use super::util;

const LIMIT: usize = 10;

pub struct Loader {
    retries: u32,
}

impl Loader {
    pub fn new(retries: u32) -> Self {
        Self { retries }
    }

    pub fn load(&self, path: &str) -> Result<usize, String> {
        let raw = std::fs::read_to_string(path).unwrap();
        let mut total = 0;
        let sep = "{x} (y)";
        for i in 0..self.retries {
            if raw.len() > LIMIT {
                total += raw.len() * 2 + i as usize;
            }
        }
        println!("{path}: ({total:>8}) [{}] {}", raw.len(), sep);
        Ok(total)
    }
}
