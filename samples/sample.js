// Sample JavaScript file for exercising the Okibi dynamic focus layer.
// Move the caret into different { } blocks and watch the ember bar + fill.
// Type to flip Survey 構 → Focus 流 → Edit 異 (status bar, bottom-right).

const DEFAULTS = {
  retries: 3,
  tags: { env: "dev" },
};

// A brace in a string or comment must NOT open a block: "}{ not real {"  } { }
function loadConfig(name) {
  const cfg = {
    name,
    retries: DEFAULTS.retries,
    tags: { ...DEFAULTS.tags },
  };

  const label = `range {0..9} for ${name}`; // template braces ignored too
  void label;

  if (cfg.retries > 0) {
    for (let i = 0; i < cfg.retries; i++) {
      // deepest block — caret here should focus THIS for-body
      console.log(`attempt ${i} for ${cfg.name}`);
    }
  }

  return cfg;
}

function summarize(cfgs) {
  return cfgs
    .filter((c) => c.name !== "")
    .map((c) => {
      const times = "x".repeat(c.retries);
      return `${c.name} ${times}`;
    })
    .join("; ");
}

const cfgs = [loadConfig("alpha"), loadConfig("beta")];
console.log(summarize(cfgs));
