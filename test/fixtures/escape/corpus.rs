static mut COUNTER: u32 = 0;

struct Config {
    retries: u32,
    name: String,
}

impl Config {
    fn bump(&mut self, retries: u32) {
        self.retries = retries;
        self.retries += 1;
    }
}

fn shadow(items: &[u32]) -> u32 {
    let total = 0;
    let mut sum = 0;
    for x in items {
        let total = total + x; // shadowing, not a write
        sum += total;
    }
    // sum = 0 in a comment
    let label = format!("{}", sum);
    println!("{label} {}", total);
    sum
}

fn params(mut retries: u32, cfg: &mut Config) -> u32 {
    retries -= 1;
    cfg.retries = retries;
    let mut name = String::new();
    if retries > 0 {
        name = cfg.name.clone();
        retries = 0;
    }
    let closure = |n: u32| n + retries;
    unsafe { COUNTER += 1; }
    closure(name.len() as u32)
}

fn main() {
    let mut c = Config { retries: 1, name: String::from("x") };
    c.bump(3);
    let r = params(2, &mut c);
    let _ = shadow(&[r]);
}

fn deref(total: &mut u32, items: &mut Vec<u32>) {
    *total += 1;
    items[0] = 2;
    let mut local = 0;
    local += 1;
    let _ = local;
}
