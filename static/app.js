const attachmentInput = document.querySelector("#attachment-input");
const attachFilesButton = document.querySelector("#attach-files");
const pendingAttachments = document.querySelector("#pending-attachments");
const documentList = document.querySelector("#document-list");
const documentCount = document.querySelector("#document-count");
const chatList = document.querySelector("#chat-list");
const chatArea = document.querySelector("#chat-area");
const chatForm = document.querySelector("#chat-form");
const questionInput = document.querySelector("#question");
const sendButton = document.querySelector("#send-button");
const welcome = document.querySelector("#welcome");
const toastRegion = document.querySelector("#toast-region");
const accountName = document.querySelector("#account-name");
const logoutButton = document.querySelector("#logout-button");
const newChatButton = document.querySelector("#new-chat");
const processingStatus = document.querySelector("#processing-status");
const processingTitle = document.querySelector("#processing-title");
const documentPreviewOverlay = document.querySelector("#document-preview-overlay");
const documentPreviewTitle = document.querySelector("#document-preview-title");
const documentPreviewMeta = document.querySelector("#document-preview-meta");
const documentPreviewNote = document.querySelector("#document-preview-note");
const documentPdfPreview = document.querySelector("#document-pdf-preview");
const documentImagePreview = document.querySelector("#document-image-preview");
const documentTextPreview = document.querySelector("#document-text-preview");
const documentDownload = document.querySelector("#document-download");
const closeDocumentPreview = document.querySelector("#close-document-preview");
let selectedFiles = [];
let activeChatId = null;
let activeChatDocumentIds = [];
let activeChatStorageKey = null;
let documentPreviewUrl = null;

function showProcessing(title) {
  processingTitle.textContent = title;
  processingStatus.hidden = false;
  chatArea.classList.add("is-processing");
}

function hideProcessing() {
  processingStatus.hidden = true;
  chatArea.classList.remove("is-processing");
}

function startProgressUpdates(progressId) {
  let stopped = false;
  const poll = async () => {
    while (!stopped) {
      try {
        const response = await fetch(`/api/progress/${encodeURIComponent(progressId)}`);
        if (!response.ok) {
          if (response.status === 404) {
            stopped = true;
            break;
          }
          const body = await response.json().catch(() => ({}));
          throw new Error(body.detail || `Progress updates failed (${response.status}).`);
        }
        const progress = await response.json();
        if (progress.title !== "Starting") {
          showProcessing(progress.title);
        }
      } catch (error) {
        showError(`Could not update the processing status: ${error.message}`);
        stopped = true;
      }
      if (!stopped) await new Promise((resolve) => window.setTimeout(resolve, 1200));
    }
  };
  const polling = poll();
  return async () => {
    stopped = true;
    await polling;
  };
}

function createProgressId() {
  return crypto.randomUUID();
}

function chatProcessingStatus(question) {
  if (/\b(answer|answers|answer key|solution|solve)\b/i.test(question)) {
    return "Preparing your answers";
  }
  if (/\b(exam|examination|practice|revision|study|quiz|test|questions?)\b/i.test(question)) {
    return "Creating practice questions";
  }
  return "Answering from your documents";
}

function clearDocumentPreview() {
  documentPdfPreview.src = "about:blank";
  documentImagePreview.removeAttribute("src");
  documentPdfPreview.hidden = true;
  documentImagePreview.hidden = true;
  documentTextPreview.hidden = true;
  documentPreviewNote.hidden = true;
  documentDownload.hidden = true;
  if (documentPreviewUrl) {
    URL.revokeObjectURL(documentPreviewUrl);
    documentPreviewUrl = null;
  }
}

