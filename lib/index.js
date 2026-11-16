/**
 * dsh-project-desk — host half.
 *
 * Serves the Project Desk HTTP API used by the browser panel:
 *   GET  /project-desk/api/state                      projects + defaults
 *   GET  /project-desk/api/project?dir=<abs>          one project (instructions + tree + mounted)
 *   POST /project-desk/api/create                     create dir, git init, AGENTS.md, register workspace
 *   POST /project-desk/api/save-instructions          save AGENTS.md (mtime conflict guarded)
 *   POST /project-desk/api/mount                      mount / unmount a project file in the managed block
 *   POST /project-desk/api/mount-many                 mount / unmount many files at once (folder checkbox)
 *   POST /project-desk/api/new-file                   create an (empty) project file to mount
 *   POST /project-desk/api/pick-files                 open the native file dialog, return chosen paths
 *   POST /project-desk/api/import-files               copy (if needed) + mount chosen files
 *   POST /project-desk/api/mount-folder               pick a folder (native dialog) and mount every file under it
 *
 * The project baseline itself stays a plain file on disk (`<project>/AGENTS.md`),
 * so it is git-versioned and picked up by DSH's own instruction loader; this
 * plugin never injects a parallel prompt store.
 */
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const PLUGIN_LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const PICKER_SCRIPT = path.join(PLUGIN_LIB_DIR, "picker.ps1");

const name = "project-desk";
const inject = [];
const PREFIX = "/project-desk/api";
const MAX_BODY_BYTES = 4 << 20;
// 批量挂载一次最多处理多少个文件（防止误点整个大目录写爆受管段）
const MAX_MOUNT_BATCH = 400;
// 选整个文件夹时，文件数超过这个值先让前端确认一次（避免把几百条路径写进 AGENTS.md）
const FOLDER_CONFIRM_THRESHOLD = 30;
const TREE_LIMIT = 600;
const TREE_DEPTH = 4;
const HOST_RE = /^(?:localhost|\[::1\]|127(?:\.\d{1,3}){3})$/;
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".dsh", ".agents", "dist", "build", "out",
  ".next", ".nuxt", ".turbo", ".venv", "venv", "__pycache__", ".idea", ".vscode",
]);
const BLOCK_START = "<!-- project-desk:start -->";
const BLOCK_END = "<!-- project-desk:end -->";

/**
 * 默认父目录：优先用已存在的 `~/DSH-Projects`；没有则用已存在的 `C:\dsh`
 * （很多人的 DSH 项目都放在这里）；都不存在时仍用 `~/DSH-Projects`
 * （新建项目时会自动创建父目录）。
 */
function defaultProjectsRoot() {
  const candidates = [path.join(os.homedir(), "DSH-Projects"), "C:\\dsh", "/dsh"];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore unreadable candidates */
    }
  }
  return candidates[0];
}

/** Plugin configuration defaults; every field may be overridden from the profile patch. */
const DEFAULT_CONFIG = {
  projectsRoot: defaultProjectsRoot(),
  // 默认不建 git 仓库：项目文件夹本身就是边界，只有在「从子目录开对话」时
  // 才需要 .git 当标记，多数人用不到。
  gitInit: false,
  instructionsFileName: "AGENTS.md",
};

/* ------------------------------------------------------------------ helpers */

function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    "cache-control": "no-store",
  });
  res.end(body);
}

function guardHost(req, res) {
  const raw = req.headers.host;
  if (typeof raw !== "string" || raw.length === 0) {
    sendJson(res, 403, { error: "missing Host header" });
    return false;
  }
  const hostname = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":")[0];
  if (!HOST_RE.test(hostname)) {
    sendJson(res, 403, { error: "loopback access only" });
    return false;
  }
  return true;
}

function guardWrite(req, res) {
  const type = String(req.headers["content-type"] ?? "");
  if (!type.toLowerCase().startsWith("application/json")) {
    sendJson(res, 415, { error: "content-type must be application/json" });
    return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "null") {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = undefined;
    }
    if (originHost !== req.headers.host) {
      sendJson(res, 403, { error: "cross-origin write rejected" });
      return false;
    }
  }
  return true;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("body is not valid JSON"), { status: 400 });
  }
}

