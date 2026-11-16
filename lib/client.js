/**
 * dsh-project-desk — browser half.
 *
 * Contributes a 「项目」 panel to the sidebar and the Project Desk page that
 * opens from it: create a project (directory + AGENTS.md + DSH
 * workspace), then edit that project's baseline instructions and choose which
 * project files get mounted into the project baseline.
 *
 * No build step: this file is a hand-written client bundle registered through
 * `window.__ModuleLoader__` and materialised lazily by the browser module
 * system. Only `react` is required.
 */
window.__ModuleLoader__.load({
	id: "dsh-project-desk",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback, useRef } = react;

		const NS = "project-desk";
		const PANEL_ID = "project-desk";
		const API = "/project-desk/api";
		const LAST_PARENT_KEY = "dsh-project-desk:last-parent";

		/** 记住上次用过的父目录，下次新建项目时直接沿用。 */
		function readLastParent() {
			try {
				return window.localStorage.getItem(LAST_PARENT_KEY) || "";
			} catch {
				return "";
			}
		}

		function rememberParent(value) {
			try {
				window.localStorage.setItem(LAST_PARENT_KEY, value);
			} catch {
				/* localStorage 不可用时静默忽略 */
			}
		}

		/** uiWorkspace 服务（侧栏工作区行「+」用的就是它），由 apply 注入。 */
		let uiWorkspaceService = null;

		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

		/**
		 * 在刚创建的项目工作区里打开一个新对话。
		 * 客户端的工作区列表是异步同步的，所以这里带重试；服务缺失时返回 false，
		 * 由调用方退回到「侧栏工作区行点 +」的提示。
		 */
		async function openNewConversation(workspaceId) {
			if (!workspaceId) return false;
			for (let attempt = 0; attempt < 8; attempt += 1) {
				if (uiWorkspaceService) {
					try {
						uiWorkspaceService.startSession(workspaceId, { clearPreviousDraft: false });
						return true;
					} catch {
						/* 工作区还没同步到客户端，稍后重试 */
					}
				}
				await sleep(400);
			}
			return false;
		}

		/* ------------------------------------------------------------- styles */

		const styles = {
			page: {
				display: "flex",
				flexDirection: "column",
				height: "100%",
				minHeight: 0,
				gap: 12,
				padding: "18px 20px 14px",
				boxSizing: "border-box",
				overflow: "hidden",
				fontSize: 13,
				lineHeight: 1.55,
			},
			header: { display: "flex", alignItems: "center", gap: 12, flex: "0 0 auto" },
			title: { fontSize: 17, fontWeight: 650, margin: 0 },
			subtitle: { color: "var(--dsh-color-text-secondary, #7a7a7a)", fontSize: 12 },
			spacer: { flex: "1 1 auto" },
			body: { display: "flex", gap: 14, flex: "1 1 auto", minHeight: 0 },
			col: { display: "flex", flexDirection: "column", gap: 10, minHeight: 0 },
			listCol: { flex: "0 0 240px", overflowY: "auto", paddingRight: 4 },
			detailCol: { flex: "1 1 auto", minWidth: 0, overflowY: "auto" },
			card: {
				border: "1px solid rgba(127,127,127,0.22)",
				borderRadius: 10,
				padding: "10px 12px",
				background: "rgba(127,127,127,0.04)",
				display: "flex",
				flexDirection: "column",
				gap: 6,
				cursor: "pointer",
			},
			cardActive: {
				border: "1px solid rgba(64,140,255,0.85)",
				background: "rgba(64,140,255,0.10)",
			},
			cardTitle: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			cardMeta: { fontSize: 11, color: "var(--dsh-color-text-secondary, #7a7a7a)", wordBreak: "break-all" },
			section: {
				border: "1px solid rgba(127,127,127,0.22)",
				borderRadius: 10,
				padding: 12,
				display: "flex",
				flexDirection: "column",
				gap: 8,
			},
			sectionHead: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			sectionTitle: { fontWeight: 650, fontSize: 13 },
			textarea: {
				width: "100%",
				minHeight: 260,
				resize: "vertical",
				boxSizing: "border-box",
				fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
				fontSize: 12.5,
				lineHeight: 1.6,
				padding: 10,
				borderRadius: 8,
				border: "1px solid rgba(127,127,127,0.3)",
				background: "transparent",
				color: "inherit",
			},
			input: {
				height: 30,
				padding: "0 8px",
				borderRadius: 7,
				border: "1px solid rgba(127,127,127,0.3)",
				background: "transparent",
				color: "inherit",
				fontSize: 12.5,
				boxSizing: "border-box",
			},
			button: {
				height: 28,
				padding: "0 12px",
				borderRadius: 7,
				border: "1px solid rgba(127,127,127,0.3)",
				background: "transparent",
				color: "inherit",
				fontSize: 12.5,
				cursor: "pointer",
			},
			buttonPrimary: {
				height: 28,
				padding: "0 14px",
				borderRadius: 7,
				border: "1px solid rgba(64,140,255,0.85)",
				background: "rgba(64,140,255,0.92)",
				color: "#fff",
				fontSize: 12.5,
				cursor: "pointer",
			},
			hint: { fontSize: 11.5, color: "var(--dsh-color-text-secondary, #7a7a7a)" },
			warn: { fontSize: 12, color: "#c2410c" },
			err: { fontSize: 12, color: "#dc2626" },
			tree: { maxHeight: 260, overflowY: "auto", border: "1px solid rgba(127,127,127,0.18)", borderRadius: 8, padding: 8 },
			treeRow: { display: "flex", alignItems: "center", gap: 6, height: 22, fontSize: 12.5, whiteSpace: "nowrap" },
			dirRow: { color: "var(--dsh-color-text-secondary, #7a7a7a)", fontWeight: 600 },
			chip: {
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				border: "1px solid rgba(127,127,127,0.28)",
				borderRadius: 20,
				padding: "1px 9px",
				fontSize: 11.5,
			},
			chipX: { cursor: "pointer", opacity: 0.7, fontWeight: 700 },
			empty: { padding: "24px 8px", color: "var(--dsh-color-text-secondary, #7a7a7a)", fontSize: 12.5 },
			createCard: {
				borderRadius: 14,
				border: "1px solid rgba(127,127,127,0.24)",
				background: "rgba(127,127,127,0.05)",
				padding: "26px 28px 24px",
				display: "flex",
				flexDirection: "column",
				gap: 14,
				width: "100%",
				maxWidth: 860,
				boxSizing: "border-box",
			},
			createTitle: { fontSize: 21, fontWeight: 700, margin: 0 },
			createSub: { fontSize: 12.5, color: "var(--dsh-color-text-secondary, #7a7a7a)", lineHeight: 1.6 },
			fieldLabel: { fontSize: 12, color: "var(--dsh-color-text-secondary, #7a7a7a)" },
			inputBig: {
				height: 42,
				padding: "0 12px",
				borderRadius: 9,
				border: "1px solid rgba(127,127,127,0.32)",
				background: "transparent",
				color: "inherit",
				fontSize: 14.5,
				boxSizing: "border-box",
				width: "100%",
			},
			buttonBig: {
				height: 38,
				padding: "0 22px",
				borderRadius: 9,
				border: "1px solid rgba(64,140,255,0.85)",
				background: "rgba(64,140,255,0.92)",
				color: "#fff",
				fontSize: 14,
				cursor: "pointer",
			},
			buttonBigGhost: {
				height: 38,
				padding: "0 20px",
				borderRadius: 9,
				border: "1px solid rgba(127,127,127,0.3)",
				background: "transparent",
				color: "inherit",
				fontSize: 14,
				cursor: "pointer",
			},
		};

		function primaryButton(extra) {
			return Object.assign({}, styles.buttonPrimary, extra);
		}

		function panelIcon({ size }) {
			const dimension = size ?? 18;
			return h(
				"svg",
				{ width: dimension, height: dimension, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" },
				h("path", { d: "M3 7.5A2 2 0 0 1 5 5.5h3.6l1.8 2H19a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }),
				h("path", { d: "M3 10h18" }),
			);
		}

		/* ------------------------------------------------------------- fetch */

		async function request(path, init) {
			const response = await fetch(path, Object.assign({ credentials: "same-origin" }, init));
			let payload;
			try {
				payload = await response.json();
			} catch {
				payload = {};
			}
			if (!response.ok) {
				const error = new Error(payload.error ?? `请求失败（HTTP ${response.status}）`);
				error.status = response.status;
				error.payload = payload;
				throw error;
			}
			return payload;
		}

		const getState = () => request(`${API}/state`);
		const getProject = (dir) => request(`${API}/project?dir=${encodeURIComponent(dir)}`);
		const postJson = (path, body) =>
			request(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

		function formatBytes(bytes) {
			if (bytes < 1024) return `${bytes} B`;
			return `${(bytes / 1024).toFixed(1)} KB`;
		}

		function textBytes(text) {
			try {
				return new TextEncoder().encode(text).length;
			} catch {
				return text.length;
			}
		}

		/* -------------------------------------------------------------- parts */

		function ProjectList({ projects, selected, creating, onSelect }) {
			if (projects.length === 0) {
				return h("div", { style: styles.empty }, "还没有项目。点右上角「新建项目」创建第一个。");
			}
			return h(
				"div",
				{ style: Object.assign({}, styles.col, styles.listCol) },
				projects.map((project) =>
					h(
						"div",
						{
							key: project.path,
							// 正在「新建项目」时右侧显示的不是任何一个项目，左侧就不该有高亮选中项。
							style: !creating && selected === project.path ? Object.assign({}, styles.card, styles.cardActive) : styles.card,
							onClick: () => onSelect(project.path),
						},
						h(
							"div",
							{ style: { display: "flex", alignItems: "center", gap: 6 } },
							h("div", { style: styles.cardTitle }, project.title),
							project.git ? h("span", { style: Object.assign({}, styles.chip, { fontSize: 10 }) }, "git") : null,
						),
						h("div", { style: styles.cardMeta }, project.path),
						h(
							"div",
							{ style: styles.cardMeta },
							project.instructions.exists ? `AGENTS.md ${formatBytes(project.instructions.bytes)}` : "无 AGENTS.md",
							project.mounted > 0 ? ` · 挂载 ${project.mounted}` : "",
						),
					),
				),
			);
		}

		function FileTree({ entries, mounted, onToggle, onToggleMany }) {
			if (entries.length === 0) return h("div", { style: styles.empty }, "这个目录里没有可挂载的文件。");
			const filesUnder = (dir) => entries.filter((entry) => entry.type === "file" && entry.path.startsWith(`${dir}/`)).map((entry) => entry.path);
			return h(
				"div",
				{ style: styles.tree },
				entries.map((entry) => {
					const indent = { paddingLeft: entry.depth * 14 };
					if (entry.type === "dir") {
						// 目录也可以一次挂/卸：点文件夹这一行的复选框 = 把这个文件夹下所有文件一起挂上（或一起取消）。
						const under = filesUnder(entry.path);
						const done = under.filter((file) => mounted.includes(file)).length;
						const all = under.length > 0 && done === under.length;
						return h(
							"label",
							{ key: entry.path, style: Object.assign({}, styles.treeRow, styles.dirRow, indent, { cursor: under.length > 0 ? "pointer" : "default" }) },
							h("input", {
								type: "checkbox",
								checked: all,
								disabled: under.length === 0,
								ref: (element) => {
									if (element) element.indeterminate = done > 0 && !all;
								},
								onChange: () => onToggleMany(under, !all),
							}),
							h("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, `${entry.path.split("/").pop()}/`),
							h("span", { style: styles.hint }, under.length === 0 ? " 空目录" : ` ${done}/${under.length}`),
						);
					}
					const checked = mounted.includes(entry.path);
					return h(
						"label",
						{ key: entry.path, style: Object.assign({}, styles.treeRow, indent, { cursor: "pointer" }) },
						h("input", { type: "checkbox", checked, onChange: (event) => onToggle(entry.path, event.target.checked) }),
						h("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, entry.path.split("/").pop()),
					);
				}),
			);
		}

		function CreateForm({ defaults, onCancel, onCreated }) {
			const [name, setName] = useState("");
			const [parentDir, setParentDir] = useState(() => readLastParent() || defaults.projectsRoot);
			const [instructions, setInstructions] = useState("");
			const [existingDir, setExistingDir] = useState("");
			const [pickBusy, setPickBusy] = useState(false);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");
			const [warnings, setWarnings] = useState([]);
			const nameRef = useRef(null);

			// 打开表单就把光标放在项目名称上，直接就能打字。
			useEffect(() => {
				nameRef.current?.focus();
			}, []);

			/** 用系统文件夹选择框挑一个"原本就有"的文件夹，把它接管成项目。 */
			const pickExistingFolder = async () => {
				setPickBusy(true);
				setError("");
				try {
					const picked = await postJson(`${API}/pick-folder`, { initialDir: parentDir });
					if (picked?.paths?.length) setExistingDir(picked.paths[0]);
				} catch (failure) {
					setError(failure.message);
				} finally {
					setPickBusy(false);
				}
			};

			const submit = async () => {
				setBusy(true);
				setError("");
				setWarnings([]);
				try {
					const result = existingDir
						? await postJson(`${API}/register-existing`, { dir: existingDir, instructions })
						: await postJson(`${API}/create`, { name, parentDir, instructions });
					if (!existingDir) rememberParent(parentDir.trim());
					onCreated(result);
				} catch (failure) {
					setError(failure.message);
				} finally {
					setBusy(false);
				}
			};

			return h(
				"div",
				{ style: styles.createCard },
				h(
					"div",
					null,
					h("h3", { style: styles.createTitle }, "新建项目"),
					h(
						"div",
						{ style: styles.createSub },
						"每个项目就是一个普通文件夹。新建会建同名文件夹；也可以直接接管一个你早就有的文件夹。AGENTS.md 是这个项目的常驻说明，留空就是一份空白模板，之后随时能改。",
					),
				),
				h(
					"div",
					{ style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
					h(
						"button",
						{ style: styles.buttonBigGhost, disabled: busy || pickBusy, onClick: pickExistingFolder },
						pickBusy ? "打开选择框…" : "用已有文件夹…",
					),
					h("span", { style: styles.hint }, "选一个已经在你硬盘上的文件夹，直接把它变成项目（不会挪动、不会新建目录）"),
				),
				existingDir
					? h(
							"div",
							{ style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
							h("span", { style: styles.chip }, existingDir),
							h(
								"button",
								{ style: styles.button, onClick: () => setExistingDir("") },
								"改回新建文件夹",
							),
						)
					: h(
							"label",
							{ style: { display: "flex", flexDirection: "column", gap: 6 } },
							h("span", { style: styles.fieldLabel }, "项目名称"),
							h("input", {
								style: styles.inputBig,
								ref: nameRef,
								value: name,
								onChange: (event) => setName(event.target.value),
							}),
						),
				existingDir
					? null
					: h(
							"label",
							{ style: { display: "flex", flexDirection: "column", gap: 6 } },
							h("span", { style: styles.fieldLabel }, "父目录（项目会建成 <父目录>\\<项目名称>）"),
							h("input", { style: styles.inputBig, value: parentDir, onChange: (event) => setParentDir(event.target.value) }),
						),
				h(
					"label",
					{ style: { display: "flex", flexDirection: "column", gap: 6 } },
					h("span", { style: styles.fieldLabel }, `首版 ${defaults.instructionsFileName}（可留空）`),
					h("textarea", {
						style: Object.assign({}, styles.textarea, { minHeight: 120 }),
						value: instructions,
						placeholder: "# 这个项目是干什么的\n\n## 约定\n\n- ...",
						spellCheck: false,
						onChange: (event) => setInstructions(event.target.value),
					}),
				),
				error ? h("div", { style: styles.err }, error) : null,
				warnings.length > 0 ? h("div", { style: styles.warn }, warnings.join("；")) : null,
				h(
					"div",
					{ style: { display: "flex", gap: 10, marginTop: 4 } },
					h("button", { style: styles.buttonBig, disabled: busy, onClick: submit }, busy ? "处理中…" : existingDir ? "设为此项目" : "创建项目"),
					h("button", { style: styles.buttonBigGhost, onClick: onCancel, disabled: busy }, "取消"),
				),
			);
		}

		function ProjectDetail({ project, onReload, onSaved, onMount }) {
			const [draft, setDraft] = useState(project.instructions.content);
			const [dirty, setDirty] = useState(false);
			const [busy, setBusy] = useState(false);
			const [message, setMessage] = useState("");
			const [error, setError] = useState("");
			const [mtime, setMtime] = useState(project.instructions.mtimeMs);
			const [mounted, setMounted] = useState(project.mounted);
			const [tree, setTree] = useState(project.tree);
			const [newFile, setNewFile] = useState("");
			const [fileBusy, setFileBusy] = useState(false);
			const dirtyRef = useRef(dirty);
			dirtyRef.current = dirty;
			const mtimeRef = useRef(mtime);
			mtimeRef.current = mtime;
			// 每次本地改挂载/存盘都会 +1；轮询回来时如果序号变了，说明这是一份旧快照，直接丢掉，
			// 否则会出现「刚勾上又被 2.5 秒轮询覆盖回去」的假象。
			const mutationRef = useRef(0);
			const bumpMutation = () => {
				mutationRef.current += 1;
			};

			useEffect(() => {
				setDraft(project.instructions.content);
				setDirty(false);
				setMtime(project.instructions.mtimeMs);
				setMounted(project.mounted);
				setTree(project.tree);
				setMessage("");
				setError("");
			}, [project.path, project.instructions.mtimeMs]);

			// 项目就是硬盘上的文件夹：往里放/删文件、别处改了 AGENTS.md，这里应该自己跟着变，
			// 而不是让人手动点「重新载入」。每 2.5 秒静默同步一次；正在编辑草稿时不动草稿。
			useEffect(() => {
				let cancelled = false;
				const tick = async () => {
					const seq = mutationRef.current;
					try {
						const data = await getProject(project.path);
						if (cancelled || seq !== mutationRef.current) return;
						setTree(data.tree);
						setMounted(data.mounted);
						if (!dirtyRef.current && data.instructions.mtimeMs !== mtimeRef.current) {
							setDraft(data.instructions.content);
							setMtime(data.instructions.mtimeMs);
						}
					} catch {
						/* 目录被临时移走/改名时忽略，下一轮再试 */
					}
				};
				const timer = setInterval(tick, 2500);
				const onFocus = () => {
					if (!dirtyRef.current) tick();
				};
				window.addEventListener("focus", onFocus);
				return () => {
					cancelled = true;
					clearInterval(timer);
					window.removeEventListener("focus", onFocus);
				};
			}, [project.path]);

			const save = async () => {
				bumpMutation();
				setBusy(true);
				setError("");
				setMessage("");
				try {
					const result = await postJson(`${API}/save-instructions`, {
						dir: project.path,
						content: draft,
						expectedMtimeMs: mtime,
					});
					setMtime(result.mtimeMs);
					setMounted(result.mounted);
					setDirty(false);
					setMessage("已保存，下一次在该项目里新开对话就会读到新内容。");
					onSaved();
				} catch (failure) {
					if (failure.status === 409 && failure.payload?.code === "STALE_INSTRUCTIONS") {
						setError("磁盘上的 AGENTS.md 已被别处改过。请点「重新载入」拿到最新内容，再合并你的改动。");
					} else {
						setError(failure.message);
					}
				} finally {
					setBusy(false);
				}
			};

			const toggleMount = async (file, value) => {
				bumpMutation();
				setError("");
				setMessage("");
				try {
					const result = await postJson(`${API}/mount`, { dir: project.path, file, mounted: value });
					setMounted(result.mounted);
					setDraft(result.content);
					setMtime(result.mtimeMs);
					setMessage(value ? `已挂载 ${file}` : `已取消挂载 ${file}`);
					onMount();
				} catch (failure) {
					setError(failure.message);
				}
			};

			/** 一次挂/卸一批文件（点文件夹那一行的复选框时用）。 */
			const toggleMany = async (files, value) => {
				if (files.length === 0) return;
				bumpMutation();
				setError("");
				setMessage("");
				try {
					const result = await postJson(`${API}/mount-many`, { dir: project.path, files, mounted: value });
					setMounted(result.mounted);
					setDraft(result.content);
					setMtime(result.mtimeMs);
					setMessage(value ? `已挂载 ${files.length} 个文件` : `已取消挂载 ${files.length} 个文件`);
					onMount();
				} catch (failure) {
					setError(failure.message);
				}
			};

			/** 在项目里新建一个文件，建好立刻挂载（新建 + 挂载一步完成）。 */
			const createFile = async () => {
				const rel = newFile.trim();
				if (rel.length === 0) {
					setError("先填一个文件名，例如 notes.md 或 data/records.jsonl");
					return;
				}
				bumpMutation();
				setFileBusy(true);
				setError("");
				setMessage("");
				try {
					await postJson(`${API}/new-file`, { dir: project.path, file: rel });
					const result = await postJson(`${API}/mount`, { dir: project.path, file: rel, mounted: true });
					setMounted(result.mounted);
					setDraft(result.content);
					setMtime(result.mtimeMs);
					setNewFile("");
					setMessage(`已新建并挂载 ${rel}`);
					onMount();
				} catch (failure) {
					setError(failure.message);
				} finally {
					setFileBusy(false);
				}
			};

			/** 打开系统文件选择框，选中的文件会被导入项目并挂载。 */
			const pickFiles = async () => {
				bumpMutation();
				setFileBusy(true);
				setError("");
				setMessage("正在打开文件选择框…（在系统的选择框里选完文件后回这里）");
				try {
					const picked = await postJson(`${API}/pick-files`, { dir: project.path });
					if (!picked?.paths?.length) {
						setMessage("没有选择文件。");
						return;
					}
					const result = await postJson(`${API}/import-files`, { dir: project.path, paths: picked.paths });
					setMounted(result.mounted);
					setDraft(result.content);
					setMtime(result.mtimeMs);
					const copied = (result.imported ?? []).filter((item) => item.copied).map((item) => item.rel);
					setMessage(
						copied.length > 0
							? `已挂载 ${result.imported.length} 个文件（项目外的已复制进项目：${copied.join("、")}）`
							: `已挂载 ${result.imported.length} 个文件`,
					);
					onMount();
				} catch (failure) {
					setError(failure.message);
				} finally {
					setFileBusy(false);
				}
			};

			/** 打开系统文件夹选择框，把选中的文件夹下所有文件一次挂上。 */
			const pickFolderMount = async (confirmed = false, folder) => {
				bumpMutation();
				setFileBusy(true);
				setError("");
				setMessage(confirmed ? "正在挂载整个文件夹…" : "正在打开文件夹选择框…（选完文件夹后回这里）");
				try {
					const result = await postJson(`${API}/mount-folder`, { dir: project.path, folder, confirmed });
					if (result?.cancelled) {
						setMessage("没有选择文件夹。");
						return;
					}
					if (result?.needsConfirm) {
						const proceed = window.confirm(
							`这个文件夹里有 ${result.count} 个文件。全挂上会让 AGENTS.md 的挂载清单变长——每次在本项目新开对话都会把这份清单注入一遍。继续吗？`,
						);
						if (proceed) {
							await pickFolderMount(true, result.folder);
						} else {
							setMessage("已取消。");
						}
						return;
					}
					setMounted(result.mounted);
					setDraft(result.content);
					setMtime(result.mtimeMs);
					setMessage(`已挂载 ${result.added ?? 0} 个文件（来自 ${result.folder}）`);
					onMount();
				} catch (failure) {
					setError(failure.message);
				} finally {
					setFileBusy(false);
				}
			};

			const bytes = textBytes(draft);
			const overBudget = bytes > project.instructions.budgetBytes;
			const instructionFile = project.instructions.fileName ?? "AGENTS.md";
			const mountable = tree.filter((entry) => !(entry.type === "file" && entry.path === instructionFile));
			const fileEntries = mountable.filter((entry) => entry.type === "file");
			// 整个项目一键挂/卸：项目里文件多的时候不用一个个点。
			const mountEverything = () => toggleMany(fileEntries.map((entry) => entry.path).filter((file) => !mounted.includes(file)), true);
			const clearEverything = () => toggleMany(mounted.slice(), false);

			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 12 } },
				h(
					"div",
					{ style: styles.sectionHead },
					h("div", { style: styles.sectionTitle }, project.title),
					project.git ? h("span", { style: Object.assign({}, styles.chip, { fontSize: 10 }) }, "git") : null,
					h("div", { style: Object.assign({}, styles.hint, { wordBreak: "break-all" }) }, project.path),
				),
				h(
					"div",
					{ style: styles.section },
					h(
						"div",
						{ style: styles.sectionHead },
						h("div", { style: styles.sectionTitle }, "基础指令"),
						h("span", { style: styles.hint }, project.instructions.fileName ?? "AGENTS.md"),
						h("span", { style: styles.spacer }),
						h("span", { style: Object.assign({}, styles.hint, overBudget ? styles.err : undefined) }, `${formatBytes(bytes)} / 64 KB`),
						dirty ? h("span", { style: styles.warn }, "未保存") : null,
					),
					h("textarea", {
						style: styles.textarea,
						value: draft,
						spellCheck: false,
						onChange: (event) => {
							setDraft(event.target.value);
							setDirty(true);
						},
					}),
					h(
						"div",
						{ style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
						h("button", { style: primaryButton(), disabled: busy || !dirty, onClick: save }, busy ? "保存中…" : "保存"),
						h(
							"button",
							{
								style: styles.button,
								disabled: busy,
								onClick: () => {
									if (dirtyRef.current && !window.confirm("放弃未保存的改动？")) return;
									onReload();
								},
							},
							"立即刷新",
						),
						message ? h("span", { style: styles.hint }, message) : null,
						error ? h("span", { style: styles.err }, error) : null,
					),
					h(
						"div",
						{ style: styles.hint },
						"这是真的文件：项目根目录的 AGENTS.md（可进 git）。DSH 在该项目下每次新对话都会把它注入给模型。",
					),
				),
				h(
					"div",
					{ style: styles.section },
					h(
						"div",
						{ style: styles.sectionHead },
						h("div", { style: styles.sectionTitle }, "包含文件（挂载）"),
						h(
							"span",
							{ style: styles.hint },
							mounted.length > 0 ? `已挂载 ${mounted.length} / 共 ${fileEntries.length} 个文件` : `还没有挂载文件（共 ${fileEntries.length} 个）`,
						),
					),
					h(
						"div",
						{ style: styles.hint },
						"挂载 ≠ 把内容复制进来。挂载只是把这个文件的相对路径写进上面 AGENTS.md 的受管段；DSH 每次在本项目新开对话都会注入 AGENTS.md，模型看到清单就会先去读这些文件——平时不占上下文，需要时一定找得到。AGENTS.md 本身是上面那份指令文件，不参与挂载。点文件夹那一行的复选框 = 把这个文件夹下所有文件一次挂上。",
					),
					h(
						"div",
						{ style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
						h(
							"button",
							{ style: primaryButton(), disabled: fileBusy, onClick: pickFiles },
							fileBusy ? "处理中…" : "选择文件…",
						),
						h(
							"button",
							{ style: styles.button, disabled: fileBusy, onClick: () => pickFolderMount() },
							"选择文件夹…",
						),
						fileEntries.length > 0
							? h(
									"button",
									{ style: styles.button, disabled: fileBusy || mounted.length >= fileEntries.length, onClick: mountEverything },
									"全部挂载",
								)
							: null,
						mounted.length > 0
							? h("button", { style: styles.button, disabled: fileBusy, onClick: clearEverything }, "清空挂载")
							: null,
						h("span", { style: styles.hint }, "选择文件… 选具体文件（项目外的会自动复制进项目）；选择文件夹… 选一个目录，把它下面所有文件一次挂上"),
					),
					mounted.length > 0
						? h(
								"div",
								{ style: { display: "flex", gap: 6, flexWrap: "wrap" } },
								mounted.map((file) =>
									h(
										"span",
										{ key: file, style: styles.chip },
										file,
										h("span", { style: styles.chipX, onClick: () => toggleMount(file, false) }, "×"),
									),
								),
							)
						: null,
					fileEntries.length === 0
						? h(
								"div",
								{ style: styles.empty },
								`这个项目里目前只有 ${instructionFile}，没有别的文件。往文件夹里放文件后这里会自动出现（约 2 秒），也可以用下面的「新建文件并挂载」或「选择文件…」。`,
							)
						: h(FileTree, { entries: mountable, mounted, onToggle: toggleMount, onToggleMany: toggleMany }),
					h("div", { style: styles.hint }, "往项目文件夹里放/删文件，这里会自动跟着变，不用手动刷新；只有浏览器标签切回来时才会立刻同步。"),
					h(
						"div",
						{ style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
						h("input", {
							style: Object.assign({}, styles.input, { flex: "1 1 240px" }),
							value: newFile,
							placeholder: "新建文件，例如 notes.md 或 data/records.jsonl",
							onChange: (event) => setNewFile(event.target.value),
							onKeyDown: (event) => {
								if (event.key === "Enter") createFile();
							},
						}),
						h(
							"button",
							{ style: styles.button, disabled: fileBusy, onClick: createFile },
							fileBusy ? "创建中…" : "新建文件并挂载",
						),
					),
				),
			);
		}

		function ProjectDeskPage() {
			const [state, setState] = useState({ status: "loading" });
			const [selected, setSelected] = useState(undefined);
			const [project, setProject] = useState({ status: "idle" });
			// 一进面板就直接把「新建项目」铺在右侧大区域，而不是藏在角落里的小按钮。
			const [creating, setCreating] = useState(true);
			const [notice, setNotice] = useState("");

			const loadState = useCallback(async () => {
				try {
					const data = await getState();
					setState({ status: "ready", data });
					return data;
				} catch (error) {
					setState({ status: "error", error: error.message });
					return undefined;
				}
			}, []);

			const loadProject = useCallback(async (dir) => {
				if (!dir) {
					setProject({ status: "idle" });
					return;
				}
				setProject({ status: "loading" });
				try {
					const data = await getProject(dir);
					setProject({ status: "ready", data });
				} catch (error) {
					setProject({ status: "error", error: error.message });
				}
			}, []);

			useEffect(() => {
				let cancelled = false;
				loadState().then((data) => {
					if (cancelled || !data || selected !== undefined) return;
					if (data.projects.length > 0) {
						setSelected(data.projects[0].path);
						loadProject(data.projects[0].path);
					}
				});
				return () => {
					cancelled = true;
				};
			}, [loadState, loadProject, selected]);

			const select = (dir) => {
				setSelected(dir);
				setCreating(false);
				setNotice("");
				loadProject(dir);
			};

			const header = h(
				"div",
				{ style: styles.header },
				h("div", null, h("h2", { style: styles.title }, "项目工作台"), h("div", { style: styles.subtitle }, "新建项目 · 编辑项目基础指令 · 挂载要带进对话的文件")),
				h("div", { style: styles.spacer }),
				notice ? h("div", { style: styles.hint }, notice) : null,
				h(
					"button",
					{
						style: primaryButton(),
						onClick: () => setCreating((value) => !value),
					},
					creating ? "返回项目" : "新建项目",
				),
			);

			if (state.status === "loading") {
				return h("div", { style: styles.page }, header, h("div", { style: styles.empty }, "读取项目列表…"));
			}
			if (state.status === "error") {
				return h("div", { style: styles.page }, header, h("div", { style: styles.err }, `读取失败：${state.error}`));
			}

			const data = state.data;
			const detail = creating
				? h(CreateForm, {
						defaults: data.defaults,
						onCancel: () => setCreating(false),
						onCreated: async (result) => {
							setCreating(false);
							const tail = result.warnings?.length ? `（提醒：${result.warnings.join("；")}）` : "";
							setNotice(`项目已就绪，正在打开新对话…${tail}`);
							const next = await loadState();
							if (next) select(result.project.path);
							const opened = await openNewConversation(result.project.workspaceId);
							if (!opened) {
								setNotice(
									`项目已创建${tail}。若侧栏还没出现工作区，刷新页面后在该工作区那一行点「+」开始对话。`,
								);
							}
						},
					})
				: project.status === "ready"
					? h(ProjectDetail, {
							key: project.data.path,
							project: project.data,
							onReload: () => loadProject(project.data.path),
							onSaved: () => {
								loadState();
							},
							onMount: () => loadProject(project.data.path),
						})
					: h(
							"div",
							{ style: styles.empty },
							project.status === "loading"
								? "读取项目…"
								: project.status === "error"
									? `读取失败：${project.error}`
									: "从左边选一个项目，或点右上角「新建项目」。",
						);

			return h(
				"div",
				{ style: styles.page },
				header,
				h(
					"div",
					{ style: styles.body },
					h(ProjectList, { projects: data.projects, selected, creating, onSelect: select }),
					h("div", { style: Object.assign({}, styles.col, styles.detailCol) }, detail),
				),
				h(
					"div",
					{ style: styles.hint },
					`默认项目根目录：${data.defaults.projectsRoot}　·　新建项目会自动打开该项目的新对话；若没打开，在侧栏对应工作区那一行点「+」。`,
				),
			);
		}

		/* -------------------------------------------------------------- apply */

		function apply(ctx) {
			ctx.inject(["uiWorkspace"], (serviceCtx) => {
				uiWorkspaceService = serviceCtx.uiWorkspace;
				return () => {
					uiWorkspaceService = null;
				};
			});
			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.panellist", () =>
						ctx.slots.register(
							{
								name: "sidebar.panellist",
								id: PANEL_ID,
								order: 21,
								label: () => "项目",
							},
							panelIcon,
						),
					),
				"project-desk: sidebar entry",
			);
			ctx.effect(
				() =>
					ctx.slots.inject("main", () =>
						ctx.slots.register(
							{
								name: "main",
								key: PANEL_ID,
							},
							ProjectDeskPage,
						),
					),
				"project-desk: main page",
			);
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		exports.name = NS;
		exports.PANEL_ID = PANEL_ID;
		return module.exports;
	},
});