async function openDocumentPreview(doc) {
  clearDocumentPreview();
  documentPreviewTitle.textContent = doc.filename;
  documentPreviewMeta.textContent = doc.page_count_known
    ? `${doc.page_count} page${doc.page_count === 1 ? "" : "s"} · ${doc.chunks} searchable passages`
    : `Page count unavailable · ${doc.chunks} searchable passages`;
  documentPreviewOverlay.hidden = false;
  const fileUrl = `/api/documents/${encodeURIComponent(doc.id)}/file`;
  const extension = doc.filename.split(".").pop().toLowerCase();
  try {
    if (doc.has_file) {
      documentDownload.href = `${fileUrl}?download=true`;
      documentDownload.download = doc.filename;
      documentDownload.hidden = false;
    }
    if (doc.has_file && (extension === "pdf" || ["png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp"].includes(extension))) {
      const response = await fetch(fileUrl);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || `Could not open document (${response.status}).`);
      }
      documentPreviewUrl = URL.createObjectURL(await response.blob());
      if (extension === "pdf") {
        documentPdfPreview.src = documentPreviewUrl;
        documentPdfPreview.hidden = false;
      } else {
        documentImagePreview.src = documentPreviewUrl;
        documentImagePreview.hidden = false;
      }
      return;
    }

    const content = await api(`/api/documents/${encodeURIComponent(doc.id)}/content`);
    documentTextPreview.textContent = content.text || "No extracted text is available for this document.";
    documentTextPreview.hidden = false;
    if (!doc.has_file) {
      documentPreviewNote.textContent = "Showing saved extracted text. Re-upload this document to open or download the original file.";
      documentPreviewNote.hidden = false;
    }
  } catch (error) {
    documentPreviewOverlay.hidden = true;
    showError(error.message);
  }
}

function showError(message) {
  const toast = document.createElement("div");
  toast.className = "toast-message";
  toast.textContent = message;
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 6000);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const detail = typeof body === "string" ? "" : body.detail;
    const message = detail || (response.status >= 500
      ? `The server encountered an unexpected error (${response.status}). Check the terminal running main.py for its traceback.`
      : `Request failed (${response.status})`);
    throw new Error(message);
  }
  return body;
}

function setActiveChat(chat) {
  activeChatId = chat.id;
  activeChatDocumentIds = (chat.documents || []).map((document) => document.id);
  if (activeChatStorageKey) {
    localStorage.setItem(activeChatStorageKey, chat.id);
  }
  refreshChatHistory();
}

async function createChat(documentIds = []) {
  const result = await api("/api/chats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document_ids: documentIds }),
  });
  setActiveChat(result.chat);
  chatArea.replaceChildren(welcome, processingStatus);
  welcome.classList.remove("d-none");
  return result.chat;
}

async function refreshChatHistory() {
  try {
    const { chats } = await api("/api/chats");
    chatList.replaceChildren();
    if (!chats.length) {
      const empty = document.createElement("p");
      empty.className = "empty-documents";
      empty.textContent = "Your conversations will appear here.";
      chatList.append(empty);
      return chats;
    }
    for (const chat of chats) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `chat-history-item${chat.id === activeChatId ? " active" : ""}`;
      button.title = chat.title;
      const title = document.createElement("div");
      title.className = "chat-history-title";
      title.textContent = chat.title || "New chat";
      const description = document.createElement("div");
      description.className = "chat-history-description";
      description.textContent = chat.description || "No messages yet";
      button.append(title, description);
      button.addEventListener("click", () => loadChat(chat.id));
      chatList.append(button);
    }
    return chats;
  } catch (error) {
    showError(error.message);
    return [];
  }
}

async function loadChat(chatId) {
  try {
    const { chat } = await api(`/api/chats/${encodeURIComponent(chatId)}`);
    activeChatId = chat.id;
    activeChatDocumentIds = (chat.documents || []).map((document) => document.id);
    if (activeChatStorageKey) {
      localStorage.setItem(activeChatStorageKey, chat.id);
    }
    chatArea.replaceChildren();
    if (!chat.messages.length) {
      welcome.classList.remove("d-none");
      chatArea.append(welcome);
    } else {
      welcome.classList.add("d-none");
      for (const message of chat.messages) {
        addMessage(message.role, message.content, message.sources || []);
      }
    }
    chatArea.append(processingStatus);
    await refreshChatHistory();
  } catch (error) {
    showError(error.message);
  }
}

function fileType(filename) {
  return (filename.split(".").pop() || "FILE").slice(0, 4).toUpperCase();
}

