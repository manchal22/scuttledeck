import { z } from "zod";

/**
 * OTLP/HTTP JSON (ExportMetricsServiceRequest), loosely validated.
 * int64 values arrive as strings per the proto3 JSON mapping.
 */

const anyValueSchema = z
  .object({
    stringValue: z.string().optional(),
    intValue: z.union([z.string(), z.number()]).optional(),
    doubleValue: z.number().optional(),
    boolValue: z.boolean().optional(),
  })
  .passthrough();

const keyValueSchema = z.object({
  key: z.string(),
  value: anyValueSchema.optional(),
});

const dataPointSchema = z
  .object({
    attributes: z.array(keyValueSchema).optional(),
    asDouble: z.number().optional(),
    asInt: z.union([z.string(), z.number()]).optional(),
    timeUnixNano: z.union([z.string(), z.number()]).optional(),
    startTimeUnixNano: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const metricSchema = z
  .object({
    name: z.string(),
    unit: z.string().optional(),
    sum: z
      .object({
        dataPoints: z.array(dataPointSchema).default([]),
        aggregationTemporality: z.number().optional(),
        isMonotonic: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    gauge: z
      .object({ dataPoints: z.array(dataPointSchema).default([]) })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const otlpMetricsRequestSchema = z
  .object({
    resourceMetrics: z
      .array(
        z
          .object({
            resource: z
              .object({ attributes: z.array(keyValueSchema).optional() })
              .passthrough()
              .optional(),
            scopeMetrics: z
              .array(
                z
                  .object({ metrics: z.array(metricSchema).default([]) })
                  .passthrough(),
              )
              .default([]),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export type OtlpMetricsRequest = z.infer<typeof otlpMetricsRequestSchema>;
export type OtlpKeyValue = z.infer<typeof keyValueSchema>;
export type OtlpDataPoint = z.infer<typeof dataPointSchema>;
