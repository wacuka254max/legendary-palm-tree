/**
 * UPTICK — move the site to a different origin.
 *
 *   node tools/set-domain.mjs https://www.uptick.example
 *
 * Almost nothing on this site cares what it is served from: deriv.js builds
 * the OAuth redirect out of location.origin, and every asset path is relative.
 * The MT5 automation is the exception, and it has to be — the Expert Advisor
 * is a file somebody downloads and compiles into their own terminal, so the
 * address it calls home on is baked into it at the moment they take it. It
 * cannot ask the page where it came from.
 *
 * That address appears six times: once in the install instructions and five
 * times in the .mq5. Two of the five are in messages that only print when
 * something has already gone wrong — exactly the ones a person editing by
 * hand skips, and exactly the ones somebody reads when they are already
 * stuck. So this does all six at once and then proves none were missed.
 *
 * The instruction on the page is a literal rather than location.origin on
 * purpose. What MT5 needs whitelisted is the host the EA CALLS, which is not
 * always the host the reader is looking at — on a preview deployment those
 * differ, and a page that confidently names the wrong one sends somebody off
 * to whitelist a host their bot will never contact.
 *
 * Existing downloads keep working after a switch: Vercel keeps the
 * .vercel.app alias serving alongside a custom domain, so a terminal already
 * polling the old address carries on. Only new downloads take the new one.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Files that name the origin, and how many times each should. */
const FILES = ["mt5.html", "mt5/UptickMT5.mq5"];

/** The banner in the .mq5 is a drawn box; its lines are this wide between
 *  the opening "//|" and the closing "|". A longer host would push the edge
 *  out of true, so those lines are re-padded after the swap. */
const BANNER_W = 67;

const die = (msg) => { console.error("✗ " + msg); process.exit(1); };

const next = process.argv[2];
if (!next) die("usage: node tools/set-domain.mjs https://www.example.com");
if (!/^https:\/\/[a-z0-9.-]+[a-z0-9]$/i.test(next)) {
  die(`"${next}" is not an origin. Wanted https://host with no trailing slash and no path.`);
}

/* The address the bot actually calls is the one that matters, so that is the
   one taken as current — not a guess, and not a second constant to keep in
   step with it. */
const ea = readFileSync(join(ROOT, "mt5/UptickMT5.mq5"), "utf8");
const found = ea.match(/string\s+g_base\s*=\s*"(https:\/\/[^/"]+)\//);
if (!found) die("could not find g_base in mt5/UptickMT5.mq5 — has the EA changed?");
const current = found[1];

if (current === next) die(`already on ${next} — nothing to do.`);

console.log(`  ${current}\n→ ${next}\n`);

let total = 0;
for (const rel of FILES) {
  const path = join(ROOT, rel);
  const before = readFileSync(path, "utf8");
  const hits = before.split(current).length - 1;
  if (!hits) { console.log(`  ${rel}: no mention — skipped`); continue; }

  // Line by line, so that the re-padding below can only ever reach a line the
  // host actually appears on. Done over the whole file it also "tidied" the
  // section-header boxes further down the .mq5, which are a different width
  // and nobody's business here.
  const after = before.split("\n").map((line) => {
    if (!line.includes(current)) return line;
    const swapped = line.split(current).join(next);

    // A banner line is a drawn box; the new host length moves its right edge.
    const box = swapped.match(/^(\/\/\|)(.*?)(\s*)(\|)(\r?)$/);
    if (!box) return swapped;
    const inner = box[2];
    if (inner.length > BANNER_W) return swapped; // too long to pad — left visible
    return box[1] + inner + " ".repeat(BANNER_W - inner.length) + box[4] + box[5];
  }).join("\n");

  writeFileSync(path, after, "utf8");
  total += hits;
  console.log(`  ${rel}: ${hits} ${hits === 1 ? "mention" : "mentions"}`);
}

/* Proof, rather than a hope. */
const stale = FILES.filter((rel) => readFileSync(join(ROOT, rel), "utf8").includes(current));
if (stale.length) die(`still mentions ${current}: ${stale.join(", ")}`);

console.log(`\n✓ ${total} updated, nothing left pointing at the old host.\n`);
console.log("Still to do by hand — none of it lives in this repo:\n");
console.log(`  1. Deriv app settings: add ${next}/home.html as a redirect URL.`);
console.log("     Leave the old one in place until nobody is arriving on it.");
console.log(`  2. vercel.json: redirect the bare .vercel.app host to ${next},`);
console.log("     the way evietrader.site does, so one address is canonical.");
console.log("  3. robots.txt: add the Sitemap line it is waiting for, and give");
console.log("     the front door a canonical.");
console.log("\nAnyone already running the EA is unaffected — the .vercel.app");
console.log("address keeps serving, so their bot keeps polling happily.");