async function writeFileAtomic(file, content) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await fs.writeFile(tmp, content, "utf8");
  } catch (error) {
    throw Object.assign(new Error(`cannot write temp file: ${error.message}`), { status: 500 });
  }
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        await fs.rename(tmp, file);
        return;
      } catch (retry) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw Object.assign(new Error(`cannot replace ${base}: ${retry.message}`), { status: 500 });
      }
    }
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw Object.assign(new Error(`cannot replace ${base}: ${error.message}`), { status: 500 });
  }
}

function renderBlock(mounted) {
  const lines = [
    BLOCK_START,
    "## 项目文件（Project Desk 自动维护，请勿手改本段）",
    "",
  ];
  if (mounted.length === 0) {
    lines.push("（暂未挂载文件。在「项目工作台」里勾选要带进对话的项目文件。）");
  } else {
    lines.push("回答前先读下面这些文件，把它们当作本项目的既有背景：", "");
    for (const file of mounted) lines.push(`- \`${file}\``);
  }
  lines.push(BLOCK_END);
  return lines.join("\n");
}

function parseBlock(content) {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) return [];
  const inner = content.slice(start + BLOCK_START.length, end);
  const mounted = [];
  for (const raw of inner.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+`?([^`\s]+)`?\s*$/.exec(raw);
    if (match) mounted.push(match[1]);
  }
  return mounted;
}

function upsertBlock(content, mounted) {
  const block = renderBlock(mounted);
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    return `${content.slice(0, start)}${block}${content.slice(end + BLOCK_END.length)}`;
  }
  const trimmed = content.replace(/\s+$/, "");
  return trimmed.length === 0 ? `${block}\n` : `${trimmed}\n\n${block}\n`;
}

function safeRelative(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (path.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return undefined;
  const normalized = value.split("\\").join("/").replace(/^\.\//, "");
  if (normalized.split("/").some((segment) => segment === "" || segment === "..")) return undefined;
  return normalized;
}

function isGitRepo(dir) {
  return existsSync(path.join(dir, ".git"));
}

/** 两个文件内容是否一致（用于重复导入时复用已有副本）。 */
async function sameContent(left, right) {
  const [a, b] = await Promise.all([fs.stat(left), fs.stat(right)]);
  if (a.size !== b.size || b.size > 4 << 20) return false;
  const [bufA, bufB] = await Promise.all([fs.readFile(left), fs.readFile(right)]);
  return bufA.equals(bufB);
}

/**
 * 从项目外导入文件时决定落在项目里叫什么：
 * - 同名同内容的副本已存在 → 复用（reuse=true，不重复复制、不产生 "(1)"）
 * - 同名不同内容 → 依次尝试 "名字 (1).ext" …
 */
async function importNameFor(dir, absolute) {
  const baseName = path.basename(absolute);
  const dot = baseName.lastIndexOf(".");
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const ext = dot > 0 ? baseName.slice(dot) : "";
  let candidate = baseName;
  for (let counter = 1; counter < 1000; counter += 1) {
    const target = path.join(dir, candidate);
    if (!existsSync(target)) return { name: candidate, reuse: false };
    if (await sameContent(absolute, target)) return { name: candidate, reuse: true };
    candidate = `${stem} (${counter})${ext}`;
  }
  return { name: `${stem} (${Date.now()})${ext}`, reuse: false };
}

const TEMPLATES = {
  blank: (title) => `# ${title}\n\n> 这是本项目的 AGENTS.md：DSH 每次在本项目开会话都会先读它。\n\n## 这是什么项目\n\n（一句话说明用途）\n\n## 约定\n\n- \n`,
  code: (title) => `# ${title}\n\n## 这是什么项目\n\n（一句话说明用途与技术栈）\n\n## 常用命令\n\n\`\`\`powershell\n# 安装依赖\n# 运行测试\n# 启动开发\n\`\`\`\n\n## 改动纪律\n\n- 改文件前先读；只改要求的部分，不顺手重构无关代码。\n- 说"已完成"前必须实际运行验证命令，并给出关键输出。\n- 不新增依赖、不改 CI/构建配置，除非明确要求。\n\n## 目录说明\n\n- \n`,
  writing: (title) => `# ${title}\n\n## 这是什么项目\n\n（写作 / 文档 / 内容类项目）\n\n## 写作约定\n\n- 先给结论，再给理由；不写空话。\n- 术语前后一致；中文全角标点。\n- 引用给出来源，不确定的地方标注"待核实"。\n\n## 文件组织\n\n- \`drafts/\` 草稿，\`final/\` 定稿，\`assets/\` 配图。\n`,
  diet: () => `# 健康 / 饮食记录项目\n\n## 这是什么项目\n\n用来记录每天吃了什么、估算热量，并跟踪健康问题。\n\n## 约定\n\n- 我发图片默认是食物照片：逐项识别菜名、估算份量（克/毫升）与热量。\n- 输出顺序：分项热量 → 合计 → 与每日目标差 → 蛋白质/碳水/脂肪比例。\n- 记录追加到 \`data/records.jsonl\`，一行一条记录，包含 ISO 时间。\n- 热量估算给出区间与误差说明，不要假装精确。\n- 我热爱生物学、有高中及以上生物学知识：讲机理可以深入，但结论要简单直白。\n`,
};

