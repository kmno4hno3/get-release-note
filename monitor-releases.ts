#!/usr/bin/env ts-node
import "dotenv/config";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { GoogleGenAI } from "@google/genai";

const execFileAsync = promisify(execFile);

type ReleaseEntry = {
	tag: string;
	name: string;
	url: string;
	body: string;
	reference_kind: "release" | "tag" | "changelog";
	reference_sha?: string;
	default_branch?: string;
	fallback_branch?: string;
	fallback_path?: string;
	published_at?: string;
	has_body: boolean;
};

type PreparedPayload = {
	entry: ReleaseEntry;
	content: string;
	translated: string;
	source: string;
};

type StateFile = {
	last_tag: string;
};

const CONFIG = {
	repositories: parseList(process.env.TARGET_REPOSITORIES).concat(
		parseList(process.env.TARGET_REPOSITORY),
	),
	githubToken: process.env.GITHUB_TOKEN ?? "",
	geminiApiKey: process.env.GEMINI_API_KEY ?? "",
	geminiModel: process.env.GEMINI_MODEL ?? "gemini-1.5-flash",
	mattermostWebhook: process.env.MATTERMOST_WEBHOOK_URL ?? "",
	npmPackageOverride: process.env.NPM_PACKAGE ?? "",
	stateDir: process.env.STATE_DIR ?? path.resolve("release-monitor-state"),
};

const CHANGELOG_PATHS = [
	"CHANGELOG.md",
	"CHANGE.md",
	"docs/CHANGELOG.md",
	"docs/CHANGE.md",
	"CHANGELOG",
	"docs/CHANGELOG",
];

async function main(): Promise<void> {
	if (!CONFIG.mattermostWebhook) {
		throw new Error("MATTERMOST_WEBHOOK_URL is required.");
	}
	const repos = dedupe(CONFIG.repositories);
	if (repos.length === 0) {
		throw new Error(
			"TARGET_REPOSITORIES または TARGET_REPOSITORY が未設定です。",
		);
	}

	await mkdir(CONFIG.stateDir, { recursive: true });

	for (const repo of repos) {
		try {
			console.log(`\n=== ${repo} ===`);
			await processRepository(repo);
		} catch (error) {
			console.error(`[${repo}] Failed:`, error);
		}
	}
}

async function processRepository(repo: string): Promise<void> {
	const slug = slugify(repo);
	const statePath = path.join(CONFIG.stateDir, `${slug}.json`);
	const lastTag = await readState(statePath);

	const entries = await fetchCandidateEntries(repo, CONFIG.githubToken);
	if (entries.length === 0) {
		console.log(`[${repo}] No releases/tags found.`);
		return;
	}

	const newEntries = selectNewEntries(entries, lastTag);
	if (newEntries.length === 0) {
		console.log(`[${repo}] No updates since ${lastTag || "N/A"}.`);
		return;
	}

	console.log(`[${repo}] ${newEntries.length} new release entries detected.`);

	const prepared: PreparedPayload[] = [];
	for (const entry of newEntries) {
		const { content, source } = await resolveContent(repo, entry);
		const translated = await translateIfNeeded(entry, content);
		prepared.push({ entry, content, translated, source });
	}

	for (const payload of prepared) {
		const body = buildMattermostPayload(repo, payload);
		await postMattermost(body);
	}

	const newestTag = entries[0]?.tag ?? lastTag;
	await writeState(statePath, newestTag);
	console.log(`[${repo}] State updated: last_tag=${newestTag}`);
}

function parseList(raw?: string): string[] {
	if (!raw) return [];
	return raw
		.split(/[\s,]+/)
		.map((v) => v.trim())
		.filter(Boolean);
}

function dedupe(list: string[]): string[] {
	return [...new Set(list.map((s) => s.toLowerCase()))];
}

