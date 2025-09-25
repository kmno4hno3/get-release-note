#!/usr/bin/env ts-node
import "dotenv/config";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { GoogleGenAI } from "@google/genai";
import * as path from "path";

const execFileAsync = promisify(execFile);

type ReleaseEntry = {
	tag: string;
	name: string;
	url: string;
	body: string;
	reference_kind: "release" | "tag" | "changelog" | "npm";
	reference_sha?: string;
	default_branch?: string;
	fallback_branch?: string;
	fallback_path?: string;
	published_at?: string;
	has_body: boolean;
	version?: string;
	npm_package?: string;
};

type PreparedPayload = {
	entry: ReleaseEntry;
	content: string;
	translated: string;
	source: string;
};

type StateStore = Record<string, string>;

const CONFIG = {
	repositories: parseList(process.env.TARGET_REPOSITORIES),
	geminiApiKey: process.env.GEMINI_API_KEY ?? "",
	geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
	mattermostWebhook: process.env.MATTERMOST_WEBHOOK_URL ?? "",
	npmPackageOverride: process.env.NPM_PACKAGE ?? "",
	npmPackageMap: parseMap(process.env.NPM_PACKAGE_MAP),
	githubToken: process.env.GITHUB_TOKEN,
	skipTlsVerification: parseBoolean(process.env.SKIP_TLS_VERIFY),
};

const STATE_FILE_PATH = path.resolve("state.json");

const CHANGELOG_PATHS = [
	"CHANGELOG.md",
	"CHANGE.md",
	"docs/CHANGELOG.md",
	"docs/CHANGE.md",
	"CHANGELOG",
	"docs/CHANGELOG",
];

if (CONFIG.skipTlsVerification) {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	console.warn(
		"TLS証明書の検証をスキップする設定が有効です。通信経路の安全性が低下します。",
	);
}

const main = async (): Promise<void> => {
	if (!CONFIG.mattermostWebhook) {
		throw new Error("MATTERMOST_WEBHOOK_URL is required.");
	}
	const repos = dedupe(CONFIG.repositories);
	if (repos.length === 0) {
		throw new Error("TARGET_REPOSITORIES が未設定です。");
	}

	const state = await readStateStore(STATE_FILE_PATH);

	for (const repo of repos) {
		try {
			console.log(`\n=== ${repo} ===`);
			const updated = await processRepository(repo, state);
			if (updated) {
				await writeStateStore(STATE_FILE_PATH, state);
			}
		} catch (error) {
			console.error(`[${repo}] Failed:`, error);
		}
	}

	await writeStateStore(STATE_FILE_PATH, state);
};

const processRepository = async (
	repo: string,
	state: StateStore,
): Promise<boolean> => {
	const slug = slugify(repo);
	const lastTag = state[slug] ?? "";

	const entries = await fetchCandidateEntries(repo);
	if (entries.length === 0) {
		console.log(`[${repo}] No releases/tags found.`);
		return false;
	}

	let newEntries = selectNewEntries(entries, lastTag);
	if (newEntries.length === 0) {
		console.log(`[${repo}] No updates since ${lastTag || "N/A"}.`);
		return false;
	}

	await assignNpmVersionsToEntries(repo, newEntries, lastTag);

	const seenVersions = new Set<string>();
	const filteredVersionEntries = newEntries.filter((entry) => {
		const normalized = normalizeVersion(entry.version);
		if (!normalized) return false;
		if (seenVersions.has(normalized)) return false;
		seenVersions.add(normalized);
		return true;
	});
	if (filteredVersionEntries.length > 0) {
		newEntries = filteredVersionEntries;
	}

	console.log(`[${repo}] ${newEntries.length} new release entries detected.`);

	const prepared: PreparedPayload[] = [];
	let previousProcessedTag = lastTag;
	for (const entry of newEntries) {
		const { content, source } = await resolveContent(
			repo,
			entry,
			previousProcessedTag,
		);
		const translated = await translateIfNeeded(entry, content);
		prepared.push({ entry, content, translated, source });
		previousProcessedTag = entry.tag;
	}

	for (const payload of prepared) {
		const body = buildMattermostPayload(repo, payload);
		await postMattermost(body);
	}

	const lastProcessedEntry =
		prepared[prepared.length - 1]?.entry ??
		newEntries[newEntries.length - 1] ??
		entries[0];
	const newestValue =
		lastProcessedEntry?.version ?? lastProcessedEntry?.tag ?? lastTag;
	let stateUpdated = false;

	if (newestValue) {
		stateUpdated = newestValue !== lastTag;
		state[slug] = newestValue;
	} else if (lastTag) {
		delete state[slug];
		stateUpdated = true;
	}

	console.log(`[${repo}] State updated: last_record=${newestValue || ""}`);
	return stateUpdated;
};

