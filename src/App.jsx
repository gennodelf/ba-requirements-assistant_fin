import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/* =====================================================================
   ДИЗАЙН-СИСТЕМА
   Инструмент для аналитика — рабочая среда, не лендинг.
   Палитра: #FAFAF8 фон, #1C1C1A текст, #5B4FCF акцент (приглушённый индиго),
   #C2410C terracotta для предупреждений/конфликтов, #15803D для готового статуса.
   Шрифты: Inter для интерфейса, JetBrains Mono для ID-блоков (FR/BR/NFR).

   ГИБРИД + СТРИМИНГ: ответ приходит потоком. Первая строка — метка типа
   (@@CLASSIFICATION / @@CONFLICT / @@DOCUMENT / @@MESSAGE). Карточки рисуются
   из JSON по готовности; документ и реплики печатаются по словам.
   ===================================================================== */

const SAMPLE_INPUT = `Созвон с продактом по FBP — нужно разрешить привязывать несколько магазинов одного МП к одному складу. Сейчас связка: 1 склад – 1 магазин ВБ – 1 магазин Яндекс. Хотим: 1 склад – N магазинов ВБ – N магазинов Яндекс. Это нужно для будущего матчинга артикулов между магазинами селлера.`;

const ALL_AVAILABLE_BLOCKS = [
  "Контекст", "Цель", "Scope", "Роли", "AS-IS/TO-BE", "Сценарии",
  "Бизнес-правила", "Функциональные требования", "Открытые вопросы",
  "Термины и определения", "Статусы и жизненный цикл", "Финансовые требования",
  "UI/UX", "Интеграционные требования", "Нефункциональные требования",
  "Логи, аудит и аналитика", "Миграция и запуск", "Админка / операционный контур",
  "Уведомления", "Security / permissions", "Legal / compliance", "QA checklist",
  "Rollout plan", "Risk register",
];

// Нормализация имени блока (без регистра, пунктуации и пробелов) — чтобы
// «ФТ» / «Функциональные требования» / «Scope / Out of Scope» сравнивались корректно.
const normBlock = (s) => (s || "").toLowerCase().replace(/[^a-zа-яё0-9]/gi, "");

// «блок уже есть среди names» — пересечение норм-имён в любую сторону (одно содержит другое)
function blockAlreadyIn(block, names) {
  const nb = normBlock(block);
  if (!nb) return false;
  return (names || [])
    .map(normBlock)
    .filter(Boolean)
    .some((n) => n.includes(nb) || nb.includes(n));
}

// Заголовки разделов из готового документа (## …), без ведущей нумерации «7. »
function docHeadings(md) {
  return (md || "")
    .split("\n")
    .map((l) => l.match(/^#{1,3}\s+(.+)/))
    .filter(Boolean)
    .map((m) => m[1].replace(/^\d+[.)]\s*/, "").trim());
}

// Уникальный ID, не сбрасывается между перезагрузками (иначе чаты конфликтуют по id)
const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);

/* ----------------------- ХРАНЕНИЕ ЧАТОВ (localStorage) ----------------------- */

const STORAGE_KEY = "ba_chats_v1";
const CUR_KEY = "ba_current_v1";
const KEY_STORAGE = "ba_api_key"; // legacy
const AUTH_STORAGE = "ba_auth_v1"; // { mode: 'key'|'password', value }

function loadAuth() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE);
    if (raw) {
      const a = JSON.parse(raw);
      if (a && a.mode && a.value) return a;
    }
    const legacy = localStorage.getItem(KEY_STORAGE);
    if (legacy) return { mode: "key", value: legacy };
  } catch {
    /* */
  }
  return null;
}
const EMPTY_MESSAGES = []; // стабильная ссылка, чтобы не дёргать эффекты

function loadChats() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    // Лечим возможные дубли id из старой версии — каждому чату гарантируем уникальный id
    const seen = new Set();
    return arr.map((c) => {
      let id = c.id;
      if (!id || seen.has(id)) id = uid();
      seen.add(id);
      return { ...c, id };
    });
  } catch {
    return [];
  }
}

function newEmptyChat() {
  return { id: uid(), title: "Новый документ", messages: [], updatedAt: Date.now() };
}

// Заголовок чата из первого сообщения пользователя
function titleFrom(t) {
  const s = (t || "").replace(/\s+/g, " ").trim();
  if (!s) return "Новый документ";
  return s.length > 42 ? s.slice(0, 42) + "…" : s;
}

/* ----------------------- РАЗБОР ПОТОКОВОГО ОТВЕТА ----------------------- */

function extractJson(s) {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return a === -1 || b === -1 ? s : s.slice(a, b + 1);
}

// Убирает горизонтальные разделители (--- / *** / ___) между разделами документа.
// Строку-разделитель удаляем только если над ней пустая строка (иначе это не линия, а заголовок).
function stripHr(md) {
  const lines = (md || "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const isHr = /^\s*([-*_])\1{2,}\s*$/.test(lines[i]);
    const prevBlank = i === 0 || lines[i - 1].trim() === "";
    if (isHr && prevBlank) continue;
    out.push(lines[i]);
  }
  return out.join("\n");
}