function validateProjectName(value) {
  if (typeof value !== "string") return "项目名称必须是字符串";
  const title = value.trim();
  if (title.length === 0) return "项目名称不能为空";
  if (title.length > 80) return "项目名称太长（最多 80 个字符）";
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(title)) return '项目名称不能包含 < > : " / \\ | ? * 等字符';
  if (/[. ]$/.test(title)) return "项目名称不能以点或空格结尾";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(title)) return "项目名称是 Windows 保留名";
  return undefined;
}

async function readInstructions(dir, fileName) {
  const file = path.join(dir, fileName);
  try {
    const [stat, content] = await Promise.all([fs.stat(file), fs.readFile(file, "utf8")]);
    return { file, exists: true, content, mtimeMs: stat.mtimeMs, bytes: Buffer.byteLength(content, "utf8") };
  } catch (error) {
    if (error.code === "ENOENT") return { file, exists: false, content: "", mtimeMs: 0, bytes: 0 };
    throw error;
  }
}

async function listTree(root, skipRootNames) {
  const out = [];
  const walk = async (dir, rel, depth) => {
    if (out.length >= TREE_LIMIT || depth > TREE_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (out.length >= TREE_LIMIT) return;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push({ path: childRel, type: "dir", depth });
        await walk(path.join(dir, entry.name), childRel, depth + 1);
      } else if (entry.isFile()) {
        out.push({ path: childRel, type: "file", depth });
      }
    }
  };
  await walk(root, "", 0);
  if (!skipRootNames || skipRootNames.size === 0) return out;
  // The instructions file itself is edited in its own section and is never mountable.
  return out.filter((entry) => !(entry.depth === 0 && skipRootNames.has(entry.path)));
}

/**
 * 递归收集 root 下的所有文件（跳过 SKIP_DIRS 与点开头目录）。
 * 只在「选文件夹挂载」时用；超过 limit 就停下来（调用方会报「太多」）。
 */
async function collectFiles(root, limit) {
  const out = [];
  const walk = async (dir) => {
    if (out.length > limit) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length > limit) return;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  await walk(root);
  return out;
}

/* -------------------------------------------------------------------- apply */
/**
 * @param ctx - the host plugin context.
 * @param config - validated plugin configuration.
 */