async function refreshDocuments() {
  try {
    const { documents } = await api("/api/documents");
    documentCount.textContent = String(documents.length);
    documentList.replaceChildren();
    if (!documents.length) {
      const empty = document.createElement("p");
      empty.className = "empty-documents";
      empty.textContent = "Your uploaded files will appear here.";
      documentList.append(empty);
      return;
    }
    for (const doc of documents) {
      const row = document.createElement("div");
      row.className = "document-item";
      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.textContent = fileType(doc.filename);
      const info = document.createElement("div");
      info.className = "document-info";
      const name = document.createElement("button");
      name.type = "button";
      name.className = "document-name";
      name.title = doc.filename;
      name.textContent = doc.filename;
      name.addEventListener("click", () => openDocumentPreview(doc));
      const meta = document.createElement("div");
      meta.className = "document-meta";
      const pageCount = doc.page_count_known
        ? `${doc.page_count} page${doc.page_count === 1 ? "" : "s"}`
        : "Page count unavailable";
      meta.textContent = `${pageCount} · ${doc.chunks} searchable passage${doc.chunks === 1 ? "" : "s"}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "delete-document";
      remove.setAttribute("aria-label", `Remove ${doc.filename}`);
      remove.textContent = "×";
      remove.addEventListener("click", async () => {
        try {
          await api(`/api/documents/${encodeURIComponent(doc.id)}`, { method: "DELETE" });
          await refreshDocuments();
          await refreshChatHistory();
        } catch (error) {
          showError(error.message);
        }
      });
      const startChat = document.createElement("button");
      startChat.type = "button";
      startChat.className = "start-document-chat";
      startChat.textContent = "Chat";
      startChat.title = `Start a chat about ${doc.filename}`;
      startChat.addEventListener("click", async () => {
        try {
          const chat = await createChat([doc.id]);
          await refreshChatHistory();
        } catch (error) {
          showError(error.message);
        }
      });
      info.append(name, meta);
      row.append(icon, info, startChat, remove);
      documentList.append(row);
    }
  } catch (error) {
    showError(error.message);
  }
}

async function uploadFiles(files, button = sendButton) {
  if (!files.length) return null;
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const progressId = createProgressId();
  const stopProgressUpdates = startProgressUpdates(progressId);
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "…";
  showProcessing("Uploading and reading your document");
  try {
    const result = await api("/api/documents", {
      method: "POST",
      headers: { "X-Progress-ID": progressId },
      body: form,
    });
    const messages = result.documents.flatMap((doc) => doc.warnings || []);
    await refreshDocuments();
    if (messages.length) showError(messages.join(" "));
    if (!welcome.classList.contains("d-none")) welcome.classList.add("d-none");
    return result.documents;
  } catch (error) {
    showError(error.message);
    return null;
  } finally {
    button.disabled = false;
    button.textContent = originalText;
    await stopProgressUpdates();
  }
}

function renderPendingAttachments() {
  pendingAttachments.replaceChildren();
  pendingAttachments.classList.toggle("has-attachments", selectedFiles.length > 0);
  selectedFiles.forEach((file) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    const icon = document.createElement("span");
    icon.className = "attachment-file-icon";
    icon.textContent = fileType(file.name);
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = file.name;
    name.title = file.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-attachment";
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      selectedFiles = selectedFiles.filter((selectedFile) => selectedFile !== file);
      renderPendingAttachments();
    });
    chip.append(icon, name, remove);
    pendingAttachments.append(chip);
  });
}

function addSelectedFiles(files) {
  for (const file of files) {
    const alreadySelected = selectedFiles.some((selected) =>
      selected.name === file.name
      && selected.size === file.size
      && selected.lastModified === file.lastModified
    );
    if (!alreadySelected) selectedFiles.push(file);
  }
  renderPendingAttachments();
}

function appendInlineFormatting(element, text) {
  const tokenPattern = /(`+)(.+?)\1|\*\*\*(.+?)\*\*\*|___(.+?)___|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)|\\([\\`*_{}[\]()#+\-.!>])/g;
  let cursor = 0;
  let match;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > cursor) {
      element.append(document.createTextNode(text.slice(cursor, match.index)));
    }

    let node;
    if (match[1]) {
      node = document.createElement("code");
      node.className = "markdown-inline-code";
      node.textContent = match[2].replace(/\n/g, " ");
    } else if (match[3] || match[4]) {
      node = document.createElement("strong");
      const emphasis = document.createElement("em");
      emphasis.textContent = match[3] || match[4];
      node.append(emphasis);
    } else if (match[5] || match[6]) {
      node = document.createElement("strong");
      node.textContent = match[5] || match[6];
    } else if (match[7]) {
      node = document.createElement("del");
      node.textContent = match[7];
    } else if (match[8] || match[9]) {
      node = document.createElement("em");
      node.textContent = match[8] || match[9];
    } else if (match[10]) {
      let linkUrl;
      try {
        linkUrl = new URL(match[11], window.location.origin);
      } catch {
        linkUrl = null;
      }
      if (linkUrl && ["http:", "https:", "mailto:"].includes(linkUrl.protocol)) {
        node = document.createElement("a");
        node.href = linkUrl.href;
        node.textContent = match[10];
        node.rel = "noopener noreferrer";
        node.target = "_blank";
        if (match[12]) node.title = match[12];
      } else {
        node = document.createTextNode(match[0]);
      }
    } else {
      node = document.createTextNode(match[13]);
    }
    element.append(node);
    cursor = tokenPattern.lastIndex;
  }

  if (cursor < text.length) {
    element.append(document.createTextNode(text.slice(cursor)));
  }
}

function markdownCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line) {
  return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
}

function renderMarkdown(element, text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  function isBlockStart(line, nextLine = "") {
    const trimmed = line.trim();
    return /^(`{3,}|~{3,})/.test(trimmed)
      || /^#{1,6}\s+/.test(trimmed)
      || /^>\s?/.test(trimmed)
      || /^([-*_])(?:\s*\1){2,}\s*$/.test(trimmed)
      || /^\s*(?:[-+*]|\d+[.)])\s+/.test(line)
      || (line.includes("|") && isMarkdownTableSeparator(nextLine));
  }

  function renderList(parent, sourceLines, start) {
    const firstItem = sourceLines[start].match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
    if (!firstItem) return start;
    const indent = firstItem[1].length;
    const ordered = /^\d/.test(firstItem[2]);
    const list = document.createElement(ordered ? "ol" : "ul");
    list.className = "markdown-list";
    if (ordered && Number.parseInt(firstItem[2], 10) > 1) {
      list.start = Number.parseInt(firstItem[2], 10);
    }

    let cursor = start;
    let lastItem = null;
    while (cursor < sourceLines.length) {
      const itemMatch = sourceLines[cursor].match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
      if (!itemMatch) break;
      const itemIndent = itemMatch[1].length;
      if (itemIndent < indent) break;
      if (itemIndent > indent) {
        if (!lastItem) break;
        cursor = renderList(lastItem, sourceLines, cursor);
        continue;
      }
      if (/^\d/.test(itemMatch[2]) !== ordered) break;

      lastItem = document.createElement("li");
      const task = itemMatch[3].match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        lastItem.classList.add("markdown-task-item");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.disabled = true;
        checkbox.checked = task[1].toLowerCase() === "x";
        lastItem.append(checkbox);
        appendInlineFormatting(lastItem, task[2]);
      } else {
        appendInlineFormatting(lastItem, itemMatch[3]);
      }
      list.append(lastItem);
      cursor += 1;
    }
    parent.append(list);
    return cursor;
  }

  function renderBlocks(parent, sourceLines) {
    let cursor = 0;
    while (cursor < sourceLines.length) {
      const current = sourceLines[cursor];
      const trimmed = current.trim();
      if (!trimmed) {
        cursor += 1;
        continue;
      }

      const fence = trimmed.match(/^(`{3,}|~{3,})\s*([^\s`]*)?.*$/);
      if (fence) {
        const fenceMarker = fence[1];
        const closingFence = new RegExp(`^\\s*${fenceMarker[0]}{${fenceMarker.length},}\\s*$`);
        const codeLines = [];
        cursor += 1;
        while (cursor < sourceLines.length && !closingFence.test(sourceLines[cursor])) {
          codeLines.push(sourceLines[cursor]);
          cursor += 1;
        }
        if (cursor < sourceLines.length) cursor += 1;
        const pre = document.createElement("pre");
        pre.className = "markdown-code-block";
        const code = document.createElement("code");
        const language = (fence[2] || "").toLowerCase();
        if (/^[a-z0-9_+-]{1,30}$/.test(language)) code.dataset.language = language;
        code.textContent = codeLines.join("\n");
        pre.append(code);
        parent.append(pre);
        continue;
      }

      const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const title = document.createElement(`h${heading[1].length}`);
        appendInlineFormatting(title, heading[2]);
        parent.append(title);
        cursor += 1;
        continue;
      }

      if (/^([-*_])(?:\s*\1){2,}\s*$/.test(trimmed)) {
        parent.append(document.createElement("hr"));
        cursor += 1;
        continue;
      }

      if (/^>\s?/.test(trimmed)) {
        const quoteLines = [];
        while (cursor < sourceLines.length && /^>\s?/.test(sourceLines[cursor].trim())) {
          quoteLines.push(sourceLines[cursor].trim().replace(/^>\s?/, ""));
          cursor += 1;
        }
        const quote = document.createElement("blockquote");
        renderBlocks(quote, quoteLines);
        parent.append(quote);
        continue;
      }

      if (
        current.includes("|")
        && cursor + 1 < sourceLines.length
        && isMarkdownTableSeparator(sourceLines[cursor + 1])
      ) {
        const headers = markdownCells(current);
        const alignments = markdownCells(sourceLines[cursor + 1]).map((cell) =>
          cell.startsWith(":") && cell.endsWith(":")
            ? "center"
            : cell.endsWith(":")
              ? "right"
              : cell.startsWith(":")
                ? "left"
                : ""
        );
        const table = document.createElement("table");
        table.className = "markdown-table";
        const thead = document.createElement("thead");
        const headerRow = document.createElement("tr");
        headers.forEach((content, cellIndex) => {
          const cell = document.createElement("th");
          if (alignments[cellIndex]) cell.style.textAlign = alignments[cellIndex];
          appendInlineFormatting(cell, content);
          headerRow.append(cell);
        });
        thead.append(headerRow);
        table.append(thead);
        const tbody = document.createElement("tbody");
        cursor += 2;
        while (cursor < sourceLines.length && sourceLines[cursor].includes("|") && sourceLines[cursor].trim()) {
          const row = document.createElement("tr");
          markdownCells(sourceLines[cursor]).forEach((content, cellIndex) => {
            const cell = document.createElement("td");
            if (alignments[cellIndex]) cell.style.textAlign = alignments[cellIndex];
            appendInlineFormatting(cell, content);
            row.append(cell);
          });
          tbody.append(row);
          cursor += 1;
        }
        table.append(tbody);
        const tableWrap = document.createElement("div");
        tableWrap.className = "markdown-table-wrap";
        tableWrap.append(table);
        parent.append(tableWrap);
        continue;
      }

      const listMatch = current.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
      if (listMatch) {
        cursor = renderList(parent, sourceLines, cursor);
        continue;
      }

      const paragraphLines = [current.trimStart()];
      cursor += 1;
      while (
        cursor < sourceLines.length
        && sourceLines[cursor].trim()
        && !isBlockStart(sourceLines[cursor], sourceLines[cursor + 1] || "")
      ) {
        paragraphLines.push(sourceLines[cursor].trimStart());
        cursor += 1;
      }
      const paragraph = document.createElement("p");
      paragraphLines.forEach((line, lineIndex) => {
        if (lineIndex) {
          if (/ {2}$/.test(paragraphLines[lineIndex - 1])) paragraph.append(document.createElement("br"));
          else paragraph.append(document.createTextNode(" "));
        }
        appendInlineFormatting(paragraph, line.replace(/ {2}$/, ""));
      });
      parent.append(paragraph);
    }
  }

  renderBlocks(element, lines);
}