function slugify(repo: string): string {
	return repo
		.replace(/[^0-9a-z_.-]+/gi, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
}

async function readState(statePath: string): Promise<string> {
	try {
		await access(statePath, fsConstants.R_OK);
		const raw = await readFile(statePath, "utf-8");
		const json = JSON.parse(raw) as StateFile;
		return json.last_tag ?? "";
	} catch {
		return "";
	}
}

async function writeState(statePath: string, tag: string): Promise<void> {
	const data: StateFile = { last_tag: tag };
	await writeFile(statePath, JSON.stringify(data, null, 2), "utf-8");
}

async function fetchCandidateEntries(
	repo: string,
	token: string,
): Promise<ReleaseEntry[]> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "release-monitor-script",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	const repoInfo = await githubJson(
		`https://api.github.com/repos/${repo}`,
		headers,
	);
	const defaultBranch =
		(repoInfo.default_branch as string | undefined)?.trim() ?? "";

	const entries: ReleaseEntry[] = [];

	try {
		const releases = await githubJson(
			`https://api.github.com/repos/${repo}/releases?per_page=20`,
			headers,
		);
		if (Array.isArray(releases)) {
			for (const release of releases) {
				const tag = (release.tag_name as string | undefined)?.trim();
				if (!tag) continue;
				entries.push({
					tag,
					name: (release.name as string | undefined)?.trim() || tag,
					url:
						(release.html_url as string | undefined)?.trim() ||
						`https://github.com/${repo}/releases/tag/${tag}`,
					body: (release.body as string | undefined) ?? "",
					reference_kind: "release",
					reference_sha: (
						release.target_commitish as string | undefined
					)?.trim(),
					default_branch:
						(release.target_commitish as string | undefined)?.trim() ||
						defaultBranch,
					fallback_branch: "",
					fallback_path: "",
					published_at: release.published_at,
					has_body: Boolean((release.body as string | undefined)?.trim()),
				});
			}
		}
	} catch (error) {
		console.warn(
			`[${repo}] Failed to fetch releases:`,
			(error as Error).message,
		);
	}

	if (entries.length === 0) {
		try {
			const tags = await githubJson(
				`https://api.github.com/repos/${repo}/tags?per_page=20`,
				headers,
			);
			if (Array.isArray(tags)) {
				for (const tag of tags) {
					const tagName = (tag.name as string | undefined)?.trim();
					if (!tagName) continue;
					const commit = tag.commit ?? {};
					entries.push({
						tag: tagName,
						name: tagName,
						url: `https://github.com/${repo}/tree/${tagName}`,
						body: "",
						reference_kind: "tag",
						reference_sha: (commit.sha as string | undefined)?.trim(),
						default_branch: defaultBranch,
						fallback_branch: defaultBranch,
						fallback_path: "",
						published_at: "",
						has_body: false,
					});
				}
			}
		} catch (error) {
			console.warn(`[${repo}] Failed to fetch tags:`, (error as Error).message);
		}
	}

	if (entries.length === 0 && defaultBranch) {
		for (const changelogPath of CHANGELOG_PATHS) {
			try {
				const commits = await githubJson(
					`https://api.github.com/repos/${repo}/commits?sha=${defaultBranch}&path=${encodeURIComponent(
						changelogPath,
					)}&per_page=5`,
					headers,
				);
				if (!Array.isArray(commits)) continue;
				for (const commit of commits) {
					const sha = (commit.sha as string | undefined)?.trim();
					if (!sha) continue;
					entries.push({
						tag: `changelog-${sha.slice(0, 12)}`,
						name: `${changelogPath} update`,
						url: `https://github.com/${repo}/blob/${defaultBranch}/${changelogPath}`,
						body: "",
						reference_kind: "changelog",
						reference_sha: sha,
						default_branch: defaultBranch,
						fallback_branch: defaultBranch,
						fallback_path: changelogPath,
						published_at: commit.commit?.author?.date,
						has_body: false,
					});
				}
				if (entries.length) break;
			} catch (error) {
				console.warn(
					`[${repo}] Failed changelog commit lookup ${changelogPath}:`,
					(error as Error).message,
				);
			}
		}
	}

	return entries;
}

