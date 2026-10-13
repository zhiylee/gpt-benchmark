import { randomUUID } from "node:crypto";
import type { Response, ResponseStreamEvent } from "openai/resources/responses/responses";
import { db, getEnabledQuestions, getRawGroup, getSettings } from "@/lib/db";
import { createOpenAIClient } from "@/lib/openai-client";
import type { RunStatus } from "@/lib/types";

type RunnableGroup = NonNullable<ReturnType<typeof getRawGroup>>;
type RunnableQuestion = ReturnType<typeof getEnabledQuestions>[number];
type Result = {
  output: string; reasoningSummary: string; reasoningText?: string; firstTokenMs: number | null;
  usage: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
};
class IncompleteResponse extends Error {}

function captureResponse(response: Response, result: Result) {
  result.output = response.output_text || response.output.flatMap(item => item.type === "message"
    ? item.content.flatMap(part => part.type === "output_text" ? [part.text] : []) : []).join("") || result.output;
  result.reasoningSummary = response.output.flatMap(item => item.type === "reasoning"
    ? (item.summary.length ? item.summary.map(part => part.text) : item.content?.map(part => part.text) || []) : []).join("\n\n") || result.reasoningSummary;
  result.usage = response.usage ?? result.usage;
}

async function readStream(stream: AsyncIterable<ResponseStreamEvent>, started: number, result: Result, persist: () => void) {
  let completed = false;
  let summaryPart: string | undefined;
  for await (const event of stream) {
    if (event.type === "response.output_text.delta" || event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") {
      if (result.firstTokenMs == null && event.delta) result.firstTokenMs = Date.now() - started;
      if (event.type === "response.output_text.delta") result.output += event.delta;
      else if (event.type === "response.reasoning_summary_text.delta") {
        const part = `${event.item_id}:${event.output_index}:${event.summary_index}`;
        if (summaryPart !== undefined && summaryPart !== part && result.reasoningSummary) result.reasoningSummary += "\n\n";
        summaryPart = part;
        result.reasoningSummary += event.delta;
      }
      else result.reasoningText = (result.reasoningText || "") + event.delta;
      persist();
    } else if (event.type === "response.completed") {
      captureResponse(event.response, result);
      completed = true;
      break;
    } else if (event.type === "response.incomplete") {
      captureResponse(event.response, result);
      throw new IncompleteResponse("生成不完整：" + (event.response.incomplete_details?.reason || "上游提前结束"));
    } else if (event.type === "response.failed") {
      captureResponse(event.response, result);
      throw new Error(event.response.error?.message || "上游生成响应失败");
    } else if (event.type === "error") throw new Error(event.message || "上游流式响应错误");
  }
  if (!completed) throw new IncompleteResponse("生成不完整：未收到完成事件");
}

async function executeQuestion(group: RunnableGroup, question: RunnableQuestion, cancellation: AbortSignal) {
  const reasoningEffort = group.reasoning_effort ?? question.reasoning_effort;
  const id = randomUUID();
  const started = Date.now();
  db.transaction(() => {
    db.prepare("DELETE FROM runs WHERE group_id = ? AND is_demo = 1").run(group.id);
    db.prepare(`INSERT INTO runs (id, group_id, question_id, status, input, output, model, reasoning_effort, streaming, is_demo, created_at)
      VALUES (?, ?, ?, 'running', ?, '', ?, ?, ?, 0, ?)`)
      .run(id, group.id, question.id, question.prompt, group.model, reasoningEffort, group.streaming, new Date(started).toISOString());
  })();
  const result: Result = { output: "", reasoningSummary: "", usage: {}, firstTokenMs: null };
  const { timeoutSeconds } = getSettings();
  const controller = new AbortController();
  const abort = () => controller.abort();
  cancellation.addEventListener("abort", abort, { once: true });
  if (cancellation.aborted) controller.abort();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutSeconds * 1000);
  let lastSaved = 0;
  function save(status: RunStatus, error: string | null = null) {
    db.prepare(`UPDATE runs SET status = ?, output = ?, reasoning_summary = ?, input_tokens = ?, output_tokens = ?,
      reasoning_tokens = ?, first_token_ms = ?, latency_ms = ?, error = ? WHERE id = ?`)
      .run(status, result.output, result.reasoningSummary || result.reasoningText || "", result.usage.input_tokens ?? null, result.usage.output_tokens ?? null,
        result.usage.output_tokens_details?.reasoning_tokens ?? null, result.firstTokenMs, Date.now() - started, error, id);
  }
  try {
    const client = createOpenAIClient(group.base_url, group.api_key || "", timeoutSeconds * 1000);
    const request = { model: group.model, input: question.prompt, reasoning: { effort: reasoningEffort, summary: "auto" as const }, store: false };
    const options = { signal: controller.signal, headers: { "session-id": id } };
    if (group.streaming) {
      const stream = await client.responses.create({ ...request, stream: true }, options);
      await readStream(stream, started, result, () => {
        if (Date.now() - lastSaved >= 1000) { save("running"); lastSaved = Date.now(); }
      });
    } else {
      const response = await client.responses.create({ ...request, stream: false }, options);
      captureResponse(response, result);
      if (response.status === "failed") throw new Error(response.error?.message || "上游生成响应失败");
      if (response.status !== "completed") throw new IncompleteResponse("生成不完整：" + (response.incomplete_details?.reason || response.status));
    }
    controller.signal.throwIfAborted();
    const status = new RegExp(question.pass_pattern, "i").test(result.output) ? "passed" : "failed";
    save(status);
    return { id, status };
  } catch (error) {
    const isTimeout = timedOut || (error instanceof Error && error.name === "APIConnectionTimeoutError");
    const status: RunStatus = cancellation.aborted ? "cancelled" : isTimeout ? "error" : error instanceof IncompleteResponse ? "incomplete" : "error";
    const message = cancellation.aborted ? "管理员已取消检测" : isTimeout ? `请求超时（${timeoutSeconds} 秒）` : error instanceof Error ? error.message : "未知检测错误";
    save(status, message);
    return { id, status, error: message };
  } finally {
    clearTimeout(timeout);
    cancellation.removeEventListener("abort", abort);
  }
}

// Both manual and scheduled runs enter through the shared job worker.
export async function executeGroup(groupId: string, questionIds: string[], signal: AbortSignal, progress: (completed: number, question: string | null) => void) {
  const group = getRawGroup(groupId);
  if (!group?.api_key) throw new Error("分组不存在或未配置 API Key");
  let completed = 0;
  for (const id of questionIds) {
    if (signal.aborted) break;
    const question = db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as RunnableQuestion | undefined;
    if (!question) throw new Error("排队期间检测题已删除，请重新运行");
    progress(completed, question.name);
    await executeQuestion(group, question, signal);
    if (!signal.aborted) completed += 1;
    progress(completed, null);
  }
}
