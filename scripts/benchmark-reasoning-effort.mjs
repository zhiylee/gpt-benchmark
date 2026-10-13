#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import nextEnv from "@next/env";

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    model: "gpt-5.6",
    trials: 1,
    efforts: ["low", "medium"],
    instructions: "",
    timeoutMs: 120_000,
    outputDir: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--base-url" && next) options.baseUrl = next, index += 1;
    else if (value === "--model" && next) options.model = next, index += 1;
    else if (value === "--trials" && next) options.trials = Number(next), index += 1;
    else if (value === "--efforts" && next) options.efforts = next.split(",").map((item) => item.trim()).filter(Boolean), index += 1;
    else if (value === "--instructions" && next) options.instructions = next, index += 1;
    else if (value === "--timeout-ms" && next) options.timeoutMs = Number(next), index += 1;
    else if (value === "--output-dir" && next) options.outputDir = next, index += 1;
    else if (value === "--help") {
      console.log("Usage: OPENAI_API_KEY=... node scripts/benchmark-reasoning-effort.mjs [--base-url URL] [--model gpt-5.6] [--trials 1] [--efforts low,medium] [--instructions text] [--output-dir path]");
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${value}`);
    }
  }

  if (!Number.isInteger(options.trials) || options.trials < 1) throw new Error("--trials must be a positive integer");
  if (!options.efforts.length || options.efforts.some((effort) => !["low", "medium", "high"].includes(effort))) {
    throw new Error("--efforts must contain one or more of: low,medium,high");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) throw new Error("--timeout-ms must be positive");
  return options;
}

function normalizeResponsesUrl(baseUrl) {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (/\/responses$/i.test(normalized)) return normalized;
  return /\/v1$/i.test(normalized) ? `${normalized}/responses` : `${normalized}/v1/responses`;
}

function parseQuestion(raw) {
  const [prompt, rule = ""] = raw.trim().split(/\n---\n/);
  const match = rule.match(/答案正则匹配\s+(.+)/);
  return { prompt: prompt.trim(), passPattern: match?.[1]?.trim() || ".+" };
}

function extractOutput(response) {
  if (response?.output_text) return response.output_text;
  return (response?.output || []).flatMap((item) => {
    if (item.type !== "message") return [];
    return (item.content || []).flatMap((part) => part.type === "output_text" ? [part.text] : []);
  }).join("");
}

function extractReasoningSummary(response) {
  return (response?.output || []).flatMap((item) => {
    if (item.type !== "reasoning") return [];
    const summary = (item.summary || []).map((part) => part.text);
    const reasoningText = (item.content || []).map((part) => part.text);
    return summary.length ? summary : reasoningText;
  }).join("\n");
}

function eventData(frame) {
  const lines = frame.split("\n");
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  if (!data || data === "[DONE]") return null;
  try { return JSON.parse(data); } catch { return null; }
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function stats(values) {
  const present = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!present.length) return { n: 0, mean: null, median: null, min: null, max: null };
  const middle = Math.floor(present.length / 2);
  const median = present.length % 2 ? present[middle] : (present[middle - 1] + present[middle]) / 2;
  return {
    n: present.length,
    mean: round(present.reduce((sum, value) => sum + value, 0) / present.length),
    median: round(median),
    min: present[0],
    max: present.at(-1),
  };
}

function summarize(effort, runs) {
  const completed = runs.filter((run) => run.effort === effort && !run.error);
  return {
    attempts: runs.filter((run) => run.effort === effort).length,
    completed: completed.length,
    passed: completed.filter((run) => run.passed).length,
    passRatePct: completed.length ? round(completed.filter((run) => run.passed).length / completed.length * 100) : null,
    latencyMs: stats(completed.map((run) => run.latencyMs)),
    ttfbMs: stats(completed.map((run) => run.ttfbMs)),
    firstTokenMs: stats(completed.map((run) => run.firstTokenMs)),
    inputTokens: stats(completed.map((run) => run.usage?.input_tokens)),
    outputTokens: stats(completed.map((run) => run.usage?.output_tokens)),
    reasoningTokens: stats(completed.map((run) => run.usage?.output_tokens_details?.reasoning_tokens)),
    totalTokens: stats(completed.map((run) => run.usage?.total_tokens)),
  };
}

function reduction(low, medium, field) {
  const lowValue = low[field]?.mean;
  const mediumValue = medium[field]?.mean;
  if (!Number.isFinite(lowValue) || !Number.isFinite(mediumValue) || mediumValue === 0) return null;
  return round((mediumValue - lowValue) / mediumValue * 100);
}

async function runTrial({ apiKey, endpoint, model, effort, roundNumber, sequence, prompt, instructions, passPattern, timeoutMs, outputDir }) {
  const requestBody = {
    model,
    input: prompt,
    reasoning: { effort, summary: "auto" },
    store: false,
    stream: true,
  };
  if (instructions) requestBody.instructions = instructions;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let response;
  let rawBody = "";
  let ttfbMs = null;
  let firstTokenMs = null;
  let output = "";
  let reasoningSummary = "";
  let reasoningText = "";
  let completedResponse = null;
  const parsedEventTypes = [];
  let error = null;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.body) throw new Error(`HTTP ${response.status}: response body is empty`);
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let pending = "";
    let receivedFirstChunk = false;

    const processFrame = (frame) => {
      const event = eventData(frame);
      if (!event) return;
      parsedEventTypes.push(event.type || "unknown");
      if (["response.output_text.delta", "response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(event.type) && event.delta) {
        if (firstTokenMs == null) firstTokenMs = round(performance.now() - started);
        if (event.type === "response.output_text.delta") output += event.delta;
        else if (event.type === "response.reasoning_summary_text.delta") reasoningSummary += event.delta;
        else reasoningText += event.delta;
      } else if (event.type === "response.completed") {
        completedResponse = event.response;
      } else if (event.type === "response.failed") {
        error = event.response?.error?.message || "Upstream response failed";
      } else if (event.type === "error") {
        error = event.message || "Upstream stream error";
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!receivedFirstChunk) {
        receivedFirstChunk = true;
        ttfbMs = round(performance.now() - started);
      }
      const chunk = decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      rawBody += chunk;
      pending += chunk;
      let boundary;
      while ((boundary = pending.indexOf("\n\n")) !== -1) {
        processFrame(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
      }
    }
    const tail = decoder.decode().replace(/\r\n/g, "\n");
    rawBody += tail;
    pending += tail;
    if (pending.trim()) processFrame(pending);

    if (!response.ok) error ||= `HTTP ${response.status}`;
    if (!output) output = extractOutput(completedResponse);
    if (!reasoningSummary) reasoningSummary = extractReasoningSummary(completedResponse) || reasoningText;
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
  }

  const endedAt = new Date().toISOString();
  const latencyMs = round(performance.now() - started);
  const usage = completedResponse?.usage || null;
  const passed = !error && new RegExp(passPattern, "i").test(output);
  const fileStem = `${String(roundNumber).padStart(2, "0")}-${String(sequence).padStart(2, "0")}-${effort}`;
  const responseHeaders = response ? Object.fromEntries(response.headers.entries()) : {};
  const record = {
    schemaVersion: 1,
    trial: { round: roundNumber, sequence, effort },
    timing: { startedAt, endedAt, ttfbMs, firstTokenMs, latencyMs },
    request: {
      url: endpoint,
      method: "POST",
      headers: { Accept: "text/event-stream", Authorization: "Bearer [REDACTED]", "Content-Type": "application/json" },
      body: requestBody,
    },
    response: {
      status: response?.status ?? null,
      headers: responseHeaders,
      body: rawBody,
      parsedEventTypes,
      completed: completedResponse,
    },
    derived: { passed, passPattern, output, reasoningSummary, usage, error },
  };
  await writeFile(path.join(outputDir, `${fileStem}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return { round: roundNumber, sequence, effort, passed, output, reasoningSummary, usage, ttfbMs, firstTokenMs, latencyMs, error };
}

