// Sample Rust file for exercising the Okibi dynamic focus layer.
// Move the caret into different { } blocks and watch the ember bar + fill.
// Type to flip Survey 構 -> Focus 流 -> Edit 異 (status bar, bottom-right).
//
// What to look for:
//   Focus 流 — data identities tint (locals, params, `self`, captured closure
//     vars). Struct/enum/trait names, field names, method names, and macros
//     stay band-1.
//   Edit 異 — numbers go clay; writes escaping the block get a dashed underline;
//     `.await` cyan. Relaxes to Focus after ~2s.
//   Stability — a binding keeps one hue across sub-blocks and closures.

use std::collections::HashMap;
use std::fmt;

const MAX_RETRIES: u32 = 3;
const DEFAULT_TIMEOUT: u32 = 30;

// field names are band-1; the type name Config is band-1
#[derive(Debug, Clone)]
struct Config {
    name: String,
    retries: u32,
    timeout: u32,
    tags: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Status {
    Pending,
    Active,
    Closed,
}

// trait: method signatures are band-1; impls carry the data
trait Summarize {
    fn summary(&self) -> String;
}

impl Config {
    // `self` is the keyword colour across the impl
    fn new(name: &str) -> Self {
        let mut tags = HashMap::new();
        tags.insert("env".to_string(), "dev".to_string());
        Config {
            name: name.to_string(),
            retries: MAX_RETRIES,
            timeout: DEFAULT_TIMEOUT,
            tags,
        }
    }

    fn with_retries(mut self, retries: u32) -> Self {
        self.retries = retries; // write to a self field
        self
    }
}

impl Summarize for Config {
    fn summary(&self) -> String {
        format!("{} x{} ({}s)", self.name, self.retries, self.timeout)
    }
}

impl fmt::Display for Status {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let label = match self {
            Status::Pending => "pending",
            Status::Active => "active",
            Status::Closed => "closed",
        };
        write!(f, "{}", label)
    }
}

fn load_config(name: &str) -> Config {
    let cfg = Config::new(name);

    if cfg.retries > 0 {
        for i in 0..cfg.retries {
            // deepest block — cfg + i + backoff are the data identities
            let backoff = 1u32 << i;
            println!("attempt {} for {} (backoff={}ms)", i, cfg.name, backoff);
        }
    }

    cfg
}

// closures: captured `prefix` + iterator params keep stable hues
fn summarize(cfgs: &[Config]) -> String {
    let prefix = "cfg";
    cfgs.iter()
        .filter(|c| !c.name.is_empty())
        .map(|c| format!("{}:{} x{}", prefix, c.name, c.retries))
        .collect::<Vec<_>>()
        .join("; ")
}

// generics: T is a type param (band-1); acc/item are data
fn fold<T, F>(cfgs: &[Config], seed: T, reducer: F) -> T
where
    F: Fn(T, &Config) -> T,
{
    let mut acc = seed;
    for item in cfgs {
        acc = reducer(acc, item);
    }
    acc
}

fn main() {
    let cfgs: Vec<Config> = ["alpha", "beta", "gamma"]
        .iter()
        .map(|name| load_config(name))
        .collect();

    let mut total = 0u32;
    for c in &cfgs {
        total += c.retries; // escapes the loop body — writes outer `total`
    }

    let tuned: Vec<Config> = cfgs
        .iter()
        .cloned()
        .map(|c| c.with_retries(5))
        .collect();

    let sum = fold(&tuned, 0u32, |acc, item| acc + item.timeout);

    println!("{}", summarize(&cfgs));
    println!("total_retries={} timeout_sum={}", total, sum);
}