function addMessage(role, text, sources = []) {
  const row = document.createElement("div");
  row.className = `message-row ${role}`;
  if (role !== "user") {
    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 640 640");
    icon.setAttribute("aria-hidden", "true");
    icon.classList.add("assistant-avatar-icon");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M320 216C368.6 216 408 176.6 408 128C408 79.4 368.6 40 320 40C271.4 40 232 79.4 232 128C232 176.6 271.4 216 320 216zM320 514.7L320 365.4C336.3 358.6 352.9 351.7 369.7 344.7C408.7 328.5 450.5 320.1 492.8 320.1L512 320.1L512 480.1L492.8 480.1C433.7 480.1 375.1 491.8 320.5 514.6L320 514.8zM320 296L294.9 285.5C248.1 266 197.9 256 147.2 256L112 256C85.5 256 64 277.5 64 304L64 496C64 522.5 85.5 544 112 544L147.2 544C197.9 544 248.1 554 294.9 573.5L307.7 578.8C315.6 582.1 324.4 582.1 332.3 578.8L345.1 573.5C391.9 554 442.1 544 492.8 544L528 544C554.5 544 576 522.5 576 496L576 304C576 277.5 554.5 256 528 256L492.8 256C442.1 256 391.9 266 345.1 285.5L320 296z");
    path.setAttribute("fill", "currentColor");
    icon.append(path);
    avatar.setAttribute("aria-label", "MyDocx.ai assistant");
    avatar.append(icon);
    row.append(avatar);
  }
  const content = document.createElement("div");
  content.className = "message-content";
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "user" ? "You" : "MyDocx.ai";
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  renderMarkdown(bubble, text);
  content.append(label, bubble);
  if (sources.length) {
    const details = document.createElement("details");
    details.className = "sources";
    const summary = document.createElement("summary");
    summary.textContent = `Sources (${sources.length})`;
    details.append(summary);
    for (const source of sources) {
      const card = document.createElement("div");
      card.className = "source-card";
      const title = document.createElement("div");
      title.className = "source-title";
      title.textContent = source.page_or_slide
        ? `${source.filename} · ${source.page_or_slide}`
        : source.filename;
      const excerpt = document.createElement("div");
      excerpt.textContent = source.text;
      card.append(title, excerpt);
      details.append(card);
    }
    content.append(details);
  }
  row.append(content);
  chatArea.append(row);
  chatArea.scrollTop = chatArea.scrollHeight;
  return row;
}