function markdownReport(metadata, runs, summary) {
  const tableRows = runs.map((run) => `| ${run.round} | ${run.sequence} | ${run.effort} | ${run.error ? "error" : run.passed ? "pass" : "fail"} | ${run.firstTokenMs ?? "-"} | ${run.latencyMs} | ${run.usage?.input_tokens ?? "-"} | ${run.usage?.output_tokens ?? "-"} | ${run.usage?.output_tokens_details?.reasoning_tokens ?? "-"} | ${run.usage?.total_tokens ?? "-"} |`);
  const comparisonRows = ["low", "medium"].map((effort) => {
    const item = summary[effort];
    return `| ${effort} | ${item.passed}/${item.completed} (${item.passRatePct ?? "-"}%) | ${item.firstTokenMs.mean ?? "-"} / ${item.firstTokenMs.median ?? "-"} | ${item.latencyMs.mean ?? "-"} / ${item.latencyMs.median ?? "-"} | ${item.outputTokens.mean ?? "-"} | ${item.reasoningTokens.mean ?? "-"} | ${item.totalTokens.mean ?? "-"} |`;
  });
  return `# Reasoning effort benchmark\n\n` +
    `- Model: \`${metadata.model}\`\n` +
    `- Endpoint: \`${metadata.endpoint}\`\n` +
    `- Trials: ${metadata.trials} per effort, sequential and alternating order\n` +
    `- Prompt source: \`question.md\`\n` +
    `- Pass pattern: \`${metadata.passPattern}\`\n` +
    `- Authorization: redacted from all saved records\n\n` +
    `## Summary\n\n` +
    `| Effort | Passed | First token mean / median (ms) | Total latency mean / median (ms) | Output tokens mean | Reasoning tokens mean | Total tokens mean |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${comparisonRows.join("\n")}\n\n` +
    `Mean reductions for low versus medium: first token ${summary.comparison.lowVsMediumReductionPct.firstTokenMs ?? "n/a"}%, total latency ${summary.comparison.lowVsMediumReductionPct.latencyMs ?? "n/a"}%, output tokens ${summary.comparison.lowVsMediumReductionPct.outputTokens ?? "n/a"}%, reasoning tokens ${summary.comparison.lowVsMediumReductionPct.reasoningTokens ?? "n/a"}%, total tokens ${summary.comparison.lowVsMediumReductionPct.totalTokens ?? "n/a"}%. Positive means low used less or was faster.\n\n` +
    `## Runs\n\n` +
    `| Round | Sequence | Effort | Result | First token (ms) | Total latency (ms) | Input | Output | Reasoning | Total |\n` +
    `| ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${tableRows.join("\n")}\n`;
}

