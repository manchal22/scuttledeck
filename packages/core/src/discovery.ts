import { Octokit } from "@octokit/rest";
import { parse as parseYaml } from "yaml";
import { eq, sql } from "drizzle-orm";
import { repo, workflow, type Db } from "@scuttledeck/db";

/**
 * GitHub has no API to find repos using a given action, so discovery is:
 * list org repos → list .github/workflows files → fetch YAML via the
 * contents API → parse for a claude-code-action step (any owner/fork/ref).
 * Callers should reuse one EtagCache across scans so unchanged files cost
 * conditional requests only (304s don't count against the 5k/hr limit).
 */

const ACTION_REPO_NAMES = new Set(["claude-code-action", "claude-code-base-action"]);

export interface WorkflowHit {
  path: string;
  name: string | null;
  actionRef: string;
  actionVersion: string | null;
  triggers: string[];
  modelConfig: Record<string, unknown> | null;
}

export interface RepoScanResult {
  ghRepoId: number;
  fullName: string;
  defaultBranch: string | null;
  hits: WorkflowHit[];
}

/** Does this `uses:` value point at claude-code-action (any owner, any ref)? */
export function usesClaudeCodeAction(uses: string): boolean {
  const [pathPart] = uses.split("@");
  if (!pathPart) return false;
  const segments = pathPart.split("/").filter(Boolean);
  return segments.some((s) => ACTION_REPO_NAMES.has(s.toLowerCase()));
}

function extractTriggers(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

/** Parse one workflow file; returns null when it doesn't use the action. */
export function parseWorkflowFile(path: string, content: string): WorkflowHit | null {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const root = doc as Record<string, unknown>;

  const jobs = root["jobs"];
  if (!jobs || typeof jobs !== "object") return null;

  for (const job of Object.values(jobs as Record<string, unknown>)) {
    if (!job || typeof job !== "object") continue;
    const steps = (job as Record<string, unknown>)["steps"];
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      const uses = (step as Record<string, unknown>)["uses"];
      if (typeof uses !== "string" || !usesClaudeCodeAction(uses)) continue;

      const at = uses.indexOf("@");
      const with_ = (step as Record<string, unknown>)["with"];
      const modelConfig: Record<string, unknown> = {};
      if (with_ && typeof with_ === "object") {
        for (const [k, v] of Object.entries(with_ as Record<string, unknown>)) {
          if (k.toLowerCase().includes("model")) modelConfig[k] = v;
        }
      }
      // `on` parses as boolean true in YAML 1.1; the yaml package (1.2) keeps it a string key.
      const on = root["on"] ?? root[String(true)];
      return {
        path,
        name: typeof root["name"] === "string" ? (root["name"] as string) : null,
        actionRef: uses,
        actionVersion: at >= 0 ? uses.slice(at + 1) : null,
        triggers: extractTriggers(on),
        modelConfig: Object.keys(modelConfig).length > 0 ? modelConfig : null,
      };
    }
  }
  return null;
}

/** Minimal GitHub surface the scanner needs — injectable for tests. */
export interface DiscoveryClient {
  listRepos(org: string): Promise<Array<{ id: number; full_name: string; default_branch: string | null }>>;
  listWorkflowPaths(owner: string, repoName: string): Promise<string[]>;
  getFileContent(owner: string, repoName: string, path: string): Promise<string | null>;
}

export class EtagCache {
  private etags = new Map<string, string>();
  private bodies = new Map<string, unknown>();
  get(key: string): { etag: string; body: unknown } | undefined {
    const etag = this.etags.get(key);
    return etag === undefined ? undefined : { etag, body: this.bodies.get(key) };
  }
  set(key: string, etag: string | undefined, body: unknown): void {
    if (etag === undefined) return;
    this.etags.set(key, etag);
    this.bodies.set(key, body);
  }
}

