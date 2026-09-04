//--------------------------------------------------
// feed-builder.mjs
//--------------------------------------------------
// Builds the price feed the game reads. One implementation,
// used by both delivery routes:
//
//   .github/workflows/update-prices.yml   runs this on a cron
//                                         and commits the result
//   tools/skinport-proxy/worker.js        imports it and serves
//                                         it live, if you would
//                                         rather host a Worker
//
// WHY THIS EXISTS AT ALL
// Skinport answers only brotli-encoded requests - every other
// Accept-Encoding gets a 406 - and Roblox HttpService refuses to
// send that header ("Header "Accept-Encoding" is not allowed!").
// So there is no request Roblox can make that Skinport will
// answer, and something has to sit in between.
//
// Run it directly to write the file:
//   node tools/feed-builder.mjs            -> feed/prices.json
//--------------------------------------------------

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";

const CRATES_URL =
	"https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json";
const SKINPORT_URL =
	"https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0";

// Must match CRATE_TYPES in tools/generate-catalog.mjs, or the
// feed carries prices for crates the game does not have.
const CRATE_TYPES = new Set(["Case", "Souvenir"]);

const WEARS = [
	"Factory New",
	"Minimal Wear",
	"Field-Tested",
	"Well-Worn",
	"Battle-Scarred",
];

//--------------------------------------------------
// PRICING
//--------------------------------------------------
// Deliberately identical to tools/generate-catalog.mjs, so the
// live feed and the baked snapshot are the same measurement.
// If you change one, change the other.

// Doppler-style skins share one market_hash_name across very
// differently priced finishes, and both APIs carry the finish
// separately - `phase` upstream, `version` on Skinport. Keying
// on name alone would let Black Pearl's price land on Phase 1.
const marketKey = (name, phase) => `${name} ${phase ?? ""}`;

function priceOf(entry) {
	return entry.min_price ?? entry.suggested_price ?? entry.median_price ?? null;
}

function median(values) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// One price PER WEAR, because a Factory New and a
// Battle-Scarred of the same skin are different items at very
// different prices. Returns { [wearIndex]: usd }, where index 0
// means "no wear" - vanilla knives and the crate containers.
function resolvePrices(market, baseName, phase) {
	const out = {};

	for (let i = 0; i < WEARS.length; i++) {
		const entry = market.get(marketKey(`${baseName} (${WEARS[i]})`, phase));
		if (entry) {
			const v = priceOf(entry);
			if (v != null) out[i + 1] = Math.round(v * 100) / 100;
		}
	}

	const vanilla = market.get(marketKey(baseName, phase));
	if (vanilla) {
		const v = priceOf(vanilla);
		if (v != null) out[0] = Math.round(v * 100) / 100;
	}

	return out;
}

// A single representative number, for the crate containers.
function representative(prices) {
	const values = Object.values(prices);
	if (values.length === 0) return null;
	const result = median(values);
	return result == null ? null : Math.round(result * 100) / 100;
}

//--------------------------------------------------
// FETCH
//--------------------------------------------------

// Node normally decompresses brotli for us, but that is undici's
// behaviour rather than a guarantee, so a raw brotli body is
// still handled. Cloudflare Workers always decompress.
async function fetchSkinport() {
	const res = await fetch(SKINPORT_URL, { headers: { "Accept-Encoding": "br" } });
	if (!res.ok) throw new Error(`skinport -> HTTP ${res.status}`);
	const raw = Buffer.from(await res.arrayBuffer());
	try {
		return JSON.parse(raw.toString("utf8"));
	} catch {
		return JSON.parse(brotliDecompressSync(raw).toString("utf8"));
	}
}

//--------------------------------------------------
// BUILD
//--------------------------------------------------

export async function buildFeed() {
	const [cratesRes, listings] = await Promise.all([
		fetch(CRATES_URL),
		fetchSkinport(),
	]);
	if (!cratesRes.ok) throw new Error(`crates.json -> HTTP ${cratesRes.status}`);
	const allCrates = await cratesRes.json();

	const market = new Map(
		listings.map((i) => [marketKey(i.market_hash_name, i.version), i])
	);

	const skins = {};
	const crates = {};

	// Every crate upstream, priced or not, so the in-game admin
	// panel can spot cases Valve shipped that the build lacks.
	const catalog = {};

	for (const crate of allCrates) {
		if (!CRATE_TYPES.has(crate.type) || !crate.contains?.length) continue;

		catalog[crate.id] = {
			name: crate.name,
			type: crate.type,
			items: crate.contains.length + (crate.contains_rare?.length ?? 0),
		};

		// Souvenir packages hold Souvenir-prefixed listings, which
		// are a different market item to the plain skin.
		const prefix = crate.type === "Souvenir" ? "Souvenir " : "";

		for (const item of [...crate.contains, ...(crate.contains_rare ?? [])]) {
			if (skins[item.id] !== undefined) continue;
			const prices = resolvePrices(market, prefix + item.name, item.phase);
			if (Object.keys(prices).length > 0) skins[item.id] = prices;
		}

		const containerUsd = representative(resolvePrices(market, crate.market_hash_name, null));
		if (containerUsd != null) crates[crate.id] = containerUsd;
	}

	const skinCount = Object.keys(skins).length;
	// A feed with almost nothing in it is a broken upstream, not a
	// market crash. Refuse to produce it rather than overwrite a
	// good file with junk.
	if (skinCount < 500) {
		throw new Error(`only ${skinCount} skins priced; refusing to publish this feed`);
	}

	return {
		generatedAt: Math.floor(Date.now() / 1000),
		currency: "USD",
		skins,
		crates,
		catalog,
	};
}

//--------------------------------------------------
// CLI
//--------------------------------------------------

const isDirectRun = process.argv[1] &&
	resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
	// Relative to wherever it is run from, so this exact file works
	// unchanged both here and at the root of the feed repo.
	const OUT_DIR = join(process.cwd(), "feed");
	const OUT_FILE = join(OUT_DIR, "prices.json");

	const feed = await buildFeed();
	const body = JSON.stringify(feed);

	// Only rewrite when something actually moved, so the workflow
	// does not create an empty commit every two days.
	let previous = null;
	try {
		previous = JSON.parse(await readFile(OUT_FILE, "utf8"));
	} catch {}

	const same =
		previous &&
		JSON.stringify(previous.skins) === JSON.stringify(feed.skins) &&
		JSON.stringify(previous.crates) === JSON.stringify(feed.crates) &&
		JSON.stringify(previous.catalog) === JSON.stringify(feed.catalog);

	if (same) {
		console.log("no price changes; leaving feed/prices.json alone");
		process.exit(0);
	}

	await mkdir(OUT_DIR, { recursive: true });
	await writeFile(OUT_FILE, body, "utf8");

	console.log(
		`wrote feed/prices.json - ${Object.keys(feed.skins).length} skins, ` +
			`${Object.keys(feed.crates).length} crate prices, ` +
			`${Object.keys(feed.catalog).length} crates known, ` +
			`${(body.length / 1024).toFixed(0)} KB`
	);
}