async function githubJson(
	url: string,
	headers: Record<string, string>,
): Promise<any> {
	const res = await fetch(url, { headers });
	if (!res.ok) {
		const body = await res.text();
		throw new Error(
			`GitHub API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
		);
	}
	return res.json();
}

function selectNewEntries(
	entries: ReleaseEntry[],
	lastTag: string,
): ReleaseEntry[] {
	if (!lastTag) return [...entries].reverse();
	const result: ReleaseEntry[] = [];
	for (const entry of entries) {
		if (entry.tag === lastTag) break;
		result.push(entry);
	}
	return result.reverse();
}

async function resolveContent(
	repo: string,
	entry: ReleaseEntry,
): Promise<{ content: string; source: string }> {
	let content = entry.body?.trim() ?? "";
	let source = content ? "release" : "";

	const needsFallback =
		entry.reference_kind === "release" ? !entry.has_body : !content;

	if (needsFallback) {
		const changelog = await tryFetchChangelog(repo, entry);
		if (changelog) {
			content = changelog.text;
			source = changelog.source;
		}
	}

	if (!content) {
		const npmText = await tryFetchNpm(entry);
		if (npmText) {
			content = npmText.text;
			source = npmText.source;
		}
	}

	if (!content) source = "none";
	return { content, source };
}

async function tryFetchChangelog(
	repo: string,
	entry: ReleaseEntry,
): Promise<{ text: string; source: string } | null> {
	const token = CONFIG.githubToken;
	const headers: Record<string, string> = {
		Accept: "application/vnd.github.raw",
		"User-Agent": "release-monitor-script",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	const paths = entry.fallback_path
		? [
				entry.fallback_path,
				...CHANGELOG_PATHS.filter((p) => p !== entry.fallback_path),
			]
		: CHANGELOG_PATHS;

	const refs = buildRefCandidates(entry);
	for (const filePath of paths) {
		for (const ref of refs) {
			const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(
				filePath,
			)}?ref=${encodeURIComponent(ref)}`;
			try {
				const res = await fetch(url, { headers });
				if (res.status === 404) continue;
				if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
				const text = await res.text();
				const section = extractChangelogSection(text, entry.tag);
				if (section) {
					return { text: section, source: `changelog:${filePath}` };
				}
				if (text.trim()) {
					return { text: maybeTruncate(text), source: `changelog:${filePath}` };
				}
			} catch (error) {
				console.warn(
					`[${repo}] changelog fetch failed (${filePath}@${ref}):`,
					(error as Error).message,
				);
			}
		}
	}
	return null;
}

function buildRefCandidates(entry: ReleaseEntry): string[] {
	const candidates = new Set<string>();
	const tag = entry.tag;
	if (tag) {
		candidates.add(tag);
		if (tag.startsWith("refs/tags/"))
			candidates.add(tag.replace("refs/tags/", ""));
		if (tag.startsWith("v")) candidates.add(tag.slice(1));
	}
	if (entry.reference_sha) candidates.add(entry.reference_sha);
	if (entry.fallback_branch) candidates.add(entry.fallback_branch);
	if (entry.default_branch) candidates.add(entry.default_branch);
	if (!candidates.size) candidates.add("main");
	return [...candidates];
}

