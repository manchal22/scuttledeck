import { describe, expect, it } from "vitest";
import { extractClaudeMetrics, parseGithubHints } from "../src/otlp.js";
import { otlpMetricsRequestSchema } from "../src/schemas/otlp.js";

const kv = (key: string, stringValue: string) => ({ key, value: { stringValue } });

function tokenPoint(type: string, value: number, sessionId = "sess-1") {
  return {
    attributes: [
      kv("session.id", sessionId),
      kv("type", type),
      kv("model", "claude-sonnet-5"),
    ],
    asDouble: value,
    timeUnixNano: "1752994800000000000",
  };
}

const samplePayload = {
  resourceMetrics: [
    {
      resource: {
        attributes: [
          kv("service.name", "claude-code"),
          kv("github.repo", "acme/api"),
          kv("github.run_id", "16123456789"),
          kv("github.pr_number", "42"),
        ],
      },
      scopeMetrics: [
        {
          scope: { name: "com.anthropic.claude_code" },
          metrics: [
            {
              name: "claude_code.token.usage",
              sum: {
                dataPoints: [
                  tokenPoint("input", 1200),
                  tokenPoint("output", 340),
                  tokenPoint("cacheRead", 9000),
                ],
                aggregationTemporality: 2,
                isMonotonic: true,
              },
            },
            {
              name: "claude_code.cost.usage",
              sum: {
                dataPoints: [
                  {
                    attributes: [kv("session.id", "sess-1"), kv("model", "claude-sonnet-5")],
                    asDouble: 0.42,
                  },
                ],
                aggregationTemporality: 2,
                isMonotonic: true,
              },
            },
            {
              name: "some_other.metric",
              sum: { dataPoints: [{ asDouble: 1 }] },
            },
          ],
        },
      ],
    },
  ],
};

describe("extractClaudeMetrics", () => {
  it("extracts claude_code points with session ids, drops the rest", () => {
    const parsed = otlpMetricsRequestSchema.parse(samplePayload);
    const batches = extractClaudeMetrics(parsed);
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch.resourceAttrs["github.repo"]).toBe("acme/api");
    expect(batch.points).toHaveLength(4);
    const input = batch.points.find((p) => p.attrType === "input")!;
    expect(input.value).toBe(1200);
    expect(input.temporality).toBe("cumulative");
    expect(input.sessionId).toBe("sess-1");
  });

  it("handles asInt values encoded as strings (proto3 JSON int64)", () => {
    const payload = otlpMetricsRequestSchema.parse({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.token.usage",
                  sum: {
                    dataPoints: [
                      {
                        attributes: [kv("session.id", "s"), kv("type", "input")],
                        asInt: "5000",
                      },
                    ],
                    aggregationTemporality: 1,
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const [batch] = extractClaudeMetrics(payload);
    expect(batch!.points[0]!.value).toBe(5000);
    expect(batch!.points[0]!.temporality).toBe("delta");
  });

  it("drops data points without a session.id", () => {
    const payload = otlpMetricsRequestSchema.parse({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.token.usage",
                  sum: { dataPoints: [{ asDouble: 10, attributes: [kv("type", "input")] }] },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(extractClaudeMetrics(payload)).toHaveLength(0);
  });
});

describe("parseGithubHints", () => {
  it("parses run id and pr number as numbers", () => {
    const hints = parseGithubHints({
      "github.repo": "acme/api",
      "github.run_id": "16123456789",
      "github.pr_number": "42",
    });
    expect(hints).toEqual({ repoFullName: "acme/api", ghRunId: 16123456789, prNumber: 42 });
  });

  it("ignores malformed values", () => {
    expect(parseGithubHints({ "github.run_id": "not-a-number" })).toEqual({});
  });
});