// Подстраховка: если модель забыла метку @@DOCUMENT и прислала документ как сообщение,
// распознаём «полноценный документ» по структуре (много разделов + объём).
function looksLikeDocument(md) {
  const body = md || "";
  const h2 = (body.match(/(^|\n)## /g) || []).length;
  return h2 >= 3 && body.length > 500;
}
function titleFromMd(md) {
  const h1 = (md || "").match(/(^|\n)#\s+([^\n]+)/);
  if (h1) return h1[2].trim();
  const first = ((md || "").trim().split("\n")[0] || "").replace(/^#+\s*/, "").trim();
  return first.slice(0, 80) || "Документ требований";
}

// По «сырому» тексту ответа (строка метки + тело) понимаем, что рисовать.
// pending = метка ещё не пришла или карточка ещё стримится (показываем индикатор).
function parseEnvelope(raw, streaming) {
  const text = raw ?? "";
  const nl = text.indexOf("\n");
  const firstLine = (nl === -1 ? text : text.slice(0, nl)).trim();
  const body = nl === -1 ? "" : text.slice(nl + 1);

  if (firstLine.startsWith("@@CLASSIFICATION")) {
    if (streaming) return { kind: "pending" };
    try {
      return { kind: "classification", data: JSON.parse(extractJson(body)) };
    } catch {
      return { kind: "message", markdown: body || text };
    }
  }
  if (firstLine.startsWith("@@CONFLICT")) {
    if (streaming) return { kind: "pending" };
    try {
      return { kind: "conflict", data: JSON.parse(extractJson(body)) };
    } catch {
      return { kind: "message", markdown: body || text };
    }
  }
  if (firstLine.startsWith("@@DOCUMENT")) {
    const title = firstLine.includes("::")
      ? firstLine.split("::").slice(1).join("::").trim()
      : "Документ требований";
    return { kind: "document", data: { title, markdown: stripHr(body) }, streaming };
  }
  if (firstLine.startsWith("@@MESSAGE")) {
    if (looksLikeDocument(body)) {
      return { kind: "document", data: { title: titleFromMd(body), markdown: stripHr(body) }, streaming };
    }
    return { kind: "message", markdown: body, streaming };
  }

  // Метка ещё не пришла целиком — ждём; если метки нет вовсе, показываем как текст.
  if (streaming && nl === -1) return { kind: "pending" };
  const fallback = body || text;
  if (looksLikeDocument(fallback)) {
    return { kind: "document", data: { title: titleFromMd(fallback), markdown: stripHr(fallback) }, streaming };
  }
  return { kind: "message", markdown: fallback };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Временные сбои, которые имеет смысл повторить (перегрузка, лимит, сетевой сбой,
// «пробуждение» сервера). Таймаут/504 НЕ повторяем — это была долгая генерация.
function isRetriable(msg) {
  const m = (msg || "").toLowerCase();
  return /overloaded|rate.?limit|429|529|\b500\b|internal server|fetch failed|failed to fetch|load failed/.test(m);
}

async function streamChat(apiMessages, onText, auth) {
  const headers = { "Content-Type": "application/json" };
  if (auth?.mode === "password") headers["x-app-password"] = auth.value;
  else if (auth?.mode === "key") headers["x-user-api-key"] = auth.value;
  const body = JSON.stringify({ messages: apiMessages });

  for (let attempt = 0; ; attempt++) {
    let resp;
    try {
      resp = await fetch("/api/chat", { method: "POST", headers, body });
    } catch (e) {
      if (attempt < 2) {
        await wait(2000 * (attempt + 1));
        continue;
      }
      throw new Error(e?.message || "fetch failed", { cause: e });
    }

    if (!resp.ok || !resp.body) {
      let msg = `Ошибка ${resp.status}`;
      try {
        const j = await resp.json();
        msg = j.error || msg;
      } catch {
        /* тело не JSON */
      }
      if (isRetriable(msg) && attempt < 2) {
        await wait(2000 * (attempt + 1));
        continue;
      }
      throw new Error(msg);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const d = t.slice(5).trim();
        if (!d || d === "[DONE]") continue;
        let evt;
        try {
          evt = JSON.parse(d);
        } catch {
          continue;
        }
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
          full += evt.delta.text;
          onText(full);
        } else if (evt.type === "error") {
          throw new Error(evt.error?.message || "Ошибка потока");
        }
      }
    }
    return full;
  }
}

// История для API: user → текст (+ вложения), assistant → его «сырой» ответ с меткой
function toApi(m) {
  if (m.role !== "user") return { role: "assistant", content: m.raw };

  const files = (m.files || []).filter((f) => f.data); // только с данными (после перезагрузки данных нет)
  if (files.length === 0) return { role: "user", content: m.content };

  const blocks = [];
  for (const f of files) {
    if (f.kind === "image") {
      blocks.push({ type: "image", source: { type: "base64", media_type: f.mediaType, data: f.data } });
    } else if (f.kind === "pdf") {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
    }
  }
  blocks.push({ type: "text", text: m.content || "Учти приложенный файл при анализе." });
  return { role: "user", content: blocks };
}

// Читает файл в base64. Поддержка: картинки и PDF. Лимит 10 МБ.
function readFilePart(file) {
  return new Promise((resolve) => {
    const mediaType = file.type;
    const kind = mediaType.startsWith("image/") ? "image" : mediaType === "application/pdf" ? "pdf" : null;
    if (!kind || file.size > 10 * 1024 * 1024) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || "");
      const base64 = res.includes(",") ? res.slice(res.indexOf(",") + 1) : res;
      resolve({ id: uid(), name: file.name, kind, mediaType, data: base64 });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/* ============================== APP ================================ */

export default function App() {
  const [chats, setChats] = useState(() => {
    const c = loadChats();
    return c.length ? c : [newEmptyChat()];
  });
  const [currentId, setCurrentId] = useState(() => {
    try {
      return localStorage.getItem(CUR_KEY) || null;
    } catch {
      return null;
    }
  });
  const [input, setInput] = useState("");
  const [composer, setComposer] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null); // null | {scope:'one'|'all', id, title}
  const [activeDocId, setActiveDocId] = useState(null); // выбранная вкладка версии документа
  const [attachments, setAttachments] = useState([]); // файлы для следующего сообщения
  const [auth, setAuth] = useState(loadAuth); // { mode, value } | null
  const [showKeyGate, setShowKeyGate] = useState(false); // экран смены доступа
  const scrollRef = useRef(null);
  const composerRef = useRef(null);
  const chatsRef = useRef(chats);
  const currentIdRef = useRef(currentId);

  // Активный чат: выбранный, иначе самый верхний (фолбэк, если id устарел)
  const currentChat = chats.find((c) => c.id === currentId) || chats[0] || null;
  const effectiveId = currentChat ? currentChat.id : null;
  const messages = currentChat ? currentChat.messages : EMPTY_MESSAGES;
  const started = messages.length > 0;

  // Версии документа = все ответы-документы текущего чата (по порядку, последний — актуальный)
  const documents = messages
    .filter((m) => m.role === "assistant")
    .map((m) => ({ msgId: m.id, name: m.versionName, env: parseEnvelope(m.raw, m.streaming) }))
    .filter((x) => x.env.kind === "document")
    .map((x) => ({
      msgId: x.msgId,
      name: x.name,
      title: x.env.data.title,
      markdown: x.env.data.markdown,
      streaming: x.env.streaming,
    }));
  const newestDoc = documents[documents.length - 1] || null;
  const pickedDoc = documents.find((d) => d.msgId === activeDocId) || null;
  const selectedDoc = pickedDoc || newestDoc;

  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);
  useEffect(() => {
    currentIdRef.current = effectiveId;
  }, [effectiveId]);

  // Персист: не пишем во время стрима; пустые чаты не сохраняем
  useEffect(() => {
    if (loading) return;
    try {
      // base64 вложений не сохраняем (иначе быстро переполним хранилище) — храним только имя/тип
      const persistable = chats
        .filter((c) => c.messages.length > 0)
        .map((c) => ({
          ...c,
          messages: c.messages.map((m) =>
            m.files && m.files.length
              ? { ...m, files: m.files.map((f) => ({ id: f.id, name: f.name, kind: f.kind })) }
              : m
          ),
        }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
    } catch {
      /* превышена квота — игнорируем */
    }
  }, [chats, loading]);

  useEffect(() => {
    try {
      localStorage.setItem(CUR_KEY, effectiveId ?? "");
    } catch {
      /* */
    }
  }, [effectiveId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function send(text) {
    const trimmed = (text ?? "").trim();
    const files = attachments;
    if ((!trimmed && files.length === 0) || loading) return;

    // Гарантируем активный чат
    let activeId = currentIdRef.current;
    let base = [];
    const existing = chatsRef.current.find((c) => c.id === activeId);
    if (existing) {
      base = existing.messages;
    } else {
      const chat = newEmptyChat();
      activeId = chat.id;
      currentIdRef.current = chat.id;
      setChats((prev) => [chat, ...prev]);
      setCurrentId(chat.id);
    }

    const userMsg = { id: uid(), role: "user", content: trimmed, files };
    const aId = uid();
    const apiMessages = [...base, userMsg].map(toApi);
    const autoTitle = titleFrom(trimmed || files[0]?.name);

    setChats((prev) =>
      prev.map((c) =>
        c.id === activeId
          ? {
              ...c,
              title: c.messages.length === 0 ? autoTitle : c.title,
              messages: [...c.messages, userMsg, { id: aId, role: "assistant", raw: "", streaming: true }],
              updatedAt: Date.now(),
            }
          : c
      )
    );
    setInput("");
    setAttachments([]);
    setActiveDocId(null);
    setLoading(true);
    setError(null);

    const patch = (fn) =>
      setChats((prev) => prev.map((c) => (c.id === activeId ? { ...c, messages: fn(c.messages) } : c)));

    try {
      const full = await streamChat(
        apiMessages,
        (txt) => {
          patch((msgs) => msgs.map((m) => (m.id === aId ? { ...m, raw: txt } : m)));
        },
        auth
      );
      setChats((prev) =>
        prev.map((c) =>
          c.id === activeId
            ? {
                ...c,
                messages: c.messages.map((m) => (m.id === aId ? { ...m, raw: full, streaming: false } : m)),
                updatedAt: Date.now(),
              }
            : c
        )
      );
    } catch (e) {
      setError(e.message || "Не удалось получить ответ");
      patch((msgs) => msgs.filter((m) => m.id !== aId));
    } finally {
      setLoading(false);
    }
  }

  function selectChat(id) {
    if (loading) return;
    setCurrentId(id);
    setComposer("");
    setInput("");
    setError(null);
  }

  function newChat() {
    if (loading) return;
    const empty = chats.find((c) => c.messages.length === 0);
    if (empty) {
      setCurrentId(empty.id);
    } else {
      const chat = newEmptyChat();
      setChats((prev) => [chat, ...prev]);
      setCurrentId(chat.id);
    }
    setComposer("");
    setInput("");
    setError(null);
  }

  function deleteChat(id) {
    const remaining = chats.filter((c) => c.id !== id);
    if (remaining.length === 0) {
      const fresh = newEmptyChat();
      setChats([fresh]);
      setCurrentId(fresh.id);
      return;
    }
    setChats(remaining);
    if (id === effectiveId) {
      const next = [...remaining].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      setCurrentId(next.id);
    }
  }

  function deleteAllChats() {
    const fresh = newEmptyChat();
    setChats([fresh]);
    setCurrentId(fresh.id);
  }

  // Удаление всегда через подтверждение в модалке
  function requestDeleteChat(chat) {
    if (loading) return;
    setPendingDelete({ scope: "one", id: chat.id, title: chat.title });
  }
  function requestDeleteAll() {
    if (loading) return;
    setPendingDelete({ scope: "all" });
  }
  function confirmDelete() {
    if (!pendingDelete) return;
    if (pendingDelete.scope === "all") deleteAllChats();
    else if (pendingDelete.scope === "version") deleteDocVersion(pendingDelete.id);
    else deleteChat(pendingDelete.id);
    setPendingDelete(null);
  }

  function renameChat(id, title) {
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
  }

  // Удалить версию документа = убрать это сообщение-документ из текущего чата
  function deleteDocVersion(msgId) {
    setChats((prev) =>
      prev.map((c) =>
        c.id === effectiveId ? { ...c, messages: c.messages.filter((m) => m.id !== msgId), updatedAt: Date.now() } : c
      )
    );
  }
  function requestDeleteVersion(msgId, label) {
    if (loading) return;
    setPendingDelete({ scope: "version", id: msgId, title: label });
  }
  function renameVersion(msgId, name) {
    setChats((prev) =>
      prev.map((c) =>
        c.id === effectiveId
          ? { ...c, messages: c.messages.map((m) => (m.id === msgId ? { ...m, versionName: name } : m)) }
          : c
      )
    );
  }

  async function addFiles(fileList) {
    const parts = await Promise.all(Array.from(fileList).map(readFilePart));
    setAttachments((prev) => [...prev, ...parts.filter(Boolean)]);
  }
  function removeAttachment(id) {
    setAttachments((prev) => prev.filter((f) => f.id !== id));
  }

  // #3: добавление раздела к готовому документу — НАКАПЛИВАЕМ запросы, а не перезаписываем
  function addBlockToComposer(tag) {
    setComposer((prev) => {
      const phrase = `Добавь раздел «${tag}».`;
      return prev.trim() ? prev.trim() + " " + phrase : phrase;
    });
    composerRef.current?.focus();
  }

  function saveAuth(a) {
    try {
      localStorage.setItem(AUTH_STORAGE, JSON.stringify(a));
      localStorage.removeItem(KEY_STORAGE); // чистим старый формат
    } catch {
      /* */
    }
    setAuth(a);
    setShowKeyGate(false);
  }

  // Первый вход без доступа — показываем стартовый экран
  if (!auth) {
    return (
      <div style={styles.root}>
        <style>{fontImports}</style>
        <KeyGate onSave={saveAuth} />
      </div>
    );
  }

  return (
    <div style={styles.root}>
      <style>{fontImports}</style>
      <TopBar loading={loading} onChangeKey={() => setShowKeyGate(true)} />

      <div style={styles.shell}>
        <Sidebar
          chats={chats}
          currentId={effectiveId}
          loading={loading}
          onSelect={selectChat}
          onNew={newChat}
          onRequestDelete={requestDeleteChat}
          onRequestDeleteAll={requestDeleteAll}
          onRename={renameChat}
        />

        <div style={styles.main}>
          <div style={styles.chatCol}>
            {!started ? (
              <EmptyState
                value={input}
                setValue={setInput}
                onSubmit={() => send(input || SAMPLE_INPUT)}
                attachments={attachments}
                onAddFiles={addFiles}
                onRemoveFile={removeAttachment}
                loading={loading}
              />
            ) : (
              <div style={styles.chatLayout}>
                <div style={styles.chatScroll} ref={scrollRef}>
                  {messages.map((m) =>
                    m.role === "user" ? (
                      <UserBubble key={m.id} text={m.content} files={m.files} />
                    ) : (
                      <AgentMessage
                        key={m.id}
                        message={m}
                        onConfirmStructure={({ include, exclude }) =>
                          send(
                            `Структура подтверждена. Собери документ СТРОГО из этих разделов: ${include.join(", ")}. ` +
                              (exclude.length
                                ? `НЕ включай разделы: ${exclude.join(", ")}. Не добавляй других разделов сверх списка. `
                                : "") +
                              `Если остались критичные вопросы — задай их; иначе подготовь черновик документа.`
                          )
                        }
                        onOpenDoc={() => setActiveDocId(m.id)}
                      />
                    )
                  )}
                  {error && <ErrorBanner text={error} />}
                </div>

                <Composer
                  inputRef={composerRef}
                  value={composer}
                  setValue={setComposer}
                  loading={loading}
                  onSend={() => {
                    const v = composer;
                    setComposer("");
                    send(v);
                  }}
                  attachments={attachments}
                  onAddFiles={addFiles}
                  onRemoveFile={removeAttachment}
                />
              </div>
            )}
          </div>

          {documents.length > 0 && (
            <DocumentPanel
              documents={documents}
              selectedId={selectedDoc?.msgId}
              onSelect={setActiveDocId}
              onRequestDelete={requestDeleteVersion}
              onRenameVersion={renameVersion}
              onAddBlock={addBlockToComposer}
            />
          )}
        </div>
      </div>

      {showKeyGate && (
        <KeyGate existing={auth} onSave={saveAuth} onCancel={() => setShowKeyGate(false)} />
      )}

      {pendingDelete && (
        <ConfirmModal
          scope={pendingDelete.scope}
          title={pendingDelete.title}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

/* ----------------------------- TOP BAR ----------------------------- */

function TopBar({ loading, onChangeKey }) {
  return (
    <div style={styles.topBar}>
      <div style={styles.brandRow}>
        <div style={styles.brandMark}>BA</div>
        <div>
          <div style={styles.brandName}>Requirements Assistant</div>
          <div style={styles.brandStatus}>
            {loading ? "Агент думает…" : "Черновики требований из сырого текста"}
          </div>
        </div>
      </div>
      <button style={styles.keyBtn} onClick={onChangeKey} title="Сменить API-ключ">
        🔑 Ключ
      </button>
    </div>
  );
}

/* ----------------------------- KEY GATE ----------------------------- */

function KeyGate({ existing, onSave, onCancel }) {
  const [mode, setMode] = useState(existing?.mode || "key"); // 'key' | 'password'
  const [value, setValue] = useState(existing?.value || "");
  const [show, setShow] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  const switchMode = (m) => {
    setMode(m);
    setValue("");
    setError("");
    setShow(false);
  };

  const submit = async () => {
    const v = value.trim();
    if (mode === "key" && !v.startsWith("sk-ant-")) {
      setError("Ключ должен начинаться с «sk-ant-». Проверь, что скопировала его полностью.");
      return;
    }
    if (mode === "password" && !v) {
      setError("Введи пароль.");
      return;
    }
    setChecking(true);
    setError("");
    try {
      const headers = { "Content-Type": "application/json" };
      if (mode === "password") headers["x-app-password"] = v;
      else headers["x-user-api-key"] = v;
      const r = await fetch("/api/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({ validate: true }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        onSave({ mode, value: v });
      } else {
        setError(j.error || (mode === "password" ? "Неверный пароль." : "Ключ не подошёл."));
      }
    } catch (e) {
      setError(e.message || "Не удалось проверить — проверь, что сервер запущен.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div style={styles.gateWrap}>
      <div style={styles.gateCard}>
        <div style={styles.gateBrand}>
          <span style={styles.brandMark}>BA</span> Requirements Assistant
        </div>
        <h1 style={styles.gateTitle}>{existing ? "Сменить доступ" : "Добро пожаловать 👋"}</h1>

        {mode === "key" ? (
          <p style={styles.gateSub}>
            Агент работает на твоём ключе Anthropic. Введи его один раз — он сохранится в этом браузере.
          </p>
        ) : (
          <p style={styles.gateSub}>
            Введи пароль, который тебе дали. Запросы пойдут через ключ владельца — свой ключ Anthropic
            не нужен.
          </p>
        )}

        <div style={styles.gateField}>
          <input
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder={mode === "key" ? "sk-ant-api03-…" : "Пароль"}
            style={styles.gateInput}
            autoFocus
          />
          <button style={styles.gateShow} onClick={() => setShow((v) => !v)}>
            {show ? "Скрыть" : "Показать"}
          </button>
        </div>

        {error && <div style={styles.gateError}>{error}</div>}

        {mode === "key" && (
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noreferrer"
            style={styles.gateLink}
          >
            Где взять ключ → console.anthropic.com/settings/keys
          </a>
        )}

        <div style={styles.gateBtns}>
          {existing && onCancel && (
            <button style={styles.gateCancel} onClick={onCancel} disabled={checking}>
              Отмена
            </button>
          )}
          <button style={styles.gatePrimary} onClick={submit} disabled={checking}>
            {checking ? "Проверяю…" : existing ? "Сохранить" : "Продолжить →"}
          </button>
        </div>

        <button style={styles.gateSwitch} onClick={() => switchMode(mode === "key" ? "password" : "key")}>
          {mode === "key" ? "Вход по паролю →" : "← Ввести свой ключ Anthropic"}
        </button>

        <div style={styles.gateNote}>
          {mode === "key"
            ? "Ключ хранится только в твоём браузере. Платишь только ты за свои запросы."
            : "Ключ владельца на сервере и тебе не виден. Чаты у каждого свои (хранятся в твоём браузере)."}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- SIDEBAR ----------------------------- */

function Sidebar({ chats, currentId, loading, onSelect, onNew, onRequestDelete, onRequestDeleteAll, onRename }) {
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState("");
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);

  const startEdit = (c) => {
    setEditingId(c.id);
    setDraft(c.title);
  };
  const commit = () => {
    if (editingId) {
      onRename(editingId, draft.trim() || "Без названия");
      setEditingId(null);
    }
  };

  return (
    <div style={styles.sidebar}>
      <button style={styles.sidebarNew} onClick={onNew} disabled={loading}>
        + Новый документ
      </button>

      <div style={styles.sidebarList}>
        {sorted.map((c) => {
          const active = c.id === currentId;
          return (
            <div
              key={c.id}
              style={{ ...styles.chatItem, ...(active ? styles.chatItemActive : {}) }}
              onClick={() => onSelect(c.id)}
            >
              {editingId === c.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commit}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commit();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  style={styles.chatItemInput}
                />
              ) : (
                <>
                  <span style={styles.chatItemTitle} title={c.title}>
                    {c.title || "Без названия"}
                  </span>
                  <button
                    style={styles.chatItemBtn}
                    title="Редактировать название"
                    onClick={(e) => {
                      e.stopPropagation();
                      startEdit(c);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    style={styles.chatItemBtn}
                    title="Удалить чат"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequestDelete(c);
                    }}
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div style={styles.sidebarFootRow}>
        <button
          style={styles.deleteAllBtn}
          onClick={onRequestDeleteAll}
          disabled={loading || chats.length === 0}
        >
          Удалить все чаты
        </button>
      </div>
      <div style={styles.sidebarFoot}>Чаты хранятся в этом браузере</div>
    </div>
  );
}

/* ----------------------------- CONFIRM MODAL ----------------------------- */

function ConfirmModal({ scope, title, onConfirm, onCancel }) {
  return (
    <div style={styles.modalOverlay} onClick={onCancel}>
      <div style={styles.modalBox} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalTitle}>
          {scope === "all"
            ? "Удалить все чаты?"
            : scope === "version"
            ? "Удалить версию документа?"
            : "Удалить чат?"}
        </div>
        <div style={styles.modalText}>
          {scope === "all"
            ? "Будут удалены все сохранённые чаты. Восстановить их не получится."
            : scope === "version"
            ? `Версия «${title || "—"}» документа будет удалена. Восстановить её не получится.`
            : `Чат «${title || "Без названия"}» будет удалён. Восстановить его не получится.`}
        </div>
        <div style={styles.modalBtns}>
          <button style={styles.modalCancel} onClick={onCancel}>
            Отменить
          </button>
          <button style={styles.modalDelete} onClick={onConfirm}>
            Удалить
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------- EMPTY STATE ---------------------------- */

function EmptyState({ value, setValue, onSubmit, attachments, onAddFiles, onRemoveFile, loading }) {
  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSubmit();
  };
  return (
    <div style={styles.emptyWrap}>
      <div style={styles.emptyInner}>
        <div style={styles.emptyEyebrow}>01 — Входные данные</div>
        <h1 style={styles.emptyTitle}>Вставь сырой текст</h1>
        <p style={styles.emptySub}>
          Транскрипция встречи, переписка, заметки, описание процесса — в любом виде.
          Агент сам разберёт, классифицирует и спросит то, чего не хватает.
        </p>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={SAMPLE_INPUT}
          style={styles.textarea}
        />
        <AttachBar attachments={attachments} onAdd={onAddFiles} onRemove={onRemoveFile} disabled={loading} />
        <div style={styles.emptyFooter}>
          <span style={styles.emptyHint}>⌘ + Enter для отправки</span>
          <button style={styles.primaryBtn} onClick={onSubmit}>
            Разобрать текст →
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- BUBBLES -------------------------------- */

function UserBubble({ text, files }) {
  return (
    <div style={styles.userRow}>
      <div style={styles.userBubble}>
        {files?.length > 0 && (
          <div style={styles.userFiles}>
            {files.map((f) => (
              <span key={f.id} style={styles.userFileChip}>
                {f.kind === "image" ? "🖼" : "📄"} {f.name}
              </span>
            ))}
          </div>
        )}
        {text}
      </div>
    </div>
  );
}

function AgentAvatar() {
  return <div style={styles.agentAvatar}>BA</div>;
}

function TypingRow() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const hint = secs < 4 ? "Анализирую задачу…" : `Анализирую задачу… ${secs} с`;
  return (
    <div style={styles.loadingRow}>
      <div style={styles.typing}>
        <span style={styles.dot} />
        <span style={{ ...styles.dot, animationDelay: "0.15s" }} />
        <span style={{ ...styles.dot, animationDelay: "0.3s" }} />
      </div>
      <span style={styles.loadingText}>{hint}</span>
    </div>
  );
}

// Понятное описание по тексту ошибки (а не одна заглушка про ключ)
function errorInfo(text) {
  const t = (text || "").toLowerCase();
  const has = (s) => t.includes(s);
  if (has("overloaded"))
    return "Серверы Anthropic сейчас перегружены. Подожди минуту и отправь ещё раз — обычно проходит со 2-й попытки.";
  if (has("credit balance") || has("too low") || has("billing"))
    return "Закончились кредиты Anthropic. Пополни баланс: console.anthropic.com → Billing → Buy credits.";
  if (has("rate") || has("429"))
    return "Слишком много запросов подряд. Сделай паузу 10–20 секунд и попробуй снова.";
  if (has("неверный пароль"))
    return "Пароль не подошёл. Нажми «🔑 Ключ» и введи правильный (или войди своим ключом).";
  if (has("не указан"))
    return "Нужно войти. Нажми «🔑 Ключ» вверху — своим ключом или по паролю.";
  if (has("invalid x-api-key") || has("authentication") || has("ключ не подошёл") || has("api key"))
    return "Ключ не подошёл. Нажми «🔑 Ключ» вверху и вставь рабочий.";
  if (has("could not process") || has("image"))
    return "Не удалось прочитать файл. Проверь, что он целый и не больше 10 МБ, или убери его.";
  if (has("504") || has("timeout") || has("таймаут") || has("gateway"))
    return "Сервер не успел ответить (документ слишком долго готовился). Попробуй ещё раз или сформулируй задачу покороче.";
  if (has("fetch failed") || has("failed to fetch") || has("load failed") || has("network"))
    return "Сервер недоступен. Если это первый запрос за долгое время — он «просыпается», подожди ~30 сек и повтори.";
  if (has("internal server") || has("500"))
    return "Временный сбой на стороне Anthropic. Подожди немного и повтори.";
  return "Попробуй ещё раз. Если повторяется — проверь ключ («🔑 Ключ») и баланс Anthropic.";
}

function ErrorBanner({ text }) {
  return (
    <div style={styles.agentRow}>
      <AgentAvatar />
      <div style={styles.agentCol}>
        <div style={styles.errorCard}>
          <div style={styles.errorTitle}>Не удалось получить ответ</div>
          <div style={styles.errorText}>{errorInfo(text)}</div>
          <div style={styles.errorHint}>Техническая ошибка: {text}</div>
        </div>
      </div>
    </div>
  );
}

/* ----------------- РОУТЕР: какой вид рисовать по метке ----------------- */

function AgentMessage({ message, onConfirmStructure, onOpenDoc }) {
  const env = parseEnvelope(message.raw, message.streaming);

  let body;
  if (env.kind === "pending") {
    body = <TypingRow />;
  } else if (env.kind === "classification") {
    body = (
      <>
        <ClassificationCard data={env.data} onConfirm={onConfirmStructure} />
        {env.data?.questions?.length > 0 && <QuestionsCard questions={env.data.questions} />}
      </>
    );
  } else if (env.kind === "conflict") {
    body = <ConflictCard data={env.data} />;
  } else if (env.kind === "document") {
    body = <DocRef title={env.data.title} streaming={env.streaming} onOpen={onOpenDoc} />;
  } else {
    body = (
      <div style={styles.msgCard}>
        <Markdown>{env.markdown || "…"}</Markdown>
      </div>
    );
  }

  return (
    <div style={styles.agentRow}>
      <AgentAvatar />
      <div style={styles.agentCol}>{body}</div>
    </div>
  );
}

/* ------------------------ CLASSIFICATION CARD ------------------------- */

function ClassificationCard({ data, onConfirm }) {
  const required = data?.requiredBlocks ?? [];
  const optional = data?.optionalBlocks ?? [];

  const [active, setActive] = useState(() => new Set(required));
  const [shown, setShown] = useState(() => [...new Set([...required, ...optional])]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const toggleTag = (tag) => {
    if (confirmed) return;
    setActive((prev) => {
      const next = new Set(prev);
      next.has(tag) ? next.delete(tag) : next.add(tag);
      return next;
    });
  };

  const addBlock = (tag) => {
    if (confirmed) return;
    setShown((prev) => [...prev, tag]);
    setActive((prev) => new Set(prev).add(tag));
    setPickerOpen(false);
  };

  // #4: в «+ добавить блок» не показываем уже выведенные (активные и неактивные),
  // с учётом синонимов (ФТ ↔ Функциональные требования, Scope ↔ Scope / Out of Scope).
  const availableToAdd = ALL_AVAILABLE_BLOCKS.filter((b) => !blockAlreadyIn(b, shown));

  // #2: при подтверждении шлём и включённые, и снятые блоки — чтобы модель собрала
  // документ ТОЛЬКО из активных и не тащила снятые из своей методички.
  const handleConfirm = () => {
    setConfirmed(true);
    const include = [...active];
    const exclude = shown.filter((t) => !active.has(t));
    onConfirm?.({ include, exclude });
  };

  return (
    <div style={styles.card}>
      <div style={styles.cardLabel}>Классификация задачи</div>

      <div style={styles.classGrid}>
        <ClassRow label="Тип задачи" value={data?.taskType} />
        <ClassRow label="Уровень сложности" value={data?.level} tone={data?.levelTone} />
        <ClassRow label="Домены / триггеры" value={data?.domains} />
        <ClassRow label="Уверенность" value={data?.confidence} tone={data?.confidenceTone} />
      </div>

      {data?.whyLevel && (
        <div style={styles.calloutWarn}>
          <span style={styles.calloutWarnTitle}>Почему такой уровень</span>
          {data.whyLevel}
        </div>
      )}

      {data?.risks?.length > 0 && (
        <>
          <div style={styles.cardSubLabel}>Риски и неопределённости</div>
          <ul style={styles.riskList}>
            {data.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      )}

      <div style={styles.cardSubLabel}>Рекомендуемая структура</div>
      <div style={styles.structureHint}>Нажми на блок, чтобы включить или исключить его из документа</div>

      <div style={styles.structureTags}>
        {shown.map((tag) => (
          <button
            key={tag}
            onClick={() => toggleTag(tag)}
            disabled={confirmed}
            style={{
              ...(active.has(tag) ? styles.tagRequired : styles.tagOptional),
              ...(confirmed ? styles.tagDisabled : {}),
            }}
          >
            {tag}
          </button>
        ))}

        {!confirmed && (
          <div style={styles.addTagWrap}>
            <button style={styles.tagAdd} onClick={() => setPickerOpen((v) => !v)}>
              + добавить блок
            </button>
            {pickerOpen && (
              <div style={styles.picker}>
                {availableToAdd.length === 0 && (
                  <div style={styles.pickerEmpty}>Все доступные блоки уже добавлены</div>
                )}
                {availableToAdd.map((tag) => (
                  <button key={tag} style={styles.pickerItem} onClick={() => addBlock(tag)}>
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={styles.confirmRow}>
        <span style={styles.confirmHint}>
          {confirmed
            ? `✓ Структура подтверждена — ${active.size} ${pluralBlocks(active.size)} в документе`
            : `Выбрано: ${active.size} ${pluralBlocks(active.size)}`}
        </span>
        <button
          style={confirmed ? styles.confirmBtnDone : styles.confirmBtn}
          onClick={handleConfirm}
          disabled={confirmed}
        >
          {confirmed ? "Структура подтверждена" : "Подтвердить структуру →"}
        </button>
      </div>
    </div>
  );
}

function pluralBlocks(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "блок";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "блока";
  return "блоков";
}

function ClassRow({ label, value, tone }) {
  return (
    <div style={styles.classRow}>
      <span style={styles.classRowLabel}>{label}</span>
      <span
        style={{
          ...styles.classRowValue,
          color: tone === "warn" ? "#C2410C" : tone === "good" ? "#15803D" : "#1C1C1A",
        }}
      >
        {value || "—"}
      </span>
    </div>
  );
}

/* --------------------------- QUESTIONS -------------------------------- */

function QuestionsCard({ questions }) {
  return (
    <div style={{ ...styles.card, marginTop: 14 }}>
      <div style={styles.cardLabel}>Критичные вопросы</div>
      <p style={styles.cardIntro}>
        Ответь на них в поле ниже — без них структура документа может измениться. Остальное беру как
        допущения.
      </p>
      {questions.map((q, i) => (
        <div key={i} style={styles.questionRow}>
          <span style={styles.questionNum}>{i + 1}</span>
          <span style={styles.questionText}>{q}</span>
        </div>
      ))}
    </div>
  );
}

/* --------------------------- CONFLICT --------------------------------- */

function ConflictCard({ data }) {
  return (
    <div style={styles.cardConflict}>
      <div style={styles.cardConflictLabel}>⚠ Найдено противоречие</div>
      {data?.intro && <p style={styles.cardIntro}>{data.intro}</p>}
      <div style={styles.conflictVersions}>
        <div style={styles.conflictVersion}>
          <div style={styles.conflictVersionTag}>{data?.old?.where || "Зафиксировано ранее"}</div>
          <div style={styles.conflictVersionText}>{data?.old?.text}</div>
        </div>
        <div style={styles.conflictVersion}>
          <div style={styles.conflictVersionTagNew}>Только что сказано</div>
          <div style={styles.conflictVersionText}>{data?.new?.text}</div>
        </div>
      </div>
      {data?.question && <div style={styles.conflictQuestion}>{data.question}</div>}
    </div>
  );
}

/* ----------------------------- DOCUMENT -------------------------------- */

// Компактная ссылка в чате: сам документ живёт в панели справа
// Счётчик секунд — чтобы было видно, что идёт работа, а не зависание
function ElapsedTimer({ prefix = "" }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span>
      {prefix}
      {secs} с
    </span>
  );
}

function DocRef({ title, streaming, onOpen }) {
  return (
    <div style={styles.docRef} onClick={onOpen}>
      <span style={styles.docRefIcon}>📄</span>
      <div style={{ minWidth: 0 }}>
        <div style={styles.docRefTitle}>{title || "Документ требований"}</div>
        <div style={styles.docRefHint}>
          {streaming ? (
            <>Документ готовится… <ElapsedTimer /></>
          ) : (
            "Открыт в панели справа — нажми, чтобы показать эту версию"
          )}
        </div>
      </div>
    </div>
  );
}

function DocumentPanel({ documents, selectedId, onSelect, onRequestDelete, onRenameVersion, onAddBlock }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [headerCopied, setHeaderCopied] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState("");

  const total = documents.length;
  const withV = documents.map((d, i) => ({ ...d, v: i + 1 }));
  const selected = withV.find((d) => d.msgId === selectedId) || withV[withV.length - 1] || null;
  const ordered = [...withV].reverse(); // новые версии сверху

  const nameOf = (d) =>
    (d && d.name && d.name.trim()) || (d && d.v === total ? `Текущая · v${d.v}` : d ? `Версия ${d.v}` : "");

  const doCopy = async (md) => {
    try {
      await navigator.clipboard.writeText(md || "");
      return true;
    } catch {
      return false;
    }
  };
  const copyHeader = async () => {
    if (await doCopy(selected?.markdown)) {
      setHeaderCopied(true);
      setTimeout(() => setHeaderCopied(false), 1600);
    }
  };
  const copyRow = async (d) => {
    if (await doCopy(d.markdown)) {
      setCopiedId(d.msgId);
      setTimeout(() => setCopiedId(null), 1600);
    }
  };

  const startEdit = (d) => {
    setEditingId(d.msgId);
    setDraft(d.name || "");
  };
  const commitEdit = () => {
    if (editingId) {
      onRenameVersion(editingId, draft.trim());
      setEditingId(null);
    }
  };

  // #3: добавляем раздел и НЕ закрываем список — можно выбрать несколько подряд (накапливаются)
  const pickBlock = (tag) => {
    onAddBlock(tag);
  };

  // #4: не предлагаем разделы, которые уже есть в открытом документе
  const availableBlocks = ALL_AVAILABLE_BLOCKS.filter(
    (b) => !blockAlreadyIn(b, docHeadings(selected?.markdown))
  );

  return (
    <div style={styles.docPanel}>
      <div style={styles.docPanelHead}>
        <div style={styles.docPanelTitle}>{selected?.title || "Документ требований"}</div>
        {selected?.streaming ? (
          <span style={styles.docStreamStatus}>⏳ готовится… <ElapsedTimer /></span>
        ) : (
          <button style={styles.copyBtn} onClick={copyHeader} disabled={!selected}>
            {headerCopied ? "✓ Скопировано" : "Копировать markdown"}
          </button>
        )}
      </div>

      <div style={styles.docVersionsBar}>
        <div style={styles.versionsWrap}>
          <button style={styles.versionsBtn} onClick={() => setMenuOpen((v) => !v)}>
            Все версии ({total}) ▾
          </button>
          {menuOpen && (
            <>
              <div style={styles.menuOverlay} onClick={() => setMenuOpen(false)} />
              <div style={styles.versionsMenu}>
                {ordered.map((d) => {
                  const isActive = d.msgId === selected?.msgId;
                  const isNewest = d.v === total;
                  const name = nameOf(d);
                  return (
                    <div key={d.msgId} style={{ ...styles.versionRow, ...(isActive ? styles.versionRowActive : {}) }}>
                      {editingId === d.msgId ? (
                        <input
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitEdit();
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          placeholder={isNewest ? `Текущая · v${d.v}` : `Версия ${d.v}`}
                          style={styles.versionNameInput}
                        />
                      ) : (
                        <span
                          style={styles.versionName}
                          title="Открыть эту версию"
                          onClick={() => {
                            onSelect(d.msgId);
                            setMenuOpen(false);
                          }}
                        >
                          {name}
                          {isNewest && <span style={styles.versionBadge}>актуальная</span>}
                        </span>
                      )}
                      <button style={styles.versionIconBtn} title="Переименовать версию" onClick={() => startEdit(d)}>
                        ✎
                      </button>
                      <button style={styles.versionIconBtn} title="Копировать markdown" onClick={() => copyRow(d)}>
                        {copiedId === d.msgId ? "✓" : "⧉"}
                      </button>
                      <button
                        style={styles.versionIconBtn}
                        title="Удалить версию"
                        onClick={() => {
                          onRequestDelete(d.msgId, name);
                          setMenuOpen(false);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <span style={styles.versionsCurrent}>открыта: {nameOf(selected)}</span>
      </div>

      <div style={styles.docPanelBody}>
        <Markdown>{selected?.markdown || ""}</Markdown>
        {selected?.streaming && <span style={styles.caret} />}
      </div>

      {selected && !selected.streaming && (
        <div style={styles.docPanelFoot}>
          <span style={styles.docFootHint}>
            Нужны правки? Напиши в чате или добавь раздел (можно несколько — копятся в поле ввода):
          </span>
          <div style={styles.addTagWrap}>
            <button style={styles.tagAdd} onClick={() => setPickerOpen((v) => !v)}>
              + добавить блок
            </button>
            {pickerOpen && (
              <div style={{ ...styles.picker, top: "auto", bottom: "calc(100% + 6px)" }}>
                {availableBlocks.length === 0 ? (
                  <div style={styles.pickerEmpty}>Все разделы уже есть в документе</div>
                ) : (
                  availableBlocks.map((tag) => (
                    <button key={tag} style={styles.pickerItem} onClick={() => pickBlock(tag)}>
                      + {tag}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------- MARKDOWN -------------------------------- */

function Markdown({ children }) {
  return (
    <div style={styles.md}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h1 style={mdStyles.h1} {...p} />,
          h2: (p) => <h2 style={mdStyles.h2} {...p} />,
          h3: (p) => <h3 style={mdStyles.h3} {...p} />,
          p: (p) => <p style={mdStyles.p} {...p} />,
          ul: (p) => <ul style={mdStyles.ul} {...p} />,
          ol: (p) => <ol style={mdStyles.ol} {...p} />,
          li: (p) => <li style={mdStyles.li} {...p} />,
          a: (p) => <a style={mdStyles.a} target="_blank" rel="noreferrer" {...p} />,
          strong: (p) => <strong style={mdStyles.strong} {...p} />,
          hr: () => null,
          blockquote: (p) => <blockquote style={mdStyles.blockquote} {...p} />,
          pre: (p) => <pre style={mdStyles.pre} {...p} />,
          code: ({ children: c, className }) => {
            const block = String(c ?? "").includes("\n") || /language-/.test(className || "");
            return <code style={block ? mdStyles.codeInPre : styles.codeInline}>{c}</code>;
          },
          table: (p) => (
            <div style={mdStyles.tableWrap}>
              <table style={mdStyles.table} {...p} />
            </div>
          ),
          th: (p) => <th style={mdStyles.th} {...p} />,
          td: (p) => <td style={mdStyles.td} {...p} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/* ---------------------------- COMPOSER --------------------------------- */

function Composer({ inputRef, value, setValue, loading, onSend, attachments, onAddFiles, onRemoveFile }) {
  // авто-рост высоты под текст
  const onChange = (e) => {
    setValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };
  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!loading) {
        onSend();
        if (inputRef.current) inputRef.current.style.height = "auto";
      }
    }
  };
  return (
    <div style={styles.composerWrap}>
      <AttachBar attachments={attachments} onAdd={onAddFiles} onRemove={onRemoveFile} disabled={loading} />
      <div style={styles.composer}>
        <textarea
          ref={inputRef}
          rows={1}
          style={styles.composerInput}
          placeholder={
            loading ? "Агент отвечает…" : "Ответь на вопросы…  (Enter — отправить, Shift+Enter — новая строка)"
          }
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          disabled={loading}
        />
        <button style={styles.composerBtn} onClick={onSend} disabled={loading}>
          →
        </button>
      </div>
    </div>
  );
}

/* ---------------------------- ATTACH BAR --------------------------------- */

function AttachBar({ attachments, onAdd, onRemove, disabled }) {
  const fileRef = useRef(null);
  return (
    <div style={styles.attachBar}>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          onAdd(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        style={styles.attachBtn}
        onClick={() => fileRef.current?.click()}
        disabled={disabled}
        title="Прикрепить картинку или PDF"
      >
        📎 файл
      </button>
      {(attachments || []).map((f) => (
        <span key={f.id} style={styles.attachChip}>
          {f.kind === "image" ? "🖼" : "📄"} <span style={styles.attachChipName}>{f.name}</span>
          <button style={styles.attachChipX} onClick={() => onRemove(f.id)} title="Убрать">
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

/* ============================== STYLES ================================ */

const fontImports = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
  @keyframes baBlink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
  @keyframes baCaret { 0%, 100% { opacity: 0; } 50% { opacity: 1; } }
`;

const COLORS = {
  bg: "#FAFAF8",
  surface: "#FFFFFF",
  border: "#E8E6E0",
  text: "#1C1C1A",
  textMuted: "#6B6862",
  textFaint: "#A8A49C",
  accent: "#5B4FCF",
  accentSoft: "#EFEDFB",
  warn: "#C2410C",
  warnSoft: "#FDF0E8",
  good: "#15803D",
  goodSoft: "#EAF6EE",
};

const styles = {
  root: {
    fontFamily: "'Inter', sans-serif",
    background: COLORS.bg,
    color: COLORS.text,
    height: "100vh",
    display: "flex",
    flexDirection: "column",
  },

  topBar: {
    borderBottom: `1px solid ${COLORS.border}`,
    background: COLORS.surface,
    padding: "14px 24px",
    display: "flex",
    alignItems: "center",
    gap: 20,
    flexWrap: "wrap",
  },
  brandRow: { display: "flex", alignItems: "center", gap: 10 },
  brandMark: {
    width: 30, height: 30, borderRadius: 8,
    background: COLORS.accent, color: "#fff",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0,
  },
  brandName: { fontSize: 13.5, fontWeight: 600, lineHeight: 1.2 },
  brandStatus: { fontSize: 11.5, color: COLORS.textMuted, marginTop: 1 },
  newDocBtn: {
    marginLeft: "auto",
    fontSize: 12, fontWeight: 500, padding: "7px 14px", borderRadius: 8,
    border: `1px solid ${COLORS.border}`, background: COLORS.surface,
    color: COLORS.text, cursor: "pointer", fontFamily: "inherit",
  },

  shell: { flex: 1, display: "flex", overflow: "hidden" },

  main: { flex: 1, display: "flex", flexDirection: "row", overflow: "hidden", minWidth: 0 },
  chatCol: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 },

  sidebar: {
    width: 250, flexShrink: 0, borderRight: `1px solid ${COLORS.border}`,
    background: COLORS.surface, display: "flex", flexDirection: "column", overflow: "hidden",
  },
  sidebarNew: {
    margin: 12, padding: "9px 12px", borderRadius: 9, border: `1px solid ${COLORS.border}`,
    background: COLORS.bg, color: COLORS.text, fontSize: 12.5, fontWeight: 600,
    cursor: "pointer", fontFamily: "inherit",
  },
  sidebarList: { flex: 1, overflowY: "auto", padding: "0 8px 8px", display: "flex", flexDirection: "column", gap: 2 },
  chatItem: {
    display: "flex", alignItems: "center", gap: 6, padding: "8px 10px",
    borderRadius: 8, cursor: "pointer",
  },
  chatItemActive: { background: COLORS.accentSoft },
  chatItemTitle: {
    flex: 1, fontSize: 12.5, color: COLORS.text, lineHeight: 1.3,
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  },
  chatItemInput: {
    flex: 1, fontSize: 12.5, fontFamily: "inherit", border: `1px solid ${COLORS.accent}`,
    borderRadius: 5, padding: "2px 5px", outline: "none", minWidth: 0,
  },
  chatItemBtn: {
    border: "none", background: "transparent", color: COLORS.textFaint,
    cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "0 3px", flexShrink: 0,
  },
  sidebarFootRow: { padding: "8px 12px", borderTop: `1px solid ${COLORS.border}` },
  deleteAllBtn: {
    width: "100%", padding: "7px 10px", borderRadius: 8, border: `1px solid ${COLORS.border}`,
    background: "transparent", color: COLORS.warn, fontSize: 11.5, fontWeight: 600,
    cursor: "pointer", fontFamily: "inherit",
  },
  sidebarFoot: {
    fontSize: 10.5, color: COLORS.textFaint, padding: "10px 14px",
  },

  modalOverlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 24,
  },
  modalBox: {
    background: COLORS.surface, borderRadius: 14, padding: "22px 24px",
    maxWidth: 380, width: "100%", boxShadow: "0 12px 40px rgba(0,0,0,0.2)",
  },
  modalTitle: { fontSize: 15, fontWeight: 700, marginBottom: 8 },
  modalText: { fontSize: 13, color: COLORS.textMuted, lineHeight: 1.5, marginBottom: 18 },
  modalBtns: { display: "flex", gap: 10, justifyContent: "flex-end" },
  modalCancel: {
    padding: "9px 16px", borderRadius: 8, border: `1px solid ${COLORS.border}`,
    background: "transparent", color: COLORS.text, fontSize: 12.5, fontWeight: 600,
    cursor: "pointer", fontFamily: "inherit",
  },
  modalDelete: {
    padding: "9px 16px", borderRadius: 8, border: "none",
    background: COLORS.warn, color: "#fff", fontSize: 12.5, fontWeight: 600,
    cursor: "pointer", fontFamily: "inherit",
  },

  keyBtn: {
    marginLeft: "auto", fontSize: 12, fontWeight: 500, padding: "7px 14px", borderRadius: 8,
    border: `1px solid ${COLORS.border}`, background: COLORS.surface, color: COLORS.text,
    cursor: "pointer", fontFamily: "inherit",
  },

  gateWrap: {
    position: "fixed", inset: 0, zIndex: 200, background: COLORS.bg,
    display: "flex", alignItems: "center", justifyContent: "center", padding: 24, boxSizing: "border-box",
  },
  gateCard: {
    width: "100%", maxWidth: 480, background: COLORS.surface, border: `1px solid ${COLORS.border}`,
    borderRadius: 16, padding: "32px 32px 24px", boxShadow: "0 12px 40px rgba(0,0,0,0.08)",
  },
  gateBrand: {
    display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600,
    color: COLORS.textMuted, marginBottom: 18,
  },
  gateTitle: { fontSize: 24, fontWeight: 700, margin: "0 0 8px", letterSpacing: -0.3 },
  gateSub: { fontSize: 13.5, color: COLORS.textMuted, lineHeight: 1.6, margin: "0 0 18px" },
  gateField: { display: "flex", gap: 8, marginBottom: 10 },
  gateInput: {
    flex: 1, minWidth: 0, border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: "11px 13px",
    fontSize: 13.5, fontFamily: "inherit", outline: "none", background: COLORS.bg, color: COLORS.text,
  },
  gateShow: {
    border: `1px solid ${COLORS.border}`, background: COLORS.surface, borderRadius: 9, padding: "0 12px",
    fontSize: 12, color: COLORS.textMuted, cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
  },
  gateError: { fontSize: 12.5, color: COLORS.warn, marginBottom: 10, lineHeight: 1.5 },
  gateLink: { display: "inline-block", fontSize: 12.5, color: COLORS.accent, textDecoration: "none", marginBottom: 20 },
  gateSwitch: {
    display: "block", width: "100%", marginTop: 16, padding: "9px 12px", borderRadius: 9,
    border: `1px dashed ${COLORS.border}`, background: "transparent", color: COLORS.accent,
    fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
  gateBtns: { display: "flex", gap: 10, justifyContent: "flex-end" },
  gatePrimary: {
    background: COLORS.accent, color: "#fff", border: "none", padding: "11px 20px", borderRadius: 9,
    fontSize: 13.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
  gateCancel: {
    background: "transparent", color: COLORS.text, border: `1px solid ${COLORS.border}`,
    padding: "11px 18px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
  gateNote: {
    fontSize: 11.5, color: COLORS.textFaint, lineHeight: 1.5, marginTop: 18, paddingTop: 14,
    borderTop: `1px solid ${COLORS.border}`,
  },

  emptyWrap: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 },
  emptyInner: { width: "100%", maxWidth: 640 },
  emptyEyebrow: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5,
    color: COLORS.accent, letterSpacing: 0.5, marginBottom: 10, fontWeight: 600,
  },
  emptyTitle: { fontSize: 30, fontWeight: 700, margin: "0 0 10px", letterSpacing: -0.5 },
  emptySub: { fontSize: 14.5, color: COLORS.textMuted, lineHeight: 1.6, marginBottom: 24, maxWidth: 480 },
  textarea: {
    width: "100%", height: 180, padding: 16, borderRadius: 12,
    border: `1px solid ${COLORS.border}`, background: COLORS.surface,
    fontSize: 14, fontFamily: "inherit", color: COLORS.text,
    resize: "none", outline: "none", lineHeight: 1.55, boxSizing: "border-box",
  },
  emptyFooter: { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14 },
  emptyHint: { fontSize: 11.5, color: COLORS.textFaint, fontFamily: "'JetBrains Mono', monospace" },
  primaryBtn: {
    background: COLORS.accent, color: "#fff", border: "none",
    padding: "11px 20px", borderRadius: 9, fontSize: 13.5, fontWeight: 600,
    cursor: "pointer", fontFamily: "inherit",
  },

  chatLayout: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  chatScroll: {
    flex: 1, overflowY: "auto", padding: "28px 32px 12px",
    display: "flex", flexDirection: "column", gap: 18,
    maxWidth: 1180, margin: "0 auto", width: "100%", boxSizing: "border-box",
  },

  userRow: { display: "flex", justifyContent: "flex-end" },
  userBubble: {
    background: COLORS.text, color: "#fff", padding: "12px 16px",
    borderRadius: "14px 14px 2px 14px", fontSize: 13.5, lineHeight: 1.55,
    maxWidth: 680, whiteSpace: "pre-wrap",
  },

  agentRow: { display: "flex", gap: 12, alignItems: "flex-start" },
  agentAvatar: {
    width: 28, height: 28, borderRadius: 7, background: COLORS.accentSoft,
    color: COLORS.accent, display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 10.5, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0, marginTop: 2,
  },
  agentCol: { flex: 1, minWidth: 0 },

  loadingRow: { display: "flex", alignItems: "center", gap: 10, padding: "6px 2px" },
  loadingText: { fontSize: 12.5, color: COLORS.textMuted },
  typing: { display: "flex", gap: 5 },
  dot: {
    width: 7, height: 7, borderRadius: "50%", background: COLORS.accent,
    display: "inline-block", animation: "baBlink 1.2s infinite ease-in-out",
  },
  caret: {
    display: "inline-block", width: 7, height: 14, marginLeft: 2,
    background: COLORS.accent, verticalAlign: "text-bottom",
    animation: "baCaret 1s infinite", borderRadius: 1,
  },

  msgCard: {
    background: COLORS.surface, border: `1px solid ${COLORS.border}`,
    borderRadius: 14, padding: "14px 18px", maxWidth: 860,
  },

  card: {
    background: COLORS.surface, border: `1px solid ${COLORS.border}`,
    borderRadius: 14, padding: 20, maxWidth: 760,
  },
  cardLabel: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, fontWeight: 600,
    color: COLORS.accent, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 14,
  },
  cardSubLabel: {
    fontSize: 11.5, fontWeight: 600, color: COLORS.textMuted, margin: "16px 0 8px",
    textTransform: "uppercase", letterSpacing: 0.3,
  },
  cardIntro: { fontSize: 13, color: COLORS.textMuted, lineHeight: 1.5, margin: "0 0 14px" },

  classGrid: { display: "flex", flexDirection: "column", gap: 9 },
  classRow: { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 },
  classRowLabel: { color: COLORS.textMuted, flexShrink: 0 },
  classRowValue: { fontWeight: 600, textAlign: "right" },

  calloutWarn: {
    marginTop: 16, background: COLORS.warnSoft, border: `1px solid ${COLORS.warn}33`,
    borderRadius: 10, padding: "12px 14px", fontSize: 12.5, lineHeight: 1.55, color: "#7C2D12",
  },
  calloutWarnTitle: { display: "block", fontWeight: 700, color: COLORS.warn, marginBottom: 4, fontSize: 11.5 },

  riskList: { margin: 0, paddingLeft: 18, fontSize: 12.5, color: COLORS.textMuted, lineHeight: 1.7 },

  structureHint: { fontSize: 11.5, color: COLORS.textFaint, marginBottom: 10 },
  structureTags: { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "flex-start", position: "relative" },
  tagRequired: {
    fontSize: 11, padding: "4px 10px", borderRadius: 100,
    background: COLORS.text, color: "#fff", fontWeight: 500,
    border: "none", cursor: "pointer", fontFamily: "inherit",
  },
  tagOptional: {
    fontSize: 11, padding: "4px 10px", borderRadius: 100,
    background: "transparent", color: COLORS.textMuted, fontWeight: 500,
    border: `1px solid ${COLORS.border}`, cursor: "pointer", fontFamily: "inherit",
  },
  addTagWrap: { position: "relative" },
  tagAdd: {
    fontSize: 11, padding: "4px 10px", borderRadius: 100,
    background: "transparent", color: COLORS.accent, fontWeight: 600,
    border: `1px dashed ${COLORS.accent}66`, cursor: "pointer", fontFamily: "inherit",
  },
  picker: {
    position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 10,
    background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10,
    boxShadow: "0 8px 24px rgba(0,0,0,0.08)", padding: 6,
    display: "flex", flexDirection: "column", gap: 2, minWidth: 220, maxHeight: 240, overflowY: "auto",
  },
  pickerItem: {
    textAlign: "left", fontSize: 12.5, padding: "8px 10px", borderRadius: 7,
    border: "none", background: "transparent", color: COLORS.text, cursor: "pointer", fontFamily: "inherit",
  },
  pickerEmpty: { fontSize: 12, color: COLORS.textFaint, padding: "8px 10px" },
  tagDisabled: { opacity: 0.55, cursor: "default" },

  confirmRow: {
    marginTop: 18, paddingTop: 14, borderTop: `1px solid ${COLORS.border}`,
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap",
  },
  confirmHint: { fontSize: 11.5, color: COLORS.textMuted },
  confirmBtn: {
    background: COLORS.accent, color: "#fff", border: "none",
    padding: "9px 16px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
  confirmBtnDone: {
    background: COLORS.goodSoft, color: COLORS.good, border: `1px solid ${COLORS.good}44`,
    padding: "9px 16px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "default", fontFamily: "inherit",
  },

  questionRow: { display: "flex", gap: 10, marginBottom: 12, alignItems: "baseline" },
  questionNum: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700, color: COLORS.accent, flexShrink: 0,
  },
  questionText: { fontSize: 13, lineHeight: 1.55 },

  cardConflict: {
    background: COLORS.surface, border: `1.5px solid ${COLORS.warn}55`,
    borderRadius: 14, padding: 20, maxWidth: 760,
  },
  cardConflictLabel: { fontSize: 12.5, fontWeight: 700, color: COLORS.warn, marginBottom: 10 },
  conflictVersions: { display: "flex", flexDirection: "column", gap: 8, margin: "12px 0 14px" },
  conflictVersion: { background: COLORS.bg, borderRadius: 9, padding: "10px 12px", border: `1px solid ${COLORS.border}` },
  conflictVersionTag: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: COLORS.textFaint,
    marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4,
  },
  conflictVersionTagNew: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: COLORS.warn,
    marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700,
  },
  conflictVersionText: { fontSize: 13, lineHeight: 1.4 },
  conflictQuestion: { fontSize: 13, fontWeight: 600, lineHeight: 1.5 },

  docCard: { background: COLORS.surface, border: `1px solid ${COLORS.good}55`, borderRadius: 14, padding: 0, maxWidth: 720 },
  docHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "16px 20px", borderBottom: `1px solid ${COLORS.border}`,
    background: COLORS.goodSoft, gap: 12, flexWrap: "wrap", borderRadius: "14px 14px 0 0",
  },
  docHeaderLabel: {
    fontSize: 10.5, fontWeight: 700, color: COLORS.good, textTransform: "uppercase",
    letterSpacing: 0.5, marginBottom: 3, fontFamily: "'JetBrains Mono', monospace",
  },
  docHeaderTitle: { fontSize: 13.5, fontWeight: 600, lineHeight: 1.3 },
  copyBtn: {
    background: COLORS.good, color: "#fff", border: "none",
    padding: "9px 14px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
  },
  docBody: { padding: "16px 22px" },

  docConfirmZone: { padding: "14px 20px 18px", borderTop: `1px solid ${COLORS.border}` },
  docConfirmQuestion: { fontSize: 13, fontWeight: 600, marginBottom: 10 },
  docConfirmBtns: { display: "flex", gap: 8, flexWrap: "wrap" },
  docGoodBtn: {
    background: COLORS.good, color: "#fff", border: "none",
    padding: "9px 16px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
  docMoreBtn: {
    background: "transparent", color: COLORS.text, border: `1px solid ${COLORS.border}`,
    padding: "9px 16px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
  docMoreBtnActive: {
    background: COLORS.warnSoft, color: COLORS.warn, border: `1px solid ${COLORS.warn}44`,
    padding: "9px 16px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
  docGoodNote: {
    marginTop: 12, fontSize: 12.5, color: COLORS.good, lineHeight: 1.5,
    background: COLORS.goodSoft, padding: "10px 12px", borderRadius: 8,
  },
  docMoreZone: { marginTop: 14, position: "relative" },
  docMoreHint: { fontSize: 12.5, color: COLORS.textMuted, marginBottom: 10, lineHeight: 1.5 },

  codeInline: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: "0.86em",
    background: COLORS.accentSoft, color: COLORS.accent, padding: "1px 5px", borderRadius: 4, margin: "0 1px",
  },
  md: { fontSize: 13.5, lineHeight: 1.6, color: COLORS.text },

  errorCard: { background: COLORS.warnSoft, border: `1px solid ${COLORS.warn}44`, borderRadius: 14, padding: "14px 18px", maxWidth: 860 },
  errorTitle: { fontSize: 13, fontWeight: 700, color: COLORS.warn, marginBottom: 6 },
  errorText: { fontSize: 13, color: "#7C2D12", lineHeight: 1.5, marginBottom: 8 },
  errorHint: { fontSize: 12, color: COLORS.textMuted, lineHeight: 1.6 },

  composer: {
    display: "flex", gap: 10, alignItems: "flex-end",
  },
  composerInput: {
    flex: 1, border: `1px solid ${COLORS.border}`, borderRadius: 10,
    padding: "12px 14px", fontSize: 13.5, fontFamily: "inherit", outline: "none",
    background: COLORS.bg, color: COLORS.text, resize: "none", lineHeight: 1.5,
    maxHeight: 160, boxSizing: "border-box",
  },
  composerBtn: {
    width: 42, height: 42, flexShrink: 0, borderRadius: 10, border: "none", background: COLORS.accent,
    color: "#fff", fontSize: 16, cursor: "pointer", fontFamily: "inherit",
  },

  composerWrap: {
    borderTop: `1px solid ${COLORS.border}`, background: COLORS.surface,
    padding: "10px 16px 14px", maxWidth: 1180, margin: "0 auto", width: "100%", boxSizing: "border-box",
  },

  // вложения
  attachBar: { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 8 },
  attachBtn: {
    fontSize: 12, padding: "5px 10px", borderRadius: 8, border: `1px solid ${COLORS.border}`,
    background: COLORS.bg, color: COLORS.textMuted, cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
  },
  attachChip: {
    display: "inline-flex", alignItems: "center", gap: 5, maxWidth: 200,
    fontSize: 11.5, padding: "4px 6px 4px 9px", borderRadius: 8,
    background: COLORS.accentSoft, color: COLORS.text,
  },
  attachChipName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  attachChipX: {
    border: "none", background: "transparent", color: COLORS.textMuted,
    cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0,
  },
  userFiles: { display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 },
  userFileChip: {
    fontSize: 11, padding: "3px 8px", borderRadius: 7,
    background: "rgba(255,255,255,0.18)", color: "#fff",
  },

  // ссылка на документ в чате
  docRef: {
    display: "flex", alignItems: "center", gap: 12, cursor: "pointer",
    background: COLORS.goodSoft, border: `1px solid ${COLORS.good}55`, borderRadius: 12,
    padding: "12px 16px", maxWidth: 560,
  },
  docRefIcon: { fontSize: 22, flexShrink: 0 },
  docRefTitle: { fontSize: 13, fontWeight: 600, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  docRefHint: { fontSize: 11.5, color: COLORS.good, marginTop: 2 },

  // панель документа справа
  docPanel: {
    width: "52%", minWidth: 440, flexShrink: 0,
    borderLeft: `1px solid ${COLORS.border}`, background: COLORS.surface,
    display: "flex", flexDirection: "column", overflow: "hidden",
  },
  docPanelHead: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
    padding: "14px 18px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.goodSoft,
  },
  docPanelTitle: { fontSize: 13, fontWeight: 700, lineHeight: 1.3, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  docVersionsBar: {
    display: "flex", alignItems: "center", gap: 12, padding: "9px 14px",
    borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0, flexWrap: "wrap",
  },
  versionsWrap: { position: "relative" },
  versionsBtn: {
    fontSize: 12, padding: "6px 12px", borderRadius: 8, border: `1px solid ${COLORS.border}`,
    background: COLORS.bg, color: COLORS.text, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
  versionsCurrent: { fontSize: 11.5, color: COLORS.textMuted, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  menuOverlay: { position: "fixed", inset: 0, zIndex: 40 },
  versionsMenu: {
    position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 50,
    background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10,
    boxShadow: "0 8px 24px rgba(0,0,0,0.12)", padding: 6, minWidth: 300, maxHeight: 340,
    overflowY: "auto", display: "flex", flexDirection: "column", gap: 2,
  },
  versionRow: { display: "flex", alignItems: "center", gap: 3, padding: "6px 6px 6px 9px", borderRadius: 8 },
  versionRowActive: { background: COLORS.accentSoft },
  versionName: {
    flex: 1, minWidth: 0, fontSize: 12.5, cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  versionNameInput: {
    flex: 1, minWidth: 0, fontSize: 12.5, fontFamily: "inherit",
    border: `1px solid ${COLORS.accent}`, borderRadius: 5, padding: "3px 6px", outline: "none",
  },
  versionBadge: {
    fontSize: 9, fontWeight: 700, color: COLORS.good, background: COLORS.goodSoft,
    padding: "1px 6px", borderRadius: 100, textTransform: "uppercase", letterSpacing: 0.3, flexShrink: 0,
  },
  versionIconBtn: {
    border: "none", background: "transparent", color: COLORS.textMuted, cursor: "pointer",
    fontSize: 13, lineHeight: 1, padding: "3px 5px", flexShrink: 0, fontFamily: "inherit",
  },
  docPanelBody: { flex: 1, overflowY: "auto", padding: "16px 22px" },
  docPanelFoot: {
    padding: "10px 18px 14px", borderTop: `1px solid ${COLORS.border}`,
    display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", position: "relative",
  },
  docFootHint: { fontSize: 11.5, color: COLORS.textMuted },
  docStreamStatus: {
    fontSize: 12, fontWeight: 600, color: COLORS.accent, flexShrink: 0,
    fontFamily: "'JetBrains Mono', monospace",
  },
};

const mdStyles = {
  h1: { fontSize: 19, fontWeight: 700, margin: "8px 0 10px", letterSpacing: -0.3 },
  h2: { fontSize: 15.5, fontWeight: 700, margin: "18px 0 8px" },
  h3: { fontSize: 13.5, fontWeight: 700, margin: "14px 0 6px", color: COLORS.textMuted },
  p: { margin: "0 0 10px", lineHeight: 1.6 },
  ul: { margin: "0 0 10px", paddingLeft: 20 },
  ol: { margin: "0 0 10px", paddingLeft: 20 },
  li: { margin: "3px 0", lineHeight: 1.55 },
  a: { color: COLORS.accent, textDecoration: "underline" },
  strong: { fontWeight: 700 },
  hr: { border: "none", borderTop: `1px solid ${COLORS.border}`, margin: "16px 0" },
  blockquote: { margin: "0 0 10px", padding: "4px 14px", borderLeft: `3px solid ${COLORS.accent}`, color: COLORS.textMuted },
  pre: { background: "#F4F2EE", border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "12px 14px", margin: "0 0 12px", overflowX: "auto", lineHeight: 1.5 },
  codeInPre: { fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5, background: "transparent", color: COLORS.accent, padding: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  tableWrap: { overflowX: "auto", margin: "0 0 12px" },
  table: { borderCollapse: "collapse", width: "100%", fontSize: 12.5, border: `1px solid ${COLORS.border}` },
  th: { border: `1px solid ${COLORS.border}`, padding: "7px 10px", background: COLORS.bg, textAlign: "left", fontWeight: 600 },
  td: { border: `1px solid ${COLORS.border}`, padding: "7px 10px", verticalAlign: "top", lineHeight: 1.5 },
};