function parseList(raw?: string): string[] {
	if (!raw) return [];
	return raw
		.split(/[\s,]+/)
		.map((v) => v.trim())
		.filter(Boolean);
}

function parseBoolean(raw?: string): boolean {
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	if (!normalized) return false;
	return ["1", "true", "yes", "on"].includes(normalized);
}

function parseMap(raw?: string): Record<string, string> {
	if (!raw) return {};
	const trimmed = raw.trim();
	if (!trimmed) return {};
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const map: Record<string, string> = {};
				for (const [key, value] of Object.entries(
					parsed as Record<string, unknown>,
				)) {
					if (typeof value !== "string") continue;
					const repoKey = key.trim().toLowerCase();
					if (!repoKey) continue;
					map[repoKey] = value.trim();
				}
				return map;
			}
		} catch (error) {
			console.warn(
				"Failed to parse NPM_PACKAGE_MAP JSON:",
				(error as Error).message,
			);
		}
	}

	const map: Record<string, string> = {};
	for (const token of trimmed.split(/[\n,]+/)) {
		const item = token.trim();
		if (!item) continue;
		const [repo, pkg] = item.split("=");
		if (!repo || !pkg) continue;
		const repoKey = repo.trim().toLowerCase();
		if (!repoKey) continue;
		map[repoKey] = pkg.trim();
	}
	return map;
}

const dedupe = (list: string[]): string[] => {
	return [...new Set(list.map((s) => s.toLowerCase()))];
};

