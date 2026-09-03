// CLI argument handling shared by the skills. Split out of fastmail.mjs so the
// parsing rules are testable without the module's top-level CLI dispatch running.
//
// Every function here throws on bad input rather than falling back to a default.
// A silently-defaulted flag is worse than an error for an unattended task: the
// run "succeeds" with the wrong window or the wrong budget and nobody notices.

// Pulls `--key value` and `--flag` out of argv, leaving positionals in order.
// A flag whose value looks like another flag is treated as a bare boolean and
// the next token is left for its own turn.
export function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Everything after a bare "--" is positional. JMAP ids may legitimately
    // begin with a dash, so there has to be a way to pass one.
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { positional, flags };
}

export function intFlag(flags, name, { fallback, min = 1, max }) {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  if (raw === true) throw new Error(`--${name} requires a value`);

  // Number() rather than parseInt: "5x" must be rejected, not silently read as 5.
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`--${name} must be a whole number, got "${raw}"`);
  if (value < min) throw new Error(`--${name} must be at least ${min}, got ${value}`);
  if (max !== undefined && value > max) throw new Error(`--${name} must be at most ${max}, got ${value}`);
  return value;
}

// Accepts an ISO timestamp or a relative "7d" / "36h" so an agent never has to
// do date arithmetic in a shell. Returns a UTC ISO string, which is what JMAP's
// `after` filter takes -- note a bare "2026-09-01" is therefore UTC midnight,
// not local midnight.
export function parseSince(value) {
  if (typeof value !== "string") throw new Error("--since requires a value");

  const relative = /^(\d+)([dh])$/.exec(value);
  if (relative) {
    const ms = Number(relative[1]) * (relative[2] === "d" ? 86_400_000 : 3_600_000);
    const at = Date.now() - ms;
    if (!Number.isFinite(at) || Number.isNaN(new Date(at).getTime())) {
      throw new Error(`--since "${value}" is out of range`);
    }
    return new Date(at).toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid --since "${value}". Use an ISO timestamp (UTC), or a relative form like 7d or 36h.`);
  }
  return parsed.toISOString();
}