function apply(ctx, config) {
  const options = config ?? {};
  const projectsRoot = path.resolve(options.projectsRoot ?? DEFAULT_CONFIG.projectsRoot);
  const instructionsFileName = options.instructionsFileName ?? DEFAULT_CONFIG.instructionsFileName;
  const gitInitDefault = options.gitInit ?? DEFAULT_CONFIG.gitInit;

  /** @type {{ list: () => Array<{ id: string, path: string, title: string, sessionIds?: string[] }> } | undefined} */
  let workspaceRegistry;

  ctx.inject(["workspaceRegistry"], (wctx) => {
    workspaceRegistry = wctx.workspaceRegistry;
  });

  const resolveProjectDir = (value) => {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const dir = path.resolve(value);
    if (!existsSync(dir)) return undefined;
    return dir;
  };

  const snapshotProject = async (dir, title) => {
    const instructions = await readInstructions(dir, instructionsFileName);
    return {
      path: dir,
      title: title ?? path.basename(dir),
      git: isGitRepo(dir),
      instructions: {
        exists: instructions.exists,
        bytes: instructions.bytes,
        mtimeMs: instructions.mtimeMs,
      },
      mounted: parseBlock(instructions.content).length,
    };
  };

  /**
   * 弹一个原生选择框（mode = "files" | "folder"），返回选中的绝对路径列表。
   * 对话框脚本是插件自带的 lib/picker.ps1（IFileOpenDialog：与资源管理器同款外观、
   * 面包屑导航、可新建文件夹，并且先 SetProcessDPIAware 保证清晰不糊）。
   * 结果写到临时 UTF-8 文件再读回，避免控制台编码问题；取消/超时都按"没选"处理。
   */
  const runPicker = async (mode, initialDir) => {
    const outFile = path.join(os.tmpdir(), `desk-pick-${process.pid}-${randomBytes(4).toString("hex")}.txt`);
    try {
      try {
        await execFileAsync(
          "powershell.exe",
          [
            "-NoProfile",
            "-STA",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            PICKER_SCRIPT,
            mode,
            String(initialDir ?? ""),
            outFile,
          ],
          { windowsHide: false, timeout: 180000, maxBuffer: 1 << 20 },
        );
      } catch (error) {
        return { cancelled: true, paths: [], detail: String(error?.message ?? "").split("\n")[0] };
      }
      const text = await fs.readFile(outFile, "utf8").catch(() => "");
      const paths = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && existsSync(line));
      return { cancelled: paths.length === 0, paths };
    } finally {
      await fs.rm(outFile, { force: true }).catch(() => {});
    }
  };

  const handlers = {
    async state(req, res) {
      const projects = [];
      const seen = new Set();
      let registryError;
      try {
        for (const workspace of workspaceRegistry?.list() ?? []) {
          const dir = path.resolve(workspace.path);
          if (seen.has(dir.toLowerCase())) continue;
          seen.add(dir.toLowerCase());
          try {
            projects.push(await snapshotProject(dir, workspace.title));
          } catch {
            projects.push({ path: dir, title: workspace.title, git: false, instructions: { exists: false, bytes: 0, mtimeMs: 0 }, mounted: 0, error: "无法读取" });
          }
        }
      } catch (error) {
        registryError = error.message;
      }
      sendJson(res, 200, {
        defaults: { projectsRoot, gitInit: gitInitDefault, instructionsFileName },
        templates: Object.keys(TEMPLATES),
        projects,
        ...(registryError ? { registryError } : {}),
      });
    },

    async project(req, res, url) {
      const dir = resolveProjectDir(url.searchParams.get("dir"));
      if (!dir) {
        sendJson(res, 404, { error: "项目目录不存在" });
        return;
      }
      const instructions = await readInstructions(dir, instructionsFileName);
      const tree = await listTree(dir, new Set([instructionsFileName]));
      const mounted = parseBlock(instructions.content);
      let title = path.basename(dir);
      try {
        title = workspaceRegistry?.list().find((workspace) => path.resolve(workspace.path).toLowerCase() === dir.toLowerCase())?.title ?? title;
      } catch {
        /* title fallback already applied */
      }
      sendJson(res, 200, {
        path: dir,
        title,
        git: isGitRepo(dir),
        tree,
        mounted,
        instructions: {
          fileName: instructionsFileName,
          exists: instructions.exists,
          content: instructions.content,
          bytes: instructions.bytes,
          mtimeMs: instructions.mtimeMs,
          budgetBytes: 65536,
        },
      });
    },

    async create(req, res) {
      if (!guardWrite(req, res)) return;
      const body = await readJsonBody(req);
      const problem = validateProjectName(body.name);
      if (problem) {
        sendJson(res, 400, { error: problem });
        return;
      }
      const title = body.name.trim();
      const parentRaw = typeof body.parentDir === "string" && body.parentDir.trim().length > 0 ? body.parentDir.trim() : projectsRoot;
      const parent = path.resolve(parentRaw);
      if (!existsSync(parent)) {
        try {
          await fs.mkdir(parent, { recursive: true });
        } catch (error) {
          sendJson(res, 400, {
            error: `父目录无法创建：${parent}（${String(error.message).split("\n")[0]}）`,
          });
          return;
        }
      }
      const dir = path.join(parent, title);
      if (existsSync(dir)) {
        sendJson(res, 409, { error: `目录已存在：${dir}` });
        return;
      }
      const warnings = [];
      await fs.mkdir(dir, { recursive: true });
      const instructionsFile = path.join(dir, instructionsFileName);
      const custom = typeof body.instructions === "string" ? body.instructions : "";
      const templateKind = typeof body.template === "string" && TEMPLATES[body.template] ? body.template : "blank";
      await fs.writeFile(instructionsFile, custom.trim().length > 0 ? custom : TEMPLATES[templateKind](title), "utf8");
      if (body.gitInit ?? gitInitDefault) {
        try {
          await execFileAsync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
        } catch (error) {
          warnings.push(`git init 失败（项目已创建，可稍后手动执行）：${String(error.message).split("\n")[0]}`);
        }
      }
      let workspace;
      try {
        workspace = await workspaceRegistry?.create(dir, title);
      } catch (error) {
        warnings.push(`注册工作区失败（目录与 AGENTS.md 已创建）：${error.message}`);
      }
      sendJson(res, 200, {
        ok: true,
        project: {
          path: dir,
          title,
          git: isGitRepo(dir),
          instructionsFile,
          workspaceId: workspace?.id,
        },
        warnings,
      });
    },

    /**
     * 把一个已经存在的文件夹注册成 DSH 项目：补 AGENTS.md（没有才写）、可选 git init、注册工作区。
     * 和 create 的区别：不新建目录，只是"接管"一个已有文件夹。
     */
    async "register-existing"(req, res) {
      if (!guardWrite(req, res)) return;
      const body = await readJsonBody(req);
      const raw = typeof body.dir === "string" ? body.dir.trim() : "";
      if (raw.length === 0) {
        sendJson(res, 400, { error: "dir 不能为空" });
        return;
      }
      const dir = path.resolve(raw);
      let stat;
      try {
        stat = await fs.stat(dir);
      } catch {
        sendJson(res, 404, { error: `文件夹不存在：${dir}` });
        return;
      }
      if (!stat.isDirectory()) {
        sendJson(res, 400, { error: `这不是文件夹：${dir}` });
        return;
      }
      const warnings = [];
      const title = path.basename(dir) || dir;
      const instructionsFile = path.join(dir, instructionsFileName);
      let createdInstructions = false;
      if (!existsSync(instructionsFile)) {
        const custom = typeof body.instructions === "string" ? body.instructions : "";
        try {
          await fs.writeFile(instructionsFile, custom.trim().length > 0 ? custom : TEMPLATES.blank(title), "utf8");
          createdInstructions = true;
        } catch (error) {
          sendJson(res, 500, { error: `无法写入 ${instructionsFileName}：${String(error.message).split("\n")[0]}` });
          return;
        }
      }
      if ((body.gitInit ?? gitInitDefault) && !isGitRepo(dir)) {
        try {
          await execFileAsync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
        } catch (error) {
          warnings.push(`git init 失败（可稍后手动执行）：${String(error.message).split("\n")[0]}`);
        }
      }
      let workspace;
      try {
        const existing = (workspaceRegistry?.list() ?? []).find(
          (item) => path.resolve(item.path).toLowerCase() === dir.toLowerCase(),
        );
        workspace = existing ?? (await workspaceRegistry?.create(dir, title));
      } catch (error) {
        warnings.push(`注册工作区失败：${error.message}`);
      }
      const snapshot = await snapshotProject(dir, workspace?.title ?? title);
      sendJson(res, 200, {
        ok: true,
        createdInstructions,
        project: { ...snapshot, workspaceId: workspace?.id },
        warnings,
      });
    },

    async "pick-folder"(req, res) {
      if (!guardWrite(req, res)) return;
      const body = await readJsonBody(req);
      const requested = typeof body.initialDir === "string" && body.initialDir.trim().length > 0
        ? path.resolve(body.initialDir.trim())
        : resolveProjectDir(body.dir) ?? projectsRoot;
      const startDir = existsSync(requested) ? requested : projectsRoot;
      const result = await runPicker("folder", startDir);
      sendJson(res, 200, { ok: true, cancelled: result.cancelled, paths: result.paths, detail: result.detail });
    },

    async "save-instructions"(req, res) {
      if (!guardWrite(req, res)) return;
      const body = await readJsonBody(req);
      const dir = resolveProjectDir(body.dir);
      if (!dir) {
        sendJson(res, 404, { error: "项目目录不存在" });
        return;
      }
      if (typeof body.content !== "string") {
        sendJson(res, 400, { error: "content 必须是字符串" });
        return;
      }
      const file = path.join(dir, instructionsFileName);
      const current = await readInstructions(dir, instructionsFileName);
      const expected = Number(body.expectedMtimeMs ?? 0);
      if (current.exists && Math.abs(current.mtimeMs - expected) > 1) {
        sendJson(res, 409, {
          error: "文件已被别处修改，请重新载入后再保存",
          code: "STALE_INSTRUCTIONS",
          mtimeMs: current.mtimeMs,
          content: current.content,
        });
        return;
      }
      await writeFileAtomic(file, body.content);
      const stat = await fs.stat(file);
      const mounted = parseBlock(body.content);
      sendJson(res, 200, { ok: true, mtimeMs: stat.mtimeMs, bytes: Buffer.byteLength(body.content, "utf8"), mounted });
    },

    async "new-file"(req, res) {
      if (!guardWrite(req, res)) return;
      const body = await readJsonBody(req);
      const dir = resolveProjectDir(body.dir);
      if (!dir) {
        sendJson(res, 404, { error: "项目目录不存在" });
        return;
      }
      const rel = safeRelative(body.file);
      if (!rel) {
        sendJson(res, 400, { error: "文件名必须是项目内的相对路径，例如 notes.md 或 data/records.jsonl" });
        return;
      }
      if (rel === instructionsFileName) {
        sendJson(res, 400, { error: `${instructionsFileName} 就是指令文件本身，不需要也不允许挂载` });
        return;
      }
      const absolute = path.join(dir, rel.split("/").join(path.sep));
      const relative = path.relative(dir, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        sendJson(res, 400, { error: "文件名必须落在项目目录内" });
        return;
      }
      let created = false;
      if (!existsSync(absolute)) {
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        const content = typeof body.content === "string" ? body.content : "";
        try {
          await fs.writeFile(absolute, content, { encoding: "utf8", flag: "wx" });
          created = true;
        } catch (error) {
          if (error.code !== "EEXIST") {
            sendJson(res, 500, { error: `无法创建文件：${String(error.message).split("\n")[0]}` });
            return;
          }
        }
      }
      sendJson(res, 200, { ok: true, file: rel, created });
    },

    async "pick-files"(req, res) {
      if (!guardWrite(req, res)) return;
      const body = await readJsonBody(req);
      const startDir = resolveProjectDir(body.dir) ?? projectsRoot;
      const result = await runPicker("files", startDir);
      sendJson(res, 200, { ok: true, cancelled: result.cancelled, paths: result.paths, detail: result.detail });
    },

    async "import-files"(req, res) {
      if (!guardWrite(req, res)) return;
      const body = await readJsonBody(req);
      const dir = resolveProjectDir(body.dir);
      if (!dir) {
        sendJson(res, 404, { error: "项目目录不存在" });
        return;
      }
      const chosen = Array.isArray(body.paths) ? body.paths.filter((item) => typeof item === "string") : [];
      if (chosen.length === 0) {
        sendJson(res, 400, { error: "没有要导入的文件" });
        return;
      }
      const instructions = await readInstructions(dir, instructionsFileName);
      const mounted = parseBlock(instructions.content);
      const imported = [];
      for (const raw of chosen) {
        const absolute = path.resolve(raw);
        if (!existsSync(absolute)) {
          imported.push({ rel: raw, copied: false, error: "文件不存在" });
          continue;
        }
        let relPath;
        let copied = false;
        const relative = path.relative(dir, absolute);
        if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
          relPath = relative.split(path.sep).join("/");
        } else {
          // 项目外的文件：复制进项目根目录（同名同内容则复用已有副本）再挂载
          const target = await importNameFor(dir, absolute);
          relPath = target.name;
          if (!target.reuse) {
            await fs.copyFile(absolute, path.join(dir, relPath));
            copied = true;
          }
        }
        if (!mounted.includes(relPath)) mounted.push(relPath);
        imported.push({ rel: relPath, copied });
      }
      const nextContent = upsertBlock(instructions.content, mounted);
      await writeFileAtomic(instructions.file, nextContent);
      const stat = await fs.stat(instructions.file);
      sendJson(res, 200, { ok: true, imported, mounted, content: nextContent, mtimeMs: stat.mtimeMs });
    },

    async mount(req, res) {
      if (!guardWrite(req, res)) return;
      const body = await readJsonBody(req);
      const dir = resolveProjectDir(body.dir);
      if (!dir) {
        sendJson(res, 404, { error: "项目目录不存在" });
        return;
      }
      const rel = safeRelative(body.file);
      if (!rel) {
        sendJson(res, 400, { error: "file 必须是项目内的相对路径" });
        return;
      }
      const absolute = path.join(dir, rel.split("/").join(path.sep));
      const instructions = await readInstructions(dir, instructionsFileName);
      let mounted = parseBlock(instructions.content);
      const shouldMount = body.mounted !== false;
      if (shouldMount) {
        if (!existsSync(absolute)) {
          sendJson(res, 404, { error: `文件不存在：${rel}` });
          return;
        }
        if (!mounted.includes(rel)) mounted.push(rel);
      } else {
        mounted = mounted.filter((item) => item !== rel);
      }
      const nextContent = upsertBlock(instructions.content, mounted);
      await writeFileAtomic(instructions.file, nextContent);
      const stat = await fs.stat(instructions.file);
      sendJson(res, 200, { ok: true, mounted, content: nextContent, mtimeMs: stat.mtimeMs });
    },

    /**
     * 批量挂载 / 取消挂载：一次请求写一次盘。
     * body: { dir, files: string[], mounted?: boolean }
     * 目录级挂载（面板里点文件夹那一行的复选框）走这里，避免一个大目录点几十次。
     */
    async "mount-many"(req, res) {
      if (!guardWrite(req, res)) return;
      const body = await readJsonBody(req);
      const dir = resolveProjectDir(body.dir);
      if (!dir) {
        sendJson(res, 404, { error: "项目目录不存在" });
        return;
      }
      const raw = Array.isArray(body.files) ? body.files : [];
      const rels = [];
      for (const item of raw) {
        if (typeof item !== "string") continue;
        const rel = safeRelative(item);
        if (!rel) {
          sendJson(res, 400, { error: `files 里有非法路径：${item}` });
          return;
        }
        if (rel === instructionsFileName) {
          sendJson(res, 400, { error: `${instructionsFileName} 就是指令文件本身，不需要也不允许挂载` });
          return;
        }
        if (!rels.includes(rel)) rels.push(rel);
      }
      if (rels.length === 0) {
        sendJson(res, 400, { error: "files 不能为空" });
        return;
      }
      if (rels.length > MAX_MOUNT_BATCH) {
        sendJson(res, 400, { error: `一次最多处理 ${MAX_MOUNT_BATCH} 个文件` });
        return;
      }
      const instructions = await readInstructions(dir, instructionsFileName);
      let mounted = parseBlock(instructions.content);
      const shouldMount = body.mounted !== false;
      if (shouldMount) {
        const missing = rels.filter((rel) => !existsSync(path.join(dir, rel.split("/").join(path.sep))));
        if (missing.length > 0) {
          sendJson(res, 404, { error: `文件不存在：${missing.slice(0, 3).join("、")}${missing.length > 3 ? ` 等 ${missing.length} 个` : ""}` });
          return;
        }
        for (const rel of rels) if (!mounted.includes(rel)) mounted.push(rel);
      } else {
        mounted = mounted.filter((item) => !rels.includes(item));
      }
      const nextContent = upsertBlock(instructions.content, mounted);
      await writeFileAtomic(instructions.file, nextContent);
      const stat = await fs.stat(instructions.file);
      sendJson(res, 200, { ok: true, changed: rels.length, mounted, content: nextContent, mtimeMs: stat.mtimeMs });
    },

    /**
     * 选一个文件夹，把它下面的所有文件一次挂上。
     * body: { dir, folder?: string, confirmed?: boolean }
     * - 不传 folder：先弹系统文件夹选择框（和「用已有文件夹…」同一个 IFileOpenDialog 文件夹模式）
     * - 文件数 > FOLDER_CONFIRM_THRESHOLD 且 confirmed !== true：只回 { needsConfirm, count }，由前端弹确认
     */
    async "mount-folder"(req, res) {
      if (!guardWrite(req, res)) return;
      const body = await readJsonBody(req);
      const dir = resolveProjectDir(body.dir);
      if (!dir) {
        sendJson(res, 404, { error: "项目目录不存在" });
        return;
      }
      let folder = typeof body.folder === "string" && body.folder.trim().length > 0 ? path.resolve(body.folder.trim()) : "";
      if (!folder) {
        const picked = await runPicker("folder", dir);
        if (picked.cancelled || picked.paths.length === 0) {
          sendJson(res, 200, { ok: true, cancelled: true, detail: picked.detail });
          return;
        }
        folder = path.resolve(picked.paths[0]);
      }
      if (!existsSync(folder)) {
        sendJson(res, 404, { error: `文件夹不存在：${folder}` });
        return;
      }
      const files = await collectFiles(folder, MAX_MOUNT_BATCH);
      const rels = [];
      for (const absolute of files) {
        const rel = path.relative(dir, absolute).split(path.sep).join("/");
        if (!rel || rel.startsWith("..")) continue;
        if (rel === instructionsFileName) continue;
        if (!rels.includes(rel)) rels.push(rel);
      }
      if (rels.length === 0) {
        sendJson(res, 400, { error: "这个文件夹里没有可挂载的文件（子目录为空，或只有 AGENTS.md）" });
        return;
      }
      if (rels.length > MAX_MOUNT_BATCH) {
        sendJson(res, 400, { error: `文件夹里超过 ${MAX_MOUNT_BATCH} 个文件，建议改用文件树里勾选部分目录` });
        return;
      }
      if (rels.length > FOLDER_CONFIRM_THRESHOLD && body.confirmed !== true) {
        sendJson(res, 200, { ok: true, needsConfirm: true, folder, count: rels.length, sample: rels.slice(0, 6) });
        return;
      }
      const instructions = await readInstructions(dir, instructionsFileName);
      const mounted = parseBlock(instructions.content);
      const added = rels.filter((rel) => !mounted.includes(rel));
      for (const rel of added) mounted.push(rel);
      const nextContent = upsertBlock(instructions.content, mounted);
      await writeFileAtomic(instructions.file, nextContent);
      const stat = await fs.stat(instructions.file);
      sendJson(res, 200, { ok: true, folder, added: added.length, mounted, content: nextContent, mtimeMs: stat.mtimeMs });
    },
  };

  ctx.inject(["webServer"], (wctx) => {
    const web = wctx.webServer;
    for (const [route, handler] of Object.entries(handlers)) {
      const pathName = route === "state" ? `${PREFIX}/state` : `${PREFIX}/${route}`;
      wctx.effect(
        () =>
          web.register({
            kind: "exact",
            path: pathName,
            handler: async (req, res) => {
              if (!guardHost(req, res)) return;
              try {
                const url = new URL(req.url ?? pathName, `http://${req.headers.host ?? "127.0.0.1"}`);
                if (req.method === "GET") {
                  await handler(req, res, url);
                  return;
                }
                if (req.method === "POST") {
                  await handler(req, res, url);
                  return;
                }
                sendJson(res, 405, { error: "method not allowed" });
              } catch (error) {
                const status = typeof error.status === "number" ? error.status : 500;
                sendJson(res, status, { error: error.message ?? String(error) });
              }
            },
          }),
        `project-desk: route ${pathName}`,
      );
    }
  });
}

export { apply, inject, name };
