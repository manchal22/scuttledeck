import { z } from "zod";

/**
 * Loose schemas for GitHub webhook payloads: validate only the fields we
 * consume, passthrough the rest. On schema drift we log and skip the
 * delivery — never crash the ingest path.
 */

const actorSchema = z
  .object({ login: z.string().optional() })
  .passthrough()
  .nullish();

export const workflowRunEventSchema = z
  .object({
    action: z.string(),
    workflow_run: z
      .object({
        id: z.number(),
        name: z.string().nullish(),
        path: z.string().nullish(),
        run_attempt: z.number().nullish(),
        event: z.string().nullish(),
        status: z.string().nullish(),
        conclusion: z.string().nullish(),
        html_url: z.string().nullish(),
        head_branch: z.string().nullish(),
        head_sha: z.string().nullish(),
        run_started_at: z.string().nullish(),
        updated_at: z.string().nullish(),
        actor: actorSchema,
        triggering_actor: actorSchema,
        pull_requests: z
          .array(z.object({ number: z.number() }).passthrough())
          .nullish(),
      })
      .passthrough(),
    repository: z
      .object({
        id: z.number(),
        full_name: z.string(),
        default_branch: z.string().nullish(),
      })
      .passthrough(),
    installation: z.object({ id: z.number() }).passthrough().nullish(),
  })
  .passthrough();

export type WorkflowRunEvent = z.infer<typeof workflowRunEventSchema>;