async function main() {
  nextEnv.loadEnvConfig(process.cwd(), true);
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required and is never written to the result files");
  const endpoint = normalizeResponsesUrl(options.baseUrl);
  const { prompt, passPattern } = parseQuestion(await readFile("question.md", "utf8"));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.resolve(options.outputDir || path.join("benchmark-results", `reasoning-effort-${timestamp}`));
  await mkdir(outputDir, { recursive: true });

  const metadata = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    endpoint,
    model: options.model,
    trials: options.trials,
    timeoutMs: options.timeoutMs,
    promptSource: path.resolve("question.md"),
    prompt,
    passPattern,
    authorization: "Bearer [REDACTED]",
  };
  await writeFile(path.join(outputDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);

  const runs = [];
  let sequence = 0;
  for (let roundNumber = 1; roundNumber <= options.trials; roundNumber += 1) {
    const efforts = roundNumber % 2 ? options.efforts : [...options.efforts].reverse();
    for (const effort of efforts) {
      sequence += 1;
      console.log(`Starting ${sequence}/${options.trials * options.efforts.length}: round ${roundNumber}, ${effort}`);
      const run = await runTrial({
        apiKey,
        endpoint,
        model: options.model,
        effort,
        roundNumber,
        sequence,
        prompt,
        instructions: options.instructions,
        passPattern,
        timeoutMs: options.timeoutMs,
        outputDir,
      });
      runs.push(run);
      console.log(`Completed ${sequence}/${options.trials * options.efforts.length}: ${run.error || (run.passed ? "pass" : "fail")}, ${run.latencyMs} ms, ${run.usage?.total_tokens ?? "?"} tokens`);
      await writeFile(path.join(outputDir, "runs.json"), `${JSON.stringify(runs, null, 2)}\n`);
    }
  }

  metadata.endedAt = new Date().toISOString();
  const low = summarize("low", runs);
  const medium = summarize("medium", runs);
  const summary = {
    metadata,
    low,
    medium,
    comparison: {
      lowVsMediumReductionPct: {
        firstTokenMs: reduction(low, medium, "firstTokenMs"),
        latencyMs: reduction(low, medium, "latencyMs"),
        outputTokens: reduction(low, medium, "outputTokens"),
        reasoningTokens: reduction(low, medium, "reasoningTokens"),
        totalTokens: reduction(low, medium, "totalTokens"),
      },
    },
  };
  await writeFile(path.join(outputDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  await writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(path.join(outputDir, "REPORT.md"), markdownReport(metadata, runs, summary));
  console.log(`Results: ${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
