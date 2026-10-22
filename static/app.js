const attachmentInput = document.querySelector("#attachment-input");
const attachFilesButton = document.querySelector("#attach-files");
const pendingAttachments = document.querySelector("#pending-attachments");
const documentList = document.querySelector("#document-list");
const documentCount = document.querySelector("#document-count");
const chatArea = document.querySelector("#chat-area");
const chatForm = document.querySelector("#chat-form");
const questionInput = document.querySelector("#question");
const sendButton = document.querySelector("#send-button");
const welcome = document.querySelector("#welcome");
const toastRegion = document.querySelector("#toast-region");
const accountName = document.querySelector("#account-name");
const logoutButton = document.querySelector("#logout-button");
let selectedFiles = [];

function showError(message) {
  const toast = document.createElement("div");
  toast.className = "toast-message";
  toast.textContent = message;
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 6000);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
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
      const name = document.createElement("div");
      name.className = "document-name";
      name.title = doc.filename;
      name.textContent = doc.filename;
      const meta = document.createElement("div");
      meta.className = "document-meta";
      meta.textContent = `${doc.chunks} searchable passage${doc.chunks === 1 ? "" : "s"}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "delete-document";
      remove.setAttribute("aria-label", `Remove ${doc.filename}`);
      remove.textContent = "×";
      remove.addEventListener("click", async () => {
        try {
          await api(`/api/documents/${encodeURIComponent(doc.id)}`, { method: "DELETE" });
          await refreshDocuments();
        } catch (error) {
          showError(error.message);
        }
      });
      info.append(name, meta);
      row.append(icon, info, remove);
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
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "…";
  try {
    const result = await api("/api/documents", { method: "POST", body: form });
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
  }
}

function renderPendingAttachments() {
  pendingAttachments.replaceChildren();
  pendingAttachments.classList.toggle("has-attachments", selectedFiles.length > 0);
  selectedFiles.forEach((file, index) => {
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
      selectedFiles.splice(index, 1);
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
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith("**") && part.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = part.slice(2, -2);
      element.append(strong);
    } else {
      element.append(document.createTextNode(part));
    }
  }
}

function renderAnswer(element, text) {
  const lines = text.split(/\r?\n/);
  let list = null;
  let listType = null;

  function closeList() {
    list = null;
    listType = null;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }
    const heading = trimmed.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      closeList();
      const title = document.createElement("strong");
      title.className = "answer-heading";
      appendInlineFormatting(title, heading[1]);
      element.append(title);
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    const item = bullet || numbered;
    if (item) {
      const nextListType = bullet ? "ul" : "ol";
      if (!list || listType !== nextListType) {
        closeList();
        list = document.createElement(nextListType);
        list.className = "answer-list";
        listType = nextListType;
        element.append(list);
      }
      const listItem = document.createElement("li");
      appendInlineFormatting(listItem, item[1]);
      list.append(listItem);
      continue;
    }

    closeList();
    const paragraph = document.createElement("p");
    appendInlineFormatting(paragraph, trimmed);
    element.append(paragraph);
  }
}

function addMessage(role, text, sources = []) {
  const row = document.createElement("div");
  row.className = `message-row ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "You" : "AI";
  const content = document.createElement("div");
  content.className = "message-content";
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "user" ? "You" : "MyDocx.ai";
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  renderAnswer(bubble, text);
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
  row.append(avatar, content);
  chatArea.append(row);
  chatArea.scrollTop = chatArea.scrollHeight;
  return row;
}

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
  welcome.classList.add("d-none");
  const attachedFiles = [...selectedFiles];
  let attachedDocumentIds = [];
  if (attachedFiles.length) {
    const uploaded = await uploadFiles(attachedFiles);
    if (!uploaded) return;
    attachedDocumentIds = uploaded.map((document) => document.id);
    selectedFiles = [];
    renderPendingAttachments();
  }
  const messageText = [
    question,
    ...(attachedFiles.length ? [`Attached ${attachedFiles.length} file${attachedFiles.length === 1 ? "" : "s"}: ${attachedFiles.map((file) => file.name).join(", ")}`] : []),
  ].filter(Boolean).join("\n");
  addMessage("user", messageText);
  questionInput.value = "";
  questionInput.style.height = "auto";
  if (!question) {
    addMessage("assistant", `Added ${attachedFiles.length} file${attachedFiles.length === 1 ? "" : "s"} to your document library. Ask a question whenever you're ready.`);
    return;
  }
  sendButton.disabled = true;
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
  try {
    const result = await api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, document_ids: attachedDocumentIds }),
    });
    thinking.remove();
    addMessage("assistant", result.answer, result.sources);
  } catch (error) {
    thinking.remove();
    showError(error.message);
    addMessage("assistant", `I couldn't answer that: ${error.message}`);
  } finally {
    sendButton.disabled = false;
    questionInput.focus();
  }
});

async function initializeApp() {
  try {
    const { user } = await api("/api/auth/me");
    accountName.textContent = user.display_name;
    await refreshDocuments();
  } catch (error) {
    if (error.message === "Please sign in to continue.") {
      window.location.replace("/login");
      return;
    }
    showError(error.message);
  }
}

initializeApp();