export function createOctokitDiscoveryClient(
  octokit: Octokit,
  cache = new EtagCache(),
): DiscoveryClient {
  async function conditionalGet<T>(key: string, fetcher: (etag?: string) => Promise<{ data: T; headers: { etag?: string } }>): Promise<T> {
    const cached = cache.get(key);
    try {
      const res = await fetcher(cached?.etag);
      cache.set(key, res.headers.etag, res.data);
      return res.data;
    } catch (err: unknown) {
      if (cached && (err as { status?: number }).status === 304) return cached.body as T;
      throw err;
    }
  }

  return {
    async listRepos(org) {
      const repos = await octokit.paginate(octokit.repos.listForOrg, {
        org,
        per_page: 100,
      });
      return repos.map((r) => ({
        id: r.id,
        full_name: r.full_name,
        default_branch: r.default_branch ?? null,
      }));
    },

    async listWorkflowPaths(owner, repoName) {
      const key = `${owner}/${repoName}:.github/workflows`;
      try {
        const data = await conditionalGet(key, (etag) =>
          octokit.repos.getContent({
            owner,
            repo: repoName,
            path: ".github/workflows",
            headers: etag ? { "if-none-match": etag } : {},
          }),
        );
        if (!Array.isArray(data)) return [];
        return data
          .filter((f) => f.type === "file" && /\.ya?ml$/.test(f.name))
          .map((f) => f.path);
      } catch (err: unknown) {
        if ((err as { status?: number }).status === 404) return [];
        throw err;
      }
    },

    async getFileContent(owner, repoName, path) {
      const key = `${owner}/${repoName}:${path}`;
      try {
        const data = await conditionalGet(key, (etag) =>
          octokit.repos.getContent({
            owner,
            repo: repoName,
            path,
            headers: etag ? { "if-none-match": etag } : {},
          }),
        );
        if (Array.isArray(data) || !("content" in data) || data.type !== "file") return null;
        return Buffer.from(data.content, "base64").toString("utf8");
      } catch (err: unknown) {
        if ((err as { status?: number }).status === 404) return null;
        throw err;
      }
    },
  };
}

export async function scanOrg(client: DiscoveryClient, org: string): Promise<RepoScanResult[]> {
  const results: RepoScanResult[] = [];
  for (const r of await client.listRepos(org)) {
    const [owner, repoName] = r.full_name.split("/") as [string, string];
    const hits: WorkflowHit[] = [];
    for (const path of await client.listWorkflowPaths(owner, repoName)) {
      const content = await client.getFileContent(owner, repoName, path);
      if (!content) continue;
      const hit = parseWorkflowFile(path, content);
      if (hit) hits.push(hit);
    }
    results.push({
      ghRepoId: r.id,
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      hits,
    });
  }
  return results;
}

/** Persist a scan: upsert repos, flag has_action, upsert discovered workflows. */
export async function persistScan(
  db: Db,
  installationId: number,
  results: RepoScanResult[],
): Promise<void> {
  for (const r of results) {
    const [repoRow] = await db
      .insert(repo)
      .values({
        installationId,
        ghRepoId: r.ghRepoId,
        fullName: r.fullName,
        defaultBranch: r.defaultBranch,
        hasAction: r.hits.length > 0,
      })
      .onConflictDoUpdate({
        target: repo.ghRepoId,
        set: {
          fullName: sql`excluded.full_name`,
          defaultBranch: sql`coalesce(excluded.default_branch, ${repo.defaultBranch})`,
          hasAction: sql`excluded.has_action`,
          updatedAt: sql`now()`,
        },
      })
      .returning();

    for (const hit of r.hits) {
      await db
        .insert(workflow)
        .values({
          repoId: repoRow!.id,
          path: hit.path,
          name: hit.name,
          actionRef: hit.actionRef,
          actionVersion: hit.actionVersion,
          triggers: hit.triggers,
          modelConfig: hit.modelConfig,
          lastScannedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [workflow.repoId, workflow.path],
          set: {
            name: sql`excluded.name`,
            actionRef: sql`excluded.action_ref`,
            actionVersion: sql`excluded.action_version`,
            triggers: sql`excluded.triggers`,
            modelConfig: sql`excluded.model_config`,
            lastScannedAt: sql`now()`,
          },
        });
    }
    // Workflows that disappeared from the repo keep their rows (history), but
    // repo.has_action reflects the latest scan.
    await db
      .update(repo)
      .set({ hasAction: r.hits.length > 0 })
      .where(eq(repo.ghRepoId, r.ghRepoId));
  }
}
