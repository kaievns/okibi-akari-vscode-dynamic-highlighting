// Sample JavaScript file for exercising the Okibi dynamic focus layer.
// Move the caret into different { } blocks and watch the ember bar + fill.
// Type to flip Survey 構 → Focus 流 → Edit 異 (status bar, bottom-right).
//
// What to look for:
//   Focus 流 — data identities tint (locals, params, captured vars, this).
//     Function/method names and builtins (console, Math, JSON) stay band-1.
//   Edit 異 — start typing: await goes cyan, numbers go clay, writes that escape
//     the focused block get a dashed underline; relaxes to Focus after ~2s.
//   Stability — cfg/name keep one hue across the function body, if, for, and
//     nested closures. Object-shorthand { name } tints like the variable.

const DEFAULTS = {
  retries: 3,
  timeout: 30,
  tags: { env: "dev" },
};

const REGISTRY = new Map();
let totalCalls = 0;

// ── plain functions, shorthand, template literals ───────────────────────────

function loadConfig(name) {
  const cfg = {
    name, // object-shorthand read → tints like the `name` parameter
    retries: DEFAULTS.retries,
    tags: { ...DEFAULTS.tags },
  };

  // A brace in a string must NOT open a block: "}{ not real {"  } { }
  const label = `range {0..9} for ${name}`; // template braces ignored
  void label;

  if (cfg.retries > 0) {
    for (let i = 0; i < cfg.retries; i++) {
      const backoff = 2 ** i * 100;
      // deepest block — cfg, i, backoff are the data identities here
      console.log(`attempt ${i} for ${cfg.name} (backoff=${backoff}ms)`);
    }
  }

  return cfg;
}

// summarize: closures over `c` and `acc` keep stable hues across filter/map/reduce.
function summarize(cfgs) {
  const total = cfgs
    .filter((c) => c.name !== "")
    .map((c) => {
      const times = "x".repeat(c.retries);
      return `${c.name} ${times}`;
    })
    .reduce((acc, line, idx) => `${acc}${idx}:${line}; `, "");
  return total;
}

// destructuring params + defaults
function describe({ name, retries = 1, tags = {} }) {
  const envs = Object.keys(tags).join(",");
  return `${name} retries=${retries} envs=[${envs}]`;
}

// ── async / await (band-3 cyan on await when editing) ───────────────────────

async function fetchAll(names) {
  const jobs = names.map(async (name) => {
    const started = Date.now();
    const cfg = await loadConfigAsync(name);
    const elapsed = Date.now() - started;
    return { cfg, elapsed };
  });
  const settled = await Promise.all(jobs);
  return settled;
}

function loadConfigAsync(name) {
  return new Promise((resolve) => {
    // `totalCalls` is a module global — writing it escapes this block.
    totalCalls += 1;
    REGISTRY.set(name, totalCalls);
    setTimeout(() => resolve(loadConfig(name)), 10);
  });
}

// ── class: `this` is the keyword colour; methods are band-1 ──────────────────

class Worker {
  constructor(id) {
    this.id = id;
    this.seen = 0;
    this.errors = [];
  }

  async process(job) {
    this.seen += 1; // write to a this-bound member → escapes the block
    try {
      const result = await fetchAll([job.name]);
      const bytes = result.reduce((sum, r) => sum + r.elapsed, 0);
      if (bytes > 250) {
        this.seen += bytes;
      }
      return bytes;
    } catch (err) {
      this.errors.push(err);
      return -1;
    }
  }

  get score() {
    return this.seen / Math.max(1, this.errors.length);
  }
}

// ── generator + iteration ───────────────────────────────────────────────────

function* pageThrough(items, size) {
  for (let start = 0; start < items.length; start += size) {
    yield items.slice(start, start + size);
  }
}

const cfgs = [loadConfig("alpha"), loadConfig("beta"), loadConfig("gamma")];
const w = new Worker("w-1");

for (const page of pageThrough(cfgs, 2)) {
  console.log(`page of ${page.length}: ${summarize(page)}`);
}

void describe(cfgs[0]);
void w.process({ name: "delta" });
console.log(JSON.stringify({ totalCalls, registry: REGISTRY.size }));