closeDocumentPreview.addEventListener("click", () => {
  clearDocumentPreview();
  documentPreviewOverlay.hidden = true;
});

documentPreviewOverlay.addEventListener("click", (event) => {
  if (event.target === documentPreviewOverlay) {
    clearDocumentPreview();
    documentPreviewOverlay.hidden = true;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !documentPreviewOverlay.hidden) {
    clearDocumentPreview();
    documentPreviewOverlay.hidden = true;
  }
});

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  try {
    await api("/api/auth/logout", { method: "POST" });
    window.location.replace("/login");
  } catch (error) {
    showError(error.message);
    logoutButton.disabled = false;
  }
});

attachFilesButton.addEventListener("click", () => attachmentInput.click());
attachmentInput.addEventListener("change", () => {
  addSelectedFiles([...attachmentInput.files]);
  attachmentInput.value = "";
});

newChatButton.addEventListener("click", async () => {
  try {
    await createChat();
    await refreshChatHistory();
  } catch (error) {
    showError(error.message);
  }
});

document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => {
    questionInput.value = button.dataset.question;
    chatForm.requestSubmit();
  });
});

questionInput.addEventListener("input", () => {
  questionInput.style.height = "auto";
  questionInput.style.height = `${Math.min(questionInput.scrollHeight, 140)}px`;
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question && !selectedFiles.length) return;
  const attachedFiles = [...selectedFiles];
  let attachedDocumentIds = [];
  if (attachedFiles.length) {
    showProcessing("Uploading and reading your document");
    const uploaded = await uploadFiles(attachedFiles);
    if (!uploaded) {
      hideProcessing();
      return;
    }
    attachedDocumentIds = uploaded.map((document) => document.id);
    selectedFiles = [];
    renderPendingAttachments();
    try {
      if (activeChatId) {
        await api(`/api/chats/${encodeURIComponent(activeChatId)}/documents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document_ids: attachedDocumentIds }),
        });
        activeChatDocumentIds = [...new Set([...activeChatDocumentIds, ...attachedDocumentIds])];
      } else {
        await createChat(attachedDocumentIds);
      }
      showProcessing("Document ready");
      await refreshChatHistory();
    } catch (error) {
      hideProcessing();
      showError(error.message);
      return;
    }
  }
  const messageText = [
    question,
    ...(attachedFiles.length ? [`Attached ${attachedFiles.length} file${attachedFiles.length === 1 ? "" : "s"}: ${attachedFiles.map((file) => file.name).join(", ")}`] : []),
  ].filter(Boolean).join("\n");
  if (!question) {
    addMessage("user", messageText);
    addMessage("assistant", `Added ${attachedFiles.length} file${attachedFiles.length === 1 ? "" : "s"} to your document library. Ask a question whenever you're ready.`);
    await refreshChatHistory();
    hideProcessing();
    return;
  }
  welcome.classList.add("d-none");
  addMessage("user", messageText);
  questionInput.value = "";
  questionInput.style.height = "auto";
  sendButton.disabled = true;
  showProcessing(chatProcessingStatus(question));
  const thinking = addMessage("assistant", "Searching your documents…");
  const thinkingBubble = thinking.querySelector(".message-bubble");
  thinkingBubble.classList.add("typing");
  thinkingBubble.setAttribute("role", "status");
  thinkingBubble.setAttribute("aria-label", "Searching your documents");
  thinkingBubble.innerHTML = `
    <span class="visually-hidden">Searching your documents</span>
    <svg class="loader" viewBox="0 0 100 100" role="presentation" aria-hidden="true">
      <g id="pegtopone"><path d="M50 47C41 36 39 26 44 20c5-6 14-4 17 3 3 7-2 15-11 24Z"/><path d="M48 43c1-8 4-14 8-19"/></g>
      <g id="pegtoptwo"><path d="M50 47C41 36 39 26 44 20c5-6 14-4 17 3 3 7-2 15-11 24Z"/><path d="M48 43c1-8 4-14 8-19"/></g>
      <g id="pegtopthree"><path d="M50 47C41 36 39 26 44 20c5-6 14-4 17 3 3 7-2 15-11 24Z"/><path d="M48 43c1-8 4-14 8-19"/></g>
      <circle class="loader-center" cx="50" cy="51" r="5"/>
    </svg>`;
  const progressId = createProgressId();
  const stopProgressUpdates = startProgressUpdates(progressId);
  try {
    const result = await api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        document_ids: [...new Set([...activeChatDocumentIds, ...attachedDocumentIds])],
        chat_id: activeChatId,
        progress_id: progressId,
      }),
    });
    if (result.chat_id) {
      activeChatId = result.chat_id;
      if (activeChatStorageKey) {
        localStorage.setItem(activeChatStorageKey, result.chat_id);
      }
      if (Array.isArray(result.document_ids)) {
        activeChatDocumentIds = result.document_ids;
      } else if (attachedDocumentIds.length) {
        activeChatDocumentIds = [...new Set([...activeChatDocumentIds, ...attachedDocumentIds])];
      }
    }
    thinking.remove();
    addMessage("assistant", result.answer, result.sources);
    await refreshChatHistory();
  } catch (error) {
    thinking.remove();
    showError(error.message);
    addMessage("assistant", `I couldn't answer that: ${error.message}`);
  } finally {
    await stopProgressUpdates();
    hideProcessing();
    sendButton.disabled = false;
    questionInput.focus();
  }
});

async function initializeApp() {
  try {
    const { user } = await api("/api/auth/me");
    accountName.textContent = user.display_name;
    activeChatStorageKey = `mydocx.activeChat.${user.id}`;
    const [, chats] = await Promise.all([refreshDocuments(), refreshChatHistory()]);
    if (chats.length) {
      const savedChatId = localStorage.getItem(activeChatStorageKey);
      const savedChat = chats.find((chat) => chat.id === savedChatId);
      await loadChat((savedChat || chats[0]).id);
    } else {
      activeChatId = null;
      activeChatDocumentIds = [];
      localStorage.removeItem(activeChatStorageKey);
    }
  } catch (error) {
    if (error.message === "Please sign in to continue.") {
      window.location.replace("/login");
      return;
    }
    showError(error.message);
  }
}

initializeApp();