function extractChangelogSection(text: string, tag: string): string | null {
	const lines = text.split(/\r?\n/);
	const tagVariants = [
		tag,
		tag.replace(/^v/, ""),
		tag.replace(/^refs\/tags\//, ""),
	]
		.map((v) => v.toLowerCase())
		.filter(Boolean);

	let capturing = false;
	const body: string[] = [];
	let currentLevel = 0;

	for (const line of lines) {
		const headingMatch = line.match(/^\s*(#{1,6})\s+(.*)$/);
		if (headingMatch) {
			const level = headingMatch[1].length;
			const headingText = headingMatch[2]
				.replace(/\[.*?\]\(.*?\)/g, "")
				.toLowerCase();
			if (tagVariants.some((variant) => headingText.includes(variant))) {
				capturing = true;
				currentLevel = level;
				continue;
			}
			if (capturing && level <= currentLevel) {
				break;
			}
		}
		if (capturing) body.push(line);
	}

	const section = body.join("\n").trim();
	return section ? maybeTruncate(section) : null;
}

async function tryFetchNpm(
	entry: ReleaseEntry,
): Promise<{ text: string; source: string } | null> {
	const tag = entry.tag;
	if (!tag) return null;

	const packageName =
		CONFIG.npmPackageOverride ||
		entry.tag.split("/").pop()?.split("@").pop() ||
		"";
	if (!packageName) return null;

	let version = tag.replace(/^refs\/tags\//, "");
	if (version.startsWith("v")) version = version.slice(1);

	try {
		const { stdout } = await execFileAsync(
			"npm",
			["view", `${packageName}@${version}`, "--json"],
			{
				maxBuffer: 5 * 1024 * 1024,
			},
		);
		if (!stdout || stdout.trim() === "null" || stdout.trim() === "undefined") {
			return null;
		}
		const data = JSON.parse(stdout);
		const blocks: string[] = [];

		const description = (Array.isArray(data) ? data[0] : data)?.description;
		if (description) blocks.push(String(description).trim());

		const releaseNotes = (Array.isArray(data) ? data[0] : data)?.releaseNotes;
		if (releaseNotes) blocks.push(String(releaseNotes).trim());

		const readme = (Array.isArray(data) ? data[0] : data)?.readme;
		if (readme) {
			const section = extractChangelogSection(String(readme), entry.tag);
			if (section) blocks.push(section);
		}

		if (blocks.length === 0) return null;
		const text = maybeTruncate(blocks.join("\n\n"));
		return { text, source: `npm:${packageName}@${version}` };
	} catch (error) {
		console.warn(
			`[npm] view ${packageName}@${version} failed:`,
			(error as Error).message,
		);
		return null;
	}
}

function maybeTruncate(text: string, limit = 4000): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit).trimEnd()}\n...`;
}

async function translateIfNeeded(
	entry: ReleaseEntry,
	content: string,
): Promise<string> {
	if (!CONFIG.geminiApiKey) return content;
	if (!content.trim()) return "";

	try {
		const genAI = new GoogleGenAI({
			apiKey: CONFIG.geminiApiKey,
			// Gemini API用の設定
			vertexai: false,
		});
		const modelId = process.env.GEMINI_MODEL || "gemini-2.5-flash";
		const result = await genAI.models.generateContent({
			model: modelId,
			contents: [
				{
					role: "user",
					parts: [
						{
							text: [
								"次のリリースノートを日本語でまとめ直してください。",
								"テンプレートに従いMarkdownで出力します。",
								"",
								"リリースノート",
								"",
								"## 新機能",
								"- 箇条書き...",
								"",
								"## マージされたPR:",
								"- 箇条書き...",
								"",
								"---",
								"### 主な更新点:",
								"- 箇条書き...",
								"",
								"入力テキスト:",
								"-----",
								content,
							].join("\n"),
						},
					],
				},
			],
		});

		const text = result.text?.trim();
		return text || content;
	} catch (error) {
		console.warn(
			`[${entry.tag}] Translation failed:`,
			(error as Error).message,
		);
		return content;
	}
}

function buildMattermostPayload(
	repo: string,
	payload: {
		entry: ReleaseEntry;
		translated: string;
		source: string;
	},
): string {
	const { entry, translated, source } = payload;
	const lines: string[] = [
		`Release \`${entry.tag}\` detected for *${repo}*`,
		`Title: ${entry.name || entry.tag}`,
		`URL: ${entry.url}`,
	];

	const sourceLine = describeSource(source);
	if (sourceLine) lines.push(`情報ソース: ${sourceLine}`);

	lines.push("", "リリースノート");
	lines.push("```markdown", "");
	if (translated.trim()) {
		lines.push(...translated.trim().split(/\r?\n/));
	}
	lines.push("```");

	return JSON.stringify({ text: lines.join("\n") });
}

function describeSource(source: string): string | null {
	if (!source || source === "none") return null;
	if (source === "release") return "GitHub Release";
	if (source.startsWith("changelog:")) return source.replace(/^changelog:/, "");
	if (source.startsWith("npm:")) return source.replace(/^npm:/, "npm ");
	return source;
}

async function postMattermost(payloadJson: string): Promise<void> {
	const res = await fetch(CONFIG.mattermostWebhook, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: payloadJson,
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(
			`Mattermost webhook failed: ${res.status} ${res.statusText} ${body}`,
		);
	}
}

main().catch((error) => {
	console.error("Fatal:", error);
	process.exitCode = 1;
});
