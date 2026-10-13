"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileQuestion,
  KeyRound,
  Loader2,
  LogOut,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  X,
} from "lucide-react";
import type { AdminData, Group, Question, Job } from "@/lib/types";
import { DEFAULT_SETTINGS, REASONING_LEVELS, type BenchmarkSettings } from "@/lib/settings";

type Editor = { type: "group"; item?: Group } | { type: "question"; item?: Question } | null;

async function readError(response: Response) {
  const payload = await response.json().catch(() => ({}));
  return payload.error || "操作失败，请稍后重试";
}

export function AdminConsole() {
  const [auth, setAuth] = useState<"loading" | "signed-out" | "signed-in">("loading");
  const [data, setData] = useState<AdminData>({ groups: [], questions: [], settings: DEFAULT_SETTINGS });
  const [activeTab, setActiveTab] = useState<"groups" | "questions">("groups");
  const [editor, setEditor] = useState<Editor>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsError, setJobsError] = useState("");
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const loadConfig = useCallback(async () => {
    const response = await fetch("/api/admin/config", { cache: "no-store" });
    if (response.status === 401) {
      setAuth("signed-out");
      return;
    }
    if (!response.ok) {
      setToast({ type: "error", message: await readError(response) });
      setAuth("signed-out");
      return;
    }
    setData(await response.json());
    setAuth("signed-in");
  }, []);

  useEffect(() => { void loadConfig().catch(() => { setAuth("signed-out"); setToast({ type: "error", message: "读取配置失败，请检查网络" }); }); }, [loadConfig]);

  const loadJobs = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/run", { cache: "no-store" });
      if (response.status === 401) { setAuth("signed-out"); return; }
      if (!response.ok) throw new Error(await readError(response));
      setJobs((await response.json()).jobs);
      setJobsError("");
    } catch { setJobsError("任务状态刷新失败，正在重试"); }
  }, []);
  useEffect(() => {
    if (auth !== "signed-in") return;
    void loadJobs();
    const timer = window.setInterval(() => void loadJobs(), 2000);
    return () => window.clearInterval(timer);
  }, [auth, loadJobs]);

  function notify(type: "success" | "error", message: string) {
    setToast({ type, message });
    window.setTimeout(() => setToast(null), 3600);
  }

  async function login(key: string) {
    const response = await fetch("/api/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!response.ok) throw new Error(await readError(response));
    await loadConfig();
  }

  async function logout() {
    try {
      const response = await fetch("/api/admin/session", { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      setAuth("signed-out");
    } catch { notify("error", "退出失败，请检查网络后重试"); }
  }

  async function remove(type: "groups" | "questions", id: string, name: string) {
    if (!window.confirm(`确定删除“${name}”吗？相关检测记录也会一并删除。`)) return;
    try {
      const response = await fetch(`/api/admin/${type}/${id}`, { method: "DELETE" });
      if (!response.ok) return notify("error", await readError(response));
      notify("success", "已删除");
      await loadConfig();
    } catch { notify("error", "删除失败，请检查网络后重试"); }
  }

  async function run(groupId?: string) {
    setRunning(groupId || "all");
    try {
      const response = await fetch("/api/admin/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId }),
    });
      if (!response.ok) throw new Error(await readError(response));
      notify("success", "检测已加入后台队列，重复任务会自动合并");
      await loadJobs();
    } catch (error) { notify("error", error instanceof Error ? error.message : "提交失败"); }
    finally { setRunning(null); }
  }

  async function cancel(id: string) {
    try {
      const response = await fetch(`/api/admin/run/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      notify("success", "已请求取消任务");
      await loadJobs();
    } catch (error) { notify("error", error instanceof Error ? error.message : "取消失败"); }
  }

  if (auth === "loading") {
    return <div className="center-screen"><Loader2 className="spin" size={24} /><span>正在读取配置</span></div>;
  }

  if (auth === "signed-out") return <LoginScreen onLogin={login} />;

  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <div className="admin-brand">
          <span className="brand-mark"><BrainCircuit size={20} /></span>
          <div><strong>GPT 智商检测台</strong><span>控制台</span></div>
        </div>
        <div className="admin-header-actions">
          <Link className="button button-ghost button-sm" href="/"><ArrowLeft size={15} /> 公开页</Link>
          <button className="icon-button" onClick={() => void logout()} aria-label="退出管理" title="退出管理"><LogOut size={17} /></button>
        </div>
      </header>

      <main className="admin-container">
        <section className="admin-title-row">
          <div>
            <div className="eyebrow"><KeyRound size={14} /> ADMIN CONSOLE</div>
            <h1>检测配置</h1>
            <p>管理模型分组、访问凭据和检测题。</p>
          </div>
          {activeTab === "groups" && (
            <button className="button button-dark" disabled={running !== null} onClick={() => void run()}>
              {running === "all" ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
              运行全部
            </button>
          )}
        </section>

        <details className="settings-disclosure"><summary>检测设置 <span>超时 {data.settings.timeoutSeconds} 秒 · 并发 {data.settings.maxConcurrentGroups} 组</span></summary><SettingsCard settings={data.settings} onSaved={async () => { await loadConfig(); notify("success", "检测设置已保存"); }} /></details>

        <section className="admin-section jobs-card" aria-label="检测任务">
          <div className="section-toolbar"><div><h2>检测任务</h2><p>关闭页面后继续执行</p></div><span className="job-counts">运行中 {jobs.filter(j => j.status === "running").length} · 排队 {jobs.filter(j => j.status === "queued").length}</span></div>
          {jobsError && <p className="form-error" role="alert">{jobsError}</p>}
          {jobs.filter(j => j.status === "running" || j.status === "queued").map(job => <JobRow key={job.id} job={job} onCancel={cancel} />)}
          {!jobs.some(j => j.status === "running" || j.status === "queued") && <p className="jobs-idle">当前没有进行中的任务</p>}
          {jobs.some(j => j.status !== "running" && j.status !== "queued") && <details className="job-history"><summary>已结束任务（{jobs.filter(j => j.status !== "running" && j.status !== "queued").length}）</summary>{jobs.filter(j => j.status !== "running" && j.status !== "queued").map(job => <JobRow key={job.id} job={job} onCancel={cancel} />)}</details>}
        </section>

        <div className="admin-tabs" role="tablist">
          <button className={activeTab === "groups" ? "active" : ""} onClick={() => setActiveTab("groups")}>
            <Server size={16} /> 模型分组 <span>{data.groups.length}</span>
          </button>
          <button className={activeTab === "questions" ? "active" : ""} onClick={() => setActiveTab("questions")}>
            <FileQuestion size={16} /> 检测题 <span>{data.questions.length}</span>
          </button>
        </div>

        {activeTab === "groups" ? (
          <section className="admin-section">
            <div className="section-toolbar">
              <div><h2>模型分组</h2><p>闲时固定为每日 00:00–08:00。</p></div>
              <button className="button button-outline" onClick={() => setEditor({ type: "group" })}><Plus size={16} /> 新增分组</button>
            </div>
            <div className="data-table-wrap">
              <table className="data-table group-table">
                <thead><tr><th>分组</th><th>模型</th><th>倍率</th><th>调用</th><th>检测频率</th><th>闲时频率</th><th>凭据</th><th>状态</th><th><span className="sr-only">操作</span></th></tr></thead>
                <tbody>
                  {data.groups.map((group) => (
                    <tr key={group.id}>
                      <td><div className="model-name"><span className="model-avatar">{group.name.slice(0, 1).toUpperCase()}</span><div><strong>{group.name}</strong><small>{group.baseUrl}</small></div></div></td>
                      <td data-label="模型"><code className="model-id">{group.model}</code><small className="group-setting">思考强度：{group.reasoningEffort ?? "按题目设置"}</small></td>
                      <td data-label="倍率"><span className="mono-value">{group.multiplier}x</span></td>
                      <td data-label="调用"><span className={`call-mode ${group.streaming ? "stream" : "single"}`}>{group.streaming ? "流式" : "非流式"}</span></td>
                      <td data-label="常规频率">{group.intervalMinutes} 分钟</td>
                      <td data-label="闲时频率">{group.idleIntervalMinutes} 分钟</td>
                      <td data-label="凭据">{group.apiKeyConfigured ? <span className="credential yes"><Check size={13} /> 已配置</span> : <span className="credential no"><CircleAlert size={13} /> 未配置</span>}</td>
                      <td data-label="状态"><span className={`enabled-label ${group.enabled ? "on" : "off"}`}><i /> {group.enabled ? "已启用" : "已停用"}</span><small className="group-setting">{group.isPublic ? "公开" : "仅管理员"}</small></td>
                      <td>
                        <div className="table-actions">
                          <button className="icon-button small" disabled={!group.apiKeyConfigured || running !== null} onClick={() => void run(group.id)} aria-label={`运行 ${group.name}`} title="立即检测">
                            {running === group.id ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
                          </button>
                          <button className="icon-button small" onClick={() => setEditor({ type: "group", item: group })} aria-label={`编辑 ${group.name}`} title="编辑"><Pencil size={15} /></button>
                          <button className="icon-button small danger" onClick={() => void remove("groups", group.id, group.name)} aria-label={`删除 ${group.name}`} title="删除"><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.groups.length === 0 && <div className="empty-state">还没有分组。</div>}
            </div>
          </section>
        ) : (
          <section className="admin-section">
            <div className="section-toolbar">
              <div><h2>检测题</h2><p>模型输出命中正则表达式时判定为通过。</p></div>
              <button className="button button-outline" onClick={() => setEditor({ type: "question" })}><Plus size={16} /> 新增检测题</button>
            </div>
            <div className="question-list">
              {data.questions.map((question) => (
                <article className="question-row" key={question.id}>
                  <div className="question-index"><FileQuestion size={18} /></div>
                  <div className="question-content">
                    <div className="question-heading"><strong>{question.name}</strong><span className={`enabled-label ${question.enabled ? "on" : "off"}`}><i /> {question.enabled ? "已启用" : "已停用"}</span></div>
                    <p>{question.prompt}</p>
                    <div className="question-meta"><span>思考强度 <b>{question.reasoningEffort}</b></span><span>匹配 <code>{question.passPattern}</code></span></div>
                  </div>
                  <div className="table-actions">
                    <button className="icon-button small" onClick={() => setEditor({ type: "question", item: question })} aria-label={`编辑 ${question.name}`} title="编辑"><Pencil size={15} /></button>
                    <button className="icon-button small danger" onClick={() => void remove("questions", question.id, question.name)} aria-label={`删除 ${question.name}`} title="删除"><Trash2 size={15} /></button>
                  </div>
                </article>
              ))}
              {data.questions.length === 0 && <div className="empty-state">还没有检测题。</div>}
            </div>
          </section>
        )}
      </main>

      {editor?.type === "group" && <GroupEditor item={editor.item} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); notify("success", "分组已保存"); await loadConfig(); }} />}
      {editor?.type === "question" && <QuestionEditor item={editor.item} onClose={() => setEditor(null)} onSaved={async () => { setEditor(null); notify("success", "检测题已保存"); await loadConfig(); }} />}
      {toast && <div className={`toast ${toast.type}`}>{toast.type === "success" ? <Check size={16} /> : <CircleAlert size={16} />}{toast.message}</div>}
    </div>
  );
}

function JobRow({ job, onCancel }: { job: Job; onCancel: (id: string) => Promise<void> }) {
  return <div className="job-row">
    <div><strong>{job.groupName}</strong><small>{job.currentQuestion || job.error || ({ queued: "排队中", running: "检测中", completed: "已结束，请查看检测结果", cancelled: "已取消", interrupted: "已中断", error: "执行异常" })[job.status]}</small></div>
    <span>{job.completed}/{job.total}</span><progress value={job.completed} max={job.total} aria-label={`${job.groupName} 检测进度`} />
    {(job.status === "queued" || job.status === "running") && <button className="button button-ghost button-sm" onClick={() => void onCancel(job.id)}>取消任务</button>}
  </div>;
}

function SettingsCard({ settings, onSaved }: { settings: BenchmarkSettings; onSaved: () => Promise<void> }) {
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(settings.timeoutSeconds));
  const [concurrency, setConcurrency] = useState(String(settings.maxConcurrentGroups));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setTimeoutSeconds(String(settings.timeoutSeconds)), [settings.timeoutSeconds]);
  useEffect(() => setConcurrency(String(settings.maxConcurrentGroups)), [settings.maxConcurrentGroups]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/config", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeoutSeconds: Number(timeoutSeconds), maxConcurrentGroups: Number(concurrency) }),
      });
      if (!response.ok) throw new Error(await readError(response));
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally { setSaving(false); }
  }

  return <section className="admin-section settings-card">
    <div className="section-toolbar"><div><h2><Clock3 size={16} /> 检测设置</h2><p>应用于保存后开始的检测，流式和非流式共用此超时。</p></div></div>
    <form className="settings-form" onSubmit={submit}>
      <label><span className="field-label">单题超时时间（秒）</span><input className="input" type="number" min="1" max="86400" step="1" required value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(event.target.value)} /></label>
      <label><span className="field-label">最大并发分组数</span><input className="input" type="number" min="1" max="16" step="1" required value={concurrency} onChange={event => setConcurrency(event.target.value)} /></label>
      <button className="button button-dark" disabled={saving}>{saving && <Loader2 size={16} className="spin" />}保存设置</button>
      {error && <div className="form-error" role="alert">{error}</div>}
    </form>
  </section>;
}

function LoginScreen({ onLogin }: { onLogin: (key: string) => Promise<void> }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try { await onLogin(key); } catch (err) { setError(err instanceof Error ? err.message : "登录失败"); }
    finally { setLoading(false); }
  }

  return (
    <div className="login-page">
      <Link className="login-back" href="/"><ArrowLeft size={16} /> 返回公开页</Link>
      <form className="login-panel" onSubmit={submit}>
        <span className="login-icon"><KeyRound size={24} /></span>
        <h1>管理控制台</h1>
        <p>输入访问密钥以管理检测配置。</p>
        <label className="field-label" htmlFor="admin-key">访问密钥</label>
        <input id="admin-key" className="input" type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder="请输入访问密钥" autoFocus required />
        {error && <div className="form-error"><CircleAlert size={14} /> {error}</div>}
        <button className="button button-dark button-full" disabled={loading}>
          {loading ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />}
          进入控制台
        </button>
        <small className="login-hint">访问密钥由 ADMIN_KEY 环境变量配置。</small>
      </form>
    </div>
  );
}

function ModalFrame({ title, description, onClose, children }: { title: string; description: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="form-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header"><div><h2>{title}</h2><p>{description}</p></div><button className="icon-button" onClick={onClose} aria-label="关闭" title="关闭"><X size={18} /></button></div>
        {children}
      </div>
    </div>
  );
}

function GroupEditor({ item, onClose, onSaved }: { item?: Group; onClose: () => void; onSaved: () => Promise<void> }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [enabled, setEnabled] = useState(item?.enabled ?? true);
  const [streaming, setStreaming] = useState(item?.streaming ?? true);
  const [isPublic, setIsPublic] = useState(item?.isPublic ?? true);
  const [model, setModel] = useState(item?.model ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsMessage, setModelsMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function loadModels() {
    if (!formRef.current) return;
    const values = new FormData(formRef.current);
    setModelsLoading(true);
    setModels([]);
    setModelsMessage("");
    try {
      const response = await fetch("/api/admin/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupId: item?.id,
          baseUrl: values.get("baseUrl"),
          apiKey: values.get("apiKey"),
        }),
      });
      if (!response.ok) return setModelsMessage(await readError(response));
      const payload = await response.json() as { models: string[] };
      setModels(payload.models);
      setModelsMessage(`已读取 ${payload.models.length} 个模型`);
      if (!model && payload.models[0]) setModel(payload.models[0]);
    } catch {
      setModelsMessage("读取模型失败，请检查网络后重试");
    } finally {
      setModelsLoading(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const values = new FormData(event.currentTarget);
    const payload = {
      name: values.get("name"), model: values.get("model"), multiplier: values.get("multiplier"), baseUrl: values.get("baseUrl"), apiKey: values.get("apiKey"),
      intervalMinutes: values.get("intervalMinutes"), idleIntervalMinutes: values.get("idleIntervalMinutes"), streaming, enabled, isPublic,
      reasoningEffort: values.get("reasoningEffort") || null,
    };
    try {
    const response = await fetch(item ? `/api/admin/groups/${item.id}` : "/api/admin/groups", {
      method: item ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!response.ok) return setError(await readError(response));
    await onSaved();
    } catch { setError("保存失败，请检查网络后重试"); }
    finally { setSaving(false); }
  }

  return (
    <ModalFrame title={item ? "编辑分组" : "新增分组"} description="配置 OpenAI 兼容模型接口和执行频率。" onClose={onClose}>
      <form ref={formRef} className="editor-form" onSubmit={submit}>
        <div className="form-grid two">
          <label><span>分组名称</span><input className="input" name="name" defaultValue={item?.name} placeholder="例如 旗舰模型组" required /></label>
          <label><span>倍率</span><div className="input-affix"><input className="input" name="multiplier" type="number" min="0.01" step="0.01" defaultValue={item?.multiplier ?? 1} required /><i>x</i></div></label>
        </div>
        <label><span>Base URL</span><input className="input" name="baseUrl" type="url" defaultValue={item?.baseUrl ?? "https://api.openai.com/v1"} placeholder="https://api.openai.com/v1" required /></label>
        <label><span>API Key</span><input className="input" name="apiKey" type="password" placeholder={item?.apiKeyConfigured ? "已配置，留空则保持不变" : "sk-..."} required={!item?.apiKeyConfigured} autoComplete="new-password" /></label>
        <div className="field-block">
          <div className="field-label-row">
            <label htmlFor="group-model">模型</label>
            <button type="button" className="model-load-button" disabled={modelsLoading} onClick={() => void loadModels()}>
              <RefreshCw size={13} className={modelsLoading ? "spin" : ""} />读取可用模型
            </button>
          </div>
          <input id="group-model" className="input mono" name="model" list="available-models" value={model} onChange={(event) => setModel(event.target.value)} placeholder="选择或输入模型 ID" required />
          <datalist id="available-models">{models.map((id) => <option value={id} key={id} />)}</datalist>
          {modelsMessage && <small className={models.length ? "field-success" : "field-error"}>{modelsMessage}</small>}
        </div>
        <div className="form-grid two">
          <label><span>检测频率</span><div className="input-affix"><input className="input" name="intervalMinutes" type="number" min="1" defaultValue={item?.intervalMinutes ?? 60} required /><i>分钟</i></div></label>
          <label><span>闲时频率</span><div className="input-affix"><input className="input" name="idleIntervalMinutes" type="number" min="1" defaultValue={item?.idleIntervalMinutes ?? 180} required /><i>分钟</i></div></label>
        </div>
        <label><span>分组思考强度</span><select className="input select" name="reasoningEffort" defaultValue={item?.reasoningEffort ?? ""}><option value="">按题目设置（不覆盖）</option>{REASONING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}</select><small className="group-setting">默认使用每道检测题各自的思考强度；选择具体级别后，统一覆盖本分组所有检测题。请选择上游模型支持的值。</small></label>
        <div className="toggle-row"><div><strong>公开分组</strong><span>关闭后，首页仅登录管理员可见</span></div><button type="button" className={`toggle ${isPublic ? "on" : ""}`} onClick={() => setIsPublic(!isPublic)} aria-label="公开分组" aria-pressed={isPublic}><i /></button></div>
        <div className="toggle-row"><div><strong>流式调用</strong><span>启用时记录首 Token 延迟</span></div><button type="button" className={`toggle ${streaming ? "on" : ""}`} onClick={() => setStreaming(!streaming)} aria-label="流式调用" aria-pressed={streaming}><i /></button></div>
        <div className="toggle-row"><div><strong>启用自动检测</strong><span>保存后调度器将按设定频率执行</span></div><button type="button" className={`toggle ${enabled ? "on" : ""}`} onClick={() => setEnabled(!enabled)} aria-label="启用自动检测" aria-pressed={enabled}><i /></button></div>
        {error && <div className="form-error"><CircleAlert size={14} /> {error}</div>}
        <div className="modal-actions"><button type="button" className="button button-ghost" onClick={onClose}>取消</button><button className="button button-dark" disabled={saving}>{saving && <Loader2 size={16} className="spin" />}保存分组</button></div>
      </form>
    </ModalFrame>
  );
}

function QuestionEditor({ item, onClose, onSaved }: { item?: Question; onClose: () => void; onSaved: () => Promise<void> }) {
  const [enabled, setEnabled] = useState(item?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const values = new FormData(event.currentTarget);
    const payload = { name: values.get("name"), prompt: values.get("prompt"), reasoningEffort: values.get("reasoningEffort"), passPattern: values.get("passPattern"), enabled };
    try {
    const response = await fetch(item ? `/api/admin/questions/${item.id}` : "/api/admin/questions", {
      method: item ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!response.ok) return setError(await readError(response));
    await onSaved();
    } catch { setError("保存失败，请检查网络后重试"); }
    finally { setSaving(false); }
  }

  return (
    <ModalFrame title={item ? "编辑检测题" : "新增检测题"} description="设置提问内容、思考强度和通过条件。" onClose={onClose}>
      <form className="editor-form" onSubmit={submit}>
        <label><span>题目名称</span><input className="input" name="name" defaultValue={item?.name} placeholder="例如 糖果逻辑题" required /></label>
        <label><span>Prompt</span><textarea className="textarea" name="prompt" rows={9} defaultValue={item?.prompt} placeholder="输入发送给模型的完整题目..." required /></label>
        <div className="form-grid two">
          <label><span>思考强度</span><select className="input select" name="reasoningEffort" defaultValue={item?.reasoningEffort ?? "medium"}>{REASONING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
          <label><span>通过条件（正则）</span><input className="input mono" name="passPattern" defaultValue={item?.passPattern} placeholder="例如 \\b21\\b" required /></label>
        </div>
        <div className="toggle-row"><div><strong>启用此检测题</strong><span>启用后会随每个分组一起执行</span></div><button type="button" className={`toggle ${enabled ? "on" : ""}`} onClick={() => setEnabled(!enabled)} aria-label="启用检测题" aria-pressed={enabled}><i /></button></div>
        {error && <div className="form-error"><CircleAlert size={14} /> {error}</div>}
        <div className="modal-actions"><button type="button" className="button button-ghost" onClick={onClose}>取消</button><button className="button button-dark" disabled={saving}>{saving && <Loader2 size={16} className="spin" />}保存检测题</button></div>
      </form>
    </ModalFrame>
  );
}