const slugify = (repo: string): string => {
	return repo
		.replace(/[^0-9a-z_.-]+/gi, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
};

const resolveNpmPackageName = (repo: string): string | null => {
	if (CONFIG.npmPackageOverride?.trim()) {
		return CONFIG.npmPackageOverride.trim();
	}
	const mapped = CONFIG.npmPackageMap[repo.toLowerCase()]?.trim();
	if (mapped) return mapped;
	return null;
};

const extractSemver = (value?: string | null): string | undefined => {
	if (!value) return undefined;
	const match = String(value).match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
	return match ? match[0] : undefined;
};

const normalizeVersion = (value?: string | null): string | null => {
	const version = extractSemver(value);
	return version ? version.toLowerCase() : null;
};

const buildGithubHeaders = (
	accept = "application/vnd.github+json",
): Record<string, string> => {
	const headers: Record<string, string> = {
		Accept: accept,
		"User-Agent": "release-monitor-script",
	};
	if (CONFIG.githubToken) {
		headers.Authorization = `Bearer ${CONFIG.githubToken}`;
	}
	return headers;
};

const readStateStore = async (filePath: string): Promise<StateStore> => {
	try {
		await access(filePath, fsConstants.R_OK);
		const raw = await readFile(filePath, "utf-8");
		const json = JSON.parse(raw);
		if (json && typeof json === "object" && !Array.isArray(json)) {
			return Object.fromEntries(
				Object.entries(json).filter(([, value]) => typeof value === "string"),
			) as StateStore;
		}
	} catch {
		// ignore
	}
	return {};
};

const writeStateStore = async (
	filePath: string,
	state: StateStore,
): Promise<void> => {
	await writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
};

const fetchCandidateEntries = async (repo: string): Promise<ReleaseEntry[]> => {
	const headers = buildGithubHeaders();

	const repoInfo = await githubJson(
		`https://api.github.com/repos/${repo}`,
		headers,
	);
	const defaultBranch =
		(repoInfo.default_branch as string | undefined)?.trim() ?? "";

	const entries: ReleaseEntry[] = [];
	let hasRelease = false;

	try {
		const releases = await githubJson(
			`https://api.github.com/repos/${repo}/releases?per_page=20`,
			headers,
		);
		if (Array.isArray(releases)) {
			for (const release of releases) {
				const tag = (release.tag_name as string | undefined)?.trim();
				if (!tag) continue;
				hasRelease = true;
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
					version: extractSemver(tag),
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
						version: extractSemver(tagName),
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

	if (!hasRelease) {
		const npmEntry = await fetchNpmRegistryEntry(repo, defaultBranch);
		if (npmEntry) {
			const duplicate = entries.some((entry) => {
				if (entry.tag === npmEntry.tag) return true;
				if (!entry.version || !npmEntry.version) return false;
				return entry.version === npmEntry.version;
			});
			if (!duplicate) {
				entries.unshift(npmEntry);
			}
		}
	}

	return entries;
};

const fetchNpmRegistryEntry = async (
	repo: string,
	defaultBranch: string,
): Promise<ReleaseEntry | null> => {
	const packageName = resolveNpmPackageName(repo);
	if (!packageName) return null;

	const info = await fetchNpmRegistryInfo(packageName);
	if (!info) return null;

	const tag = `npm:${packageName}@${info.version}`;
	return {
		tag,
		name: `${packageName}@${info.version}`,
		url: `https://www.npmjs.com/package/${packageName}/v/${info.version}`,
		body: "",
		reference_kind: "npm",
		reference_sha: undefined,
		default_branch: defaultBranch,
		fallback_branch: defaultBranch,
		fallback_path: "CHANGELOG.md",
		published_at: info.publishedAt ?? "",
		has_body: false,
		version: info.version,
		npm_package: packageName,
	};
};

const fetchNpmRegistryInfo = async (
	packageName: string,
): Promise<{ version: string; publishedAt?: string } | null> => {
	try {
		const { stdout } = await execFileAsync(
			"npm",
			["view", packageName, "--json"],
			{
				maxBuffer: 5 * 1024 * 1024,
			},
		);
		if (!stdout || !stdout.trim()) return null;
		const data = JSON.parse(stdout);
		const info = Array.isArray(data) ? data[0] : data;
		const version =
			extractSemver(info?.version) ?? String(info?.version ?? "").trim();
		if (!version) return null;
		const publishedAt =
			info?.time && typeof info.time === "object"
				? (info.time[version] as string | undefined)
				: undefined;
		return { version, publishedAt };
	} catch (error) {
		console.warn(`[npm] view ${packageName} failed:`, (error as Error).message);
		return null;
	}
};

const fetchNpmVersionTimeline = async (
	packageName: string,
): Promise<Array<{ raw: string; normalized: string; timestamp: number }>> => {
	try {
		const { stdout } = await execFileAsync(
			"npm",
			["view", packageName, "time", "--json"],
			{
				maxBuffer: 5 * 1024 * 1024,
			},
		);
		if (!stdout || !stdout.trim()) return [];
		const data = JSON.parse(stdout);
		if (!data || typeof data !== "object") return [];
		const entries: Array<{
			raw: string;
			normalized: string;
			timestamp: number;
		}> = [];
		for (const [version, value] of Object.entries(
			data as Record<string, unknown>,
		)) {
			if (version === "created" || version === "modified") continue;
			if (typeof value !== "string") continue;
			const date = Date.parse(value);
			if (!Number.isFinite(date)) continue;
			const normalized =
				normalizeVersion(version) ?? version.trim().toLowerCase();
			if (!normalized) continue;
			entries.push({
				raw: version.trim(),
				normalized,
				timestamp: date,
			});
		}
		return entries.sort((a, b) => a.timestamp - b.timestamp);
	} catch (error) {
		console.warn(`[npm] time ${packageName} failed:`, (error as Error).message);
		return [];
	}
};

const assignNpmVersionsToEntries = async (
	repo: string,
	entries: ReleaseEntry[],
	lastRecorded: string,
): Promise<void> => {
	const unresolved = entries.filter(
		(entry) => !normalizeVersion(entry.version),
	);
	if (unresolved.length === 0) return;

	const packageName = resolveNpmPackageName(repo);
	if (!packageName) return;

	const timeline = await fetchNpmVersionTimeline(packageName);
	if (timeline.length === 0) return;

	const lastVersion = normalizeVersion(lastRecorded);
	const usedVersions = new Set<string>();
	for (const entry of entries) {
		const normalized =
			normalizeVersion(entry.version) ?? entry.version?.trim().toLowerCase();
		if (normalized) usedVersions.add(normalized);
	}

	let candidateList = timeline;
	if (lastVersion) {
		const lastIndex = timeline.findIndex(
			(item) => item.normalized === lastVersion,
		);
		if (lastIndex >= 0) {
			candidateList = timeline.slice(lastIndex + 1);
		}
	}

	if (candidateList.length === 0) return;

	const filtered = candidateList.filter(
		(item) => !usedVersions.has(item.normalized),
	);
	if (filtered.length === 0) return;

	const needed = unresolved.length;
	const assignableCount = Math.min(filtered.length, needed);
	if (assignableCount === 0) return;

	const selected = filtered.slice(-assignableCount);
	const startIndex = unresolved.length - assignableCount;
	for (let i = 0; i < assignableCount; i += 1) {
		const entry = unresolved[startIndex + i];
		const info = selected[i];
		entry.version = info.raw;
		if (entry.tag.startsWith("changelog-")) {
			entry.tag = info.raw;
		}
		if (!entry.npm_package && packageName) {
			entry.npm_package = packageName;
		}
		entry.name = entry.npm_package
			? `${entry.npm_package}@${info.raw}`
			: info.raw;
		if (entry.npm_package) {
			entry.url = `https://www.npmjs.com/package/${entry.npm_package}/v/${info.raw}`;
		}
		entry.reference_kind = "npm";
		entry.fallback_path = entry.fallback_path ?? "CHANGELOG.md";
		entry.has_body = entry.has_body && Boolean(entry.body?.trim());
		usedVersions.add(info.normalized);
	}
};

const githubJson = async (
	url: string,
	headers: Record<string, string>,
): Promise<any> => {
	const res = await fetch(url, { headers });
	if (!res.ok) {
		const body = await res.text();
		throw new Error(
			`GitHub API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
		);
	}
	return res.json();
};

const isSameRelease = (entry: ReleaseEntry, storedTag: string): boolean => {
	if (!storedTag) return false;
	if (entry.tag === storedTag) return true;
	const storedVersion = normalizeVersion(storedTag);
	if (!storedVersion) return false;
	const candidateVersions = new Set<string>();
	const entryVersion = normalizeVersion(entry.version);
	if (entryVersion) candidateVersions.add(entryVersion);
	const tagVersion = normalizeVersion(entry.tag);
	if (tagVersion) candidateVersions.add(tagVersion);
	return candidateVersions.has(storedVersion);
};

const selectNewEntries = (
	entries: ReleaseEntry[],
	lastTag: string,
): ReleaseEntry[] => {
	if (!lastTag) return [...entries].reverse();
	const result: ReleaseEntry[] = [];
	for (const entry of entries) {
		if (isSameRelease(entry, lastTag)) break;
		result.push(entry);
	}
	return result.reverse();
};

const resolveContent = async (
	repo: string,
	entry: ReleaseEntry,
	previousTag: string,
): Promise<{ content: string; source: string }> => {
	let content = entry.body?.trim() ?? "";
	let source = content ? entry.reference_kind : "";

	if (entry.reference_kind === "release") {
		return {
			content,
			source: content ? "release" : "none",
		};
	}

	const needsFallback = !content;

	if (needsFallback) {
		const changelog = await tryFetchChangelog(repo, entry);
		if (changelog) {
			content = changelog.text;
			source = changelog.source;
		} else {
			const npmResult = await tryResolveViaNpm(repo, entry, previousTag);
			if (npmResult) {
				content = npmResult.text;
				source = npmResult.source;
				if (!entry.version && npmResult.version) {
					entry.version = npmResult.version;
				}
			}
		}
	}

	if (!content) source = "none";
	return { content, source };
};

const tryFetchChangelog = async (
	repo: string,
	entry: ReleaseEntry,
): Promise<{ text: string; source: string } | null> => {
	const headers = buildGithubHeaders("application/vnd.github.raw");

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
				const section = extractChangelogSection(text, entry.tag, entry.version);
				if (section) {
					return { text: section, source: `changelog:${filePath}` };
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
};

const tryResolveViaNpm = async (
	repo: string,
	entry: ReleaseEntry,
	previousTag: string,
): Promise<{ text: string; source: string; version?: string } | null> => {
	const packageName = entry.npm_package ?? resolveNpmPackageName(repo);
	if (!packageName) return null;

	let version = entry.version;
	if (!version) {
		const info = await fetchNpmRegistryInfo(packageName);
		version = info?.version;
	}
	if (!version) return null;

	const augmentedEntry: ReleaseEntry = {
		...entry,
		version,
	};

	if (entry.version !== version) {
		const changelog = await tryFetchChangelog(repo, augmentedEntry);
		if (changelog) {
			return { ...changelog, version };
		}
	}

	const pseudo = await buildPseudoReleaseNotes(
		repo,
		previousTag,
		augmentedEntry,
		version,
	);
	if (pseudo) {
		return { ...pseudo, version };
	}

	return {
		text: `CHANGELOG.md に記載なし (${version})`,
		source: "changelog:none",
		version,
	};
};

const buildRefCandidates = (entry: ReleaseEntry): string[] => {
	const candidates = new Set<string>();
	const tag = entry.tag;
	if (tag) {
		candidates.add(tag);
		if (tag.startsWith("refs/tags/"))
			candidates.add(tag.replace("refs/tags/", ""));
		if (tag.startsWith("v")) candidates.add(tag.slice(1));
	}

	const version = entry.version;
	if (version) {
		candidates.add(version);
		if (!version.startsWith("v")) {
			candidates.add(`v${version}`);
		}
	}

	if (entry.reference_sha) candidates.add(entry.reference_sha);
	if (entry.fallback_branch) candidates.add(entry.fallback_branch);
	if (entry.default_branch) candidates.add(entry.default_branch);
	if (!candidates.size) candidates.add("main");
	return [...candidates];
};

const buildPseudoReleaseNotes = async (
	repo: string,
	previousTag: string,
	entry: ReleaseEntry,
	version: string,
): Promise<{ text: string; source: string } | null> => {
	const headers = buildGithubHeaders();
	const currentRefs = buildRefCandidates(entry).filter(Boolean);
	const previousRefs = previousTag
		? buildRefCandidates({
				...entry,
				tag: previousTag,
				version: extractSemver(previousTag),
			})
		: [];

	let compareResult: any = null;
	if (currentRefs.length && previousRefs.length) {
		compareResult = await fetchFirstSuccessfulCompare(
			repo,
			previousRefs,
			currentRefs,
			headers,
		);
	}

	const lines: string[] = [`CHANGELOG.md に記載なし (${version})`];

	if (compareResult && Array.isArray(compareResult.commits)) {
		const commits = compareResult.commits as Array<{
			sha?: string;
			commit?: { message?: string };
		}>;
		if (commits.length) {
			lines.push("");
			for (const commit of commits.slice(-10)) {
				const sha = (commit.sha ?? "").slice(0, 7);
				const summary = String(commit.commit?.message ?? "")
					.split(/\r?\n/)[0]
					.trim();
				const bullet = sha ? `- ${sha} ${summary}` : `- ${summary}`;
				lines.push(bullet.trim());
			}
			const baseSha =
				compareResult.base_commit?.sha?.slice(0, 7) ||
				previousRefs[0] ||
				"unknown";
			const latestCommit = commits[commits.length - 1];
			const headSha =
				latestCommit?.sha?.slice(0, 7) || currentRefs[0] || "unknown";
			return {
				text: maybeTruncate(lines.join("\n")),
				source: `diff:${baseSha}...${headSha}`,
			};
		}
	}

	const fallbackCommits = await fetchRecentCommits(
		repo,
		entry.default_branch,
		headers,
	);
	if (fallbackCommits.length) {
		lines.push("");
		for (const commit of fallbackCommits) {
			const bullet = commit.sha
				? `- ${commit.sha} ${commit.message}`
				: `- ${commit.message}`;
			lines.push(bullet.trim());
		}
		return {
			text: maybeTruncate(lines.join("\n")),
			source: `commit-log:${entry.default_branch ?? "main"}`,
		};
	}

	return {
		text: lines.join("\n"),
		source: "changelog:none",
	};
};

const fetchFirstSuccessfulCompare = async (
	repo: string,
	previousRefs: string[],
	currentRefs: string[],
	headers: Record<string, string>,
): Promise<any | null> => {
	for (const previousRef of previousRefs) {
		for (const currentRef of currentRefs) {
			const url = `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(
				previousRef,
			)}...${encodeURIComponent(currentRef)}`;
			try {
				return await githubJson(url, headers);
			} catch (error) {
				const message = (error as Error).message;
				if (message.includes("404")) {
					continue;
				}
				console.warn(
					`[${repo}] compare ${previousRef}...${currentRef} failed:`,
					message,
				);
			}
		}
	}
	return null;
};

const fetchRecentCommits = async (
	repo: string,
	branch?: string,
	headers?: Record<string, string>,
): Promise<Array<{ sha: string; message: string }>> => {
	const targetBranch = branch?.trim() || "main";
	try {
		const commits = await githubJson(
			`https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(
				targetBranch,
			)}&per_page=10`,
			headers ?? buildGithubHeaders(),
		);
		if (!Array.isArray(commits)) return [];
		return commits.map((commit) => {
			const sha = String(commit.sha ?? "").slice(0, 7);
			const message = String(commit.commit?.message ?? "")
				.split(/\r?\n/)[0]
				.trim();
			return { sha, message };
		});
	} catch (error) {
		console.warn(
			`[${repo}] commit log fetch failed (${targetBranch}):`,
			(error as Error).message,
		);
		return [];
	}
};

const extractChangelogSection = (
	text: string,
	tag: string,
	version?: string,
): string | null => {
	const lines = text.split(/\r?\n/);
	const identifiers = [tag, version].filter(Boolean) as string[];
	const tagVariants = new Set<string>();

	for (const identifier of identifiers) {
		const trimmed = identifier.trim();
		if (!trimmed) continue;
		const candidates = [
			trimmed,
			trimmed.replace(/^v/, ""),
			trimmed.replace(/^refs\/tags\//, ""),
		];
		if (!trimmed.startsWith("v")) {
			candidates.push(`v${trimmed}`);
		}
		for (const candidate of candidates) {
			const lowered = candidate.toLowerCase();
			if (lowered) tagVariants.add(lowered);
		}
	}

	const variantList = [...tagVariants];

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
			if (
				variantList.length > 0 &&
				variantList.some((variant) => headingText.includes(variant))
			) {
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
};

const maybeTruncate = (text: string, limit = 4000): string => {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit).trimEnd()}\n...`;
};

const translateIfNeeded = async (
	entry: ReleaseEntry,
	content: string,
): Promise<string> => {
	if (!CONFIG.geminiApiKey) return content;
	if (!content.trim()) return "";

	try {
		const genAI = new GoogleGenAI({
			apiKey: CONFIG.geminiApiKey,
			// Gemini API用の設定
			vertexai: false,
		});
		const result = await genAI.models.generateContent({
			model: CONFIG.geminiModel,
			contents: [
				{
					role: "user",
					parts: [
						{
							text: [
								"入力テキストを日本語でまとめ直してください。",
								"テンプレートに従いMarkdown形式で出力してください。",
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
};

const buildMattermostPayload = (
	repo: string,
	payload: {
		entry: ReleaseEntry;
		translated: string;
		source: string;
	},
): string => {
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
};

const describeSource = (source: string): string | null => {
	if (!source || source === "none") return null;
	if (source === "release") return "GitHub Release";
	if (source.startsWith("changelog:")) return source.replace(/^changelog:/, "");
	if (source.startsWith("npm:")) return source.replace(/^npm:/, "npm ");
	return source;
};

const postMattermost = async (payloadJson: string): Promise<void> => {
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
};

main().catch((error) => {
	console.error("Fatal:", error);
	process.exitCode = 1;
});
