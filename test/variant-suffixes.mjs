/**
 * Unit tests for gateway variant-suffix handling: reasoning-effort tiers
 * (-high, -thinking, ...) and channel markers (-highspeed, ...) strip to the
 * base model for catalog lookups, while real model tiers (-flash, -mini,
 * -pro, -lite, ...) never strip.
 *
 * Usage: node test/variant-suffixes.mjs
 */
import { baseModelId, variantLabel } from "../lib/thinking.js";
import { matchModelsDev } from "../lib/modelsdev.js";

let failed = false;
const check = (label, actual, expected) => {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) console.log(`[PASS] ${label}`);
	else { failed = true; console.error(`[FAIL] ${label}\n  got:  ${a}\n  want: ${e}`); }
};

// ---- baseModelId: effort tiers strip ----
check("effort suffix -high strips",
	baseModelId("gemini-3.8-flash-high"), "gemini-3.8-flash");
check("effort suffix -medium strips",
	baseModelId("GLM-5.3-Medium"), "glm-5.3");
check("effort suffix -low strips",
	baseModelId("gpt-5.5-low"), "gpt-5.5");
check("effort suffix -minimal strips",
	baseModelId("o4-minimal"), "o4");
check("effort suffix -thinking strips",
	baseModelId("claude-opus-4-6-thinking"), "claude-opus-4-6");
check("channel suffix -highspeed still strips",
	baseModelId("glm-5.2-highspeed"), "glm-5.2");
check("channel suffix -low-speed still strips",
	baseModelId("glm-5.2-low-speed"), "glm-5.2");
check("namespace + effort suffix strip together",
	baseModelId("google/gemini-3.8-flash-high"), "gemini-3.8-flash");

// ---- baseModelId: real tiers never strip ----
check("tier -flash is not a variant",
	baseModelId("gemini-3.8-flash"), "gemini-3.8-flash");
check("tier -lite is not a variant",
	baseModelId("gemini-3.8-flash-lite"), "gemini-3.8-flash-lite");
check("tier -mini is not a variant",
	baseModelId("glm-4-mini"), "glm-4-mini");
check("tier -pro is not a variant",
	baseModelId("grok-4-pro"), "grok-4-pro");
check("bare effort word is not stripped mid-name",
	baseModelId("highlander"), "highlander");

// ---- variantLabel ----
check("variant label High",
	variantLabel("gemini-3.8-flash-high"), "High");
check("variant label Thinking",
	variantLabel("claude-opus-4-6-thinking"), "Thinking");
check("no variant label on plain id",
	variantLabel("gemini-3.8-flash"), "");
check("no variant label on real tier",
	variantLabel("gemini-3.8-flash-lite"), "");

// ---- matchModelsDev: suffixed gateway ids resolve ----
const catalog = {
	"google/gemini-3.8-flash": { limit: { context: 1048576, output: 65536 } },
	"anthropic/claude-opus-4-6": { limit: { context: 200000, output: 64000 } },
	"zai/glm-5.2": { limit: { context: 131072, output: 16384 } },
};
check("exact id wins before any stripping",
	matchModelsDev(catalog, "google/gemini-3.8-flash")?.limit?.context, 1048576);
check("effort-suffixed id matches the base catalog entry",
	matchModelsDev(catalog, baseModelId("gemini-3.8-flash-high"))?.limit?.context, 1048576);
check("thinking-suffixed claude matches its base entry",
	matchModelsDev(catalog, baseModelId("claude-opus-4-6-thinking"))?.limit?.context, 200000);
check("unknown lite tier does not silently match the base",
	matchModelsDev(catalog, baseModelId("gemini-3.8-flash-lite")), undefined);

process.exit(failed ? 1 : 0);
