const STORAGE_KEY = "bookmind.library.v1";
const PROFILE_STORAGE_KEY = "bookmind.profile.v1";
const FILE_DB_NAME = "bookmind.attachments.v1";
const FILE_STORE_NAME = "book-files";
const DEMO_BOOK_IDS = new Set(["demo-1", "demo-2", "demo-3"]);
const standardGenres = ["Estudio", "Novela", "Historia", "Ciencia", "Desarrollo personal", "Biografía", "Fantasía", "Otros"];
const coverThemes = ["cover-fern", "cover-coral", "cover-ochre", "cover-blue", "cover-plum", "cover-moss"];

let books = loadBooks();
let profile = loadProfile();
let activeView = "library";
let activeFilter = "all";
let activeGenre = "all";
let selectedBookId = null;
let searchTerm = "";
let studyQuestion = null;
let studyRevealed = false;
let toastTimer;
let pendingBookFile = null;
let pendingExtractedText = "";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function loadBooks() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return [];
      const personalBooks = parsed.filter(book => !DEMO_BOOK_IDS.has(book.id));
      if (personalBooks.length !== parsed.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(personalBooks));
      return personalBooks;
    }
  } catch (error) {
    console.warn("No se pudo leer la biblioteca guardada.", error);
  }
  return [];
}

function saveBooks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(books));
  } catch (error) {
    showToast("No se pudieron guardar los cambios en este dispositivo.");
    console.error("No se pudo guardar la biblioteca.", error);
  }
}

function loadProfile() {
  try {
    const saved = localStorage.getItem(PROFILE_STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch (error) {
    console.warn("No se pudo leer el perfil local.", error);
    return null;
  }
}

function saveProfile() {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch (error) {
    showToast("No se pudo guardar el perfil en este dispositivo.");
    console.error("No se pudo guardar el perfil local.", error);
  }
}

function openFileDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("Este navegador no permite guardar archivos adjuntos."));
      return;
    }
    const request = indexedDB.open(FILE_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(FILE_STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudo abrir el almacenamiento de archivos."));
  });
}

async function storeBookFile(bookId, file) {
  const database = await openFileDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(FILE_STORE_NAME, "readwrite");
    transaction.objectStore(FILE_STORE_NAME).put(file, bookId);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
    transaction.onabort = () => { database.close(); reject(transaction.error); };
  });
}

async function getBookFile(bookId) {
  const database = await openFileDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(FILE_STORE_NAME, "readonly");
    const request = transaction.objectStore(FILE_STORE_NAME).get(bookId);
    request.onsuccess = () => { database.close(); resolve(request.result || null); };
    request.onerror = () => { database.close(); reject(request.error); };
  });
}

async function deleteBookFile(bookId) {
  const database = await openFileDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(FILE_STORE_NAME, "readwrite");
    transaction.objectStore(FILE_STORE_NAME).delete(bookId);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
  });
}

function filenameTitle(fileName) {
  return fileName.replace(/\.(pdf|epub)$/i, "").replace(/[._-]+/g, " ").trim();
}

function xmlValues(documentNode, localName) {
  return [...documentNode.getElementsByTagName("*")]
    .filter(node => node.localName?.toLowerCase() === localName.toLowerCase())
    .map(node => node.textContent.trim()).filter(Boolean);
}

async function extractPdfMetadata(file) {
  if (!window.pdfjsLib) throw new Error("El lector PDF no está disponible sin conexión.");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const document = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const metadata = await document.getMetadata().catch(() => ({ info: {} }));
  const textPages = [];
  for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 12); pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    textPages.push(content.items.map(item => item.str).join(" "));
    if (textPages.join(" ").length >= 24000) break;
  }
  return {
    title: metadata.info?.Title?.trim() || "",
    author: metadata.info?.Author?.trim() || "",
    category: metadata.metadata?.get?.("dc:subject") || "",
    text: textPages.join(" ").replace(/\s+/g, " ").slice(0, 24000)
  };
}

function resolveZipPath(basePath, relativePath) {
  const resolved = new URL(relativePath, `https://bookmind.invalid/${basePath}`);
  return decodeURIComponent(resolved.pathname.replace(/^\/+/, ""));
}

async function extractEpubMetadata(file) {
  if (!window.JSZip) throw new Error("El lector EPUB no está disponible sin conexión.");
  const archive = await JSZip.loadAsync(file);
  const containerFile = archive.file("META-INF/container.xml");
  if (!containerFile) throw new Error("El archivo no contiene un índice EPUB válido.");
  const containerXml = new DOMParser().parseFromString(await containerFile.async("text"), "application/xml");
  const opfPath = containerXml.getElementsByTagName("rootfile")[0]?.getAttribute("full-path");
  const opfFile = opfPath && archive.file(opfPath);
  if (!opfFile) throw new Error("No se encontró la ficha bibliográfica del EPUB.");
  const packageXml = new DOMParser().parseFromString(await opfFile.async("text"), "application/xml");
  const manifest = [...packageXml.getElementsByTagName("item")];
  const itemById = new Map(manifest.map(item => [item.getAttribute("id"), item.getAttribute("href")]));
  const spinePaths = [...packageXml.getElementsByTagName("itemref")]
    .map(item => itemById.get(item.getAttribute("idref"))).filter(Boolean);
  const basePath = opfPath.slice(0, opfPath.lastIndexOf("/") + 1);
  const textParts = [];
  for (const href of spinePaths.slice(0, 40)) {
    const chapter = archive.file(resolveZipPath(basePath, href));
    if (!chapter) continue;
    const chapterDocument = new DOMParser().parseFromString(await chapter.async("text"), "text/html");
    const text = chapterDocument.body.textContent.replace(/\s+/g, " ").trim();
    if (text) textParts.push(text);
    if (textParts.join(" ").length >= 24000) break;
  }
  const subjects = xmlValues(packageXml, "subject");
  return {
    title: xmlValues(packageXml, "title")[0] || "",
    author: xmlValues(packageXml, "creator")[0] || "",
    category: subjects[0] || "",
    text: textParts.join(" ").slice(0, 24000)
  };
}

async function readBookFile(file) {
  const extension = file.name.split(".").pop().toLowerCase();
  if (extension !== "pdf" && extension !== "epub") throw new Error("Selecciona un archivo PDF o EPUB.");
  const details = extension === "pdf" ? await extractPdfMetadata(file) : await extractEpubMetadata(file);
  return { ...details, title: details.title || filenameTitle(file.name) };
}

async function handleBookFile(file) {
  if (!file) return;
  pendingBookFile = file;
  pendingExtractedText = "";
  const status = $("#book-file-status");
  status.textContent = `Leyendo ${file.name}...`;
  status.classList.remove("is-error");
  try {
    const metadata = await readBookFile(file);
    if (!$("#book-id").value || !$("#book-title").value.trim()) $("#book-title").value = metadata.title;
    else if (metadata.title) $("#book-title").value = metadata.title;
    if (metadata.author) $("#book-author").value = metadata.author;
    if (metadata.category) $("#book-category").value = metadata.category;
    pendingExtractedText = metadata.text;
    status.textContent = `Listo: ${file.name}. ${metadata.text ? "Se extrajo texto para ayudarte a crear preguntas." : "Completa los datos que no aparezcan en el archivo."}`;
  } catch (error) {
    $("#book-title").value ||= filenameTitle(file.name);
    status.textContent = `${file.name} está listo para adjuntarse. ${error.message} Puedes completar los datos manualmente.`;
    status.classList.add("is-error");
  }
}

function sentencesFrom(text) {
  return text.replace(/\s+/g, " ").match(/[^.!?]+[.!?]?/g)?.map(sentence => sentence.trim())
    .filter(sentence => sentence.split(/\s+/).length >= 7 && sentence.length <= 280) || [];
}

function analyzeBookText(text) {
  const sentences = [...new Set(sentencesFrom(text))];
  if (!sentences.length) return [];
  const stopWords = new Set("para como desde donde cuando quien quienes esta este estos estas sobre entre porque pero muy más menos también cada todo toda todos todas libro texto parte idea puede pueden sido fueron será son sus las los una uno unas unos del al por con sin que cual cuales cuyo cuya y o de la el en es se su un a e i u no ya".split(" "));
  const frequencies = new Map();
  for (const word of text.toLocaleLowerCase("es").match(/[a-záéíóúüñ]{5,}/g) || []) {
    if (!stopWords.has(word)) frequencies.set(word, (frequencies.get(word) || 0) + 1);
  }
  const count = Math.min(5, sentences.length);
  const selected = Array.from({ length: count }, (_, index) => sentences[Math.floor((index + 0.5) * sentences.length / count)]);
  const questionPatterns = [
    topic => `¿Qué explica el texto sobre ${topic}?`,
    topic => `¿Qué idea relaciona el libro con ${topic}?`,
    topic => `¿Qué aspecto de ${topic} conviene recordar?`,
    topic => `¿Qué afirma este fragmento acerca de ${topic}?`,
    topic => `¿Cómo presenta el texto ${topic}?`
  ];
  return selected.map((answer, index) => {
    const keywords = [...new Set(answer.toLocaleLowerCase("es").match(/[a-záéíóúüñ]{5,}/g) || [])]
      .filter(word => !stopWords.has(word))
      .sort((first, second) => (frequencies.get(second) || 0) - (frequencies.get(first) || 0));
    const topic = keywords.slice(0, 2).join(" ");
    return {
      id: crypto.randomUUID(),
      question: topic ? questionPatterns[index](topic) : "¿Cuál es la idea importante de este fragmento?",
      answer
    };
  });
}

function openBookAttachment(bookId) {
  const book = books.find(item => item.id === bookId);
  if (!book) return;
  getBookFile(bookId).then(file => {
    if (!file) throw new Error("No se encontró el archivo guardado en este dispositivo.");
    const fileUrl = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = fileUrl;
    link.download = book.fileName || "libro";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(fileUrl), 60000);
  }).catch(error => showToast(error.message));
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function themeFor(book) {
  const index = [...book.id].reduce((total, character) => total + character.charCodeAt(0), 0) % coverThemes.length;
  return coverThemes[index];
}

function statusLabel(status) {
  return { reading: "Leyendo", pending: "Pendiente", finished: "Terminado" }[status] || "Pendiente";
}

function render() {
  renderProfile();
  renderStats();
  renderNavigation();
  renderGenreFilters();
  renderLibrary();
  renderDetail();
  renderProgress();
  renderStudyBookOptions();
  renderStudyStage();
}

function renderProfile() {
  const name = profile?.name?.trim() || "Mi espacio";
  $("#profile-avatar").textContent = profile ? name.charAt(0).toLocaleUpperCase("es") : "L";
  $("#profile-avatar").setAttribute("aria-label", profile ? "Editar perfil" : "Crear perfil");
  $("#profile-name").textContent = name;
  $("#profile-email").textContent = profile?.email || "Perfil local";
}

function renderStats() {
  const questionCount = books.reduce((total, book) => total + (book.fileName && book.extractedText ? (book.questions?.length || 0) : 0), 0);
  $("#stat-books").textContent = books.length;
  $("#sidebar-book-count").textContent = books.length;
  $("#stat-reading").textContent = books.filter(book => book.status === "reading").length;
  $("#stat-questions").textContent = questionCount;
  $("#stat-finished").textContent = books.filter(book => book.status === "finished").length;
  $("#filter-count-all").textContent = books.length;
}

function renderNavigation() {
  const labels = { library: "Biblioteca", study: "Modo estudio", progress: "Progreso" };
  $$("[data-view]").forEach(button => button.classList.toggle("is-active", button.dataset.view === activeView));
  $("#breadcrumb-current").textContent = labels[activeView];
  $$(".view").forEach(view => { view.hidden = view.id !== `${activeView}-view`; });
}

function renderGenreFilters() {
  const genreCounts = new Map(standardGenres.map(label => [label.toLocaleLowerCase("es"), { label, count: 0 }]));
  books.forEach(book => {
    const label = book.category?.trim();
    if (!label) return;
    const key = label.toLocaleLowerCase("es");
    const genre = genreCounts.get(key) || { label, count: 0 };
    genre.count += 1;
    genreCounts.set(key, genre);
  });
  if (activeGenre !== "all" && !genreCounts.has(activeGenre)) activeGenre = "all";
  const standardKeys = new Set(standardGenres.map(label => label.toLocaleLowerCase("es")));
  const genres = [...genreCounts.entries()].sort((first, second) => {
    const firstIsStandard = standardKeys.has(first[0]);
    const secondIsStandard = standardKeys.has(second[0]);
    if (firstIsStandard && secondIsStandard) return standardGenres.indexOf(first[1].label) - standardGenres.indexOf(second[1].label);
    if (firstIsStandard !== secondIsStandard) return firstIsStandard ? -1 : 1;
    return first[1].label.localeCompare(second[1].label, "es");
  });
  $("#genre-filters").innerHTML = [
    `<button class="genre-chip${activeGenre === "all" ? " is-selected" : ""}" type="button" data-genre="all">Todos <span>${books.length}</span></button>`,
    ...genres.map(([key, genre]) => `<button class="genre-chip${activeGenre === key ? " is-selected" : ""}" type="button" data-genre="${escapeHtml(key)}">${escapeHtml(genre.label)} <span>${genre.count}</span></button>`)
  ].join("");
}

function filteredBooks() {
  const needle = searchTerm.trim().toLocaleLowerCase("es");
  return books.filter(book => {
    const matchesStatus = activeFilter === "all" || book.status === activeFilter;
    const matchesGenre = activeGenre === "all" || book.category?.trim().toLocaleLowerCase("es") === activeGenre;
    const searchable = [book.title, book.author, book.category, book.notes, ...(book.questions || []).flatMap(item => [item.question, item.answer])].join(" ").toLocaleLowerCase("es");
    return matchesStatus && matchesGenre && (!needle || searchable.includes(needle));
  });
}

function renderLibrary() {
  const grid = $("#book-grid");
  const sortBy = $("#sort-books").value;
  const visibleBooks = filteredBooks().sort((first, second) => {
    if (sortBy === "title") return first.title.localeCompare(second.title, "es");
    if (sortBy === "progress") return (second.progress || 0) - (first.progress || 0);
    return (second.createdAt || "").localeCompare(first.createdAt || "");
  });

  $("#visible-book-count").textContent = `${visibleBooks.length} ${visibleBooks.length === 1 ? "libro" : "libros"}`;
  if (!visibleBooks.length) {
    const message = searchTerm || activeFilter !== "all" || activeGenre !== "all"
      ? ["No encontramos ese libro", "Prueba con otra búsqueda o cambia el filtro."]
      : ["Tu estante está esperando", "Añade tu primer libro y empieza a guardar tus ideas."];
    grid.innerHTML = `<div class="empty-state"><span class="empty-symbol">✳</span><strong>${message[0]}</strong><p>${message[1]}</p>${!books.length ? '<button class="primary-button" type="button" data-action="add-book" style="margin-top:14px">Añadir libro</button>' : ""}</div>`;
    return;
  }

  grid.innerHTML = visibleBooks.map(book => `
    <button class="book-card${book.id === selectedBookId ? " is-selected" : ""}" type="button" data-select-book="${escapeHtml(book.id)}" aria-label="Ver detalles de ${escapeHtml(book.title)}">
      <div class="book-cover ${themeFor(book)}"><span class="cover-spine"></span><span class="cover-category">${escapeHtml(book.category || "LECTURA")}</span><span class="cover-title">${escapeHtml(book.title)}</span><span class="cover-author">${escapeHtml(book.author || "Autor desconocido")}</span></div>
      <div class="book-card-body"><div class="book-card-meta"><span class="status-tag ${escapeHtml(book.status)}">${statusLabel(book.status)}</span><span class="question-count">${book.fileName && book.extractedText ? (book.questions?.length || 0) : 0} preguntas</span></div><h3 class="book-card-title">${escapeHtml(book.title)}</h3><p class="book-card-author">${escapeHtml(book.author || "Autor desconocido")}</p><div class="card-progress" aria-label="${book.progress || 0}% leído"><span style="width:${Math.max(0, Math.min(100, Number(book.progress) || 0))}%"></span></div></div>
    </button>`).join("");
}

function renderDetail() {
  const panel = $("#detail-panel");
  const book = books.find(item => item.id === selectedBookId);
  if (!book) {
    panel.innerHTML = `<div class="detail-empty"><span class="detail-empty-mark">✳</span><strong>Elige un libro</strong><p>Selecciona un título para ver sus notas y preguntas.</p><button class="primary-button" type="button" data-action="add-book"><span class="plus-icon">+</span> Añadir libro</button></div>`;
    return;
  }

  const progress = Math.max(0, Math.min(100, Number(book.progress) || 0));
  const hasAnalyzableFile = Boolean(book.fileName && book.extractedText);
  const questions = hasAnalyzableFile ? (book.questions || []) : [];
  panel.innerHTML = `
    <div class="detail-topline"><span class="detail-label">FICHA DEL LIBRO</span><div class="detail-actions"><button class="small-icon-button" type="button" data-edit-book="${escapeHtml(book.id)}" aria-label="Editar libro" title="Editar">✎</button><button class="small-icon-button danger" type="button" data-delete-book="${escapeHtml(book.id)}" aria-label="Eliminar libro" title="Eliminar">×</button></div></div>
    <div class="detail-cover"><div class="book-cover ${themeFor(book)}"><span class="cover-spine"></span><span class="cover-category">${escapeHtml(book.category || "LECTURA")}</span><span class="cover-title">${escapeHtml(book.title)}</span><span class="cover-author">${escapeHtml(book.author || "")}</span></div></div>
    <h2 class="detail-book-title">${escapeHtml(book.title)}</h2><p class="detail-author">${escapeHtml(book.author || "Autor desconocido")}</p>
    <div class="detail-tags"><span class="category-tag">${escapeHtml(book.category || "Sin categoría")}</span><span class="detail-status ${escapeHtml(book.status)}">${statusLabel(book.status)}</span></div>
    ${book.fileName ? `<button class="attached-file" type="button" data-open-file="${escapeHtml(book.id)}"><span class="attached-file-mark">${book.fileName.toLowerCase().endsWith(".pdf") ? "PDF" : "EPUB"}</span><span><strong>${escapeHtml(book.fileName)}</strong><small>Descargar archivo adjunto</small></span><span class="download-mark" aria-hidden="true">↓</span></button>` : ""}
    <div class="detail-progress"><div class="progress-label-row"><span>Progreso de lectura</span><strong id="detail-progress-value">${progress}%</strong></div><div class="progress-track"><span id="detail-progress-fill" style="width:${progress}%"></span></div><input class="progress-slider" type="range" min="0" max="100" step="1" value="${progress}" data-progress-book="${escapeHtml(book.id)}" aria-label="Progreso de lectura, ${progress}%"></div>
    <div class="detail-section-title"><h3>Cuestionario</h3><span>${questions.length} ${questions.length === 1 ? "pregunta" : "preguntas"}</span></div>
    <div class="question-list">${questions.length ? questions.map(question => `<article class="question-item"><div class="question-top"><p class="question-text">${escapeHtml(question.question)}</p><div class="question-tools"><button type="button" data-edit-question="${escapeHtml(question.id)}" data-book-id="${escapeHtml(book.id)}" aria-label="Editar pregunta" title="Editar">✎</button><button type="button" data-delete-question="${escapeHtml(question.id)}" data-book-id="${escapeHtml(book.id)}" aria-label="Eliminar pregunta" title="Eliminar">×</button></div></div><button class="reveal-answer" type="button" data-reveal="${escapeHtml(question.id)}">Mostrar respuesta</button><p class="question-answer" id="answer-${escapeHtml(question.id)}" hidden>${escapeHtml(question.answer)}</p></article>`).join("") : `<p class="quiz-empty">${!book.fileName ? "El cuestionario aparecerá aquí cuando adjuntes un PDF o EPUB." : !book.extractedText ? "No se pudo extraer texto de este archivo. Prueba un PDF con texto seleccionable o un EPUB válido." : "Analiza el contenido del libro para crear preguntas."}</p>`}</div>
    ${hasAnalyzableFile ? `<button class="add-question-button" type="button" data-action="generate-book-questions" data-book-id="${escapeHtml(book.id)}">✳ ${questions.length ? "Volver a analizar con IA local" : "Analizar con IA local"}</button>` : ""}
    <div class="detail-notes"><h3>Notas y resumen</h3><p>${escapeHtml(book.notes || "Aún no has añadido notas. Edita la ficha para guardar ideas o un resumen.")}</p></div>`;
}

function renderProgress() {
  const average = books.length ? Math.round(books.reduce((total, book) => total + (Number(book.progress) || 0), 0) / books.length) : 0;
  const totalQuestions = books.reduce((total, book) => total + (book.fileName && book.extractedText ? (book.questions?.length || 0) : 0), 0);
  $("#progress-summary").innerHTML = `<div class="progress-summary-item"><span>Progreso medio</span><strong>${average}%</strong></div><div class="progress-summary-item"><span>Libros terminados</span><strong>${books.filter(book => book.status === "finished").length}</strong></div><div class="progress-summary-item"><span>Preguntas creadas</span><strong>${totalQuestions}</strong></div>`;
  $("#progress-book-count").textContent = `${books.length} ${books.length === 1 ? "libro" : "libros"}`;
  const list = $("#progress-list");
  if (!books.length) {
    list.innerHTML = '<div class="progress-empty">Todavía no hay libros para mostrar.</div>';
    return;
  }
  list.innerHTML = books.map(book => {
    const progress = Math.max(0, Math.min(100, Number(book.progress) || 0));
    return `<div class="progress-row"><div class="progress-book"><span class="progress-mini-cover ${themeFor(book)}">${escapeHtml(book.title.slice(0, 1))}</span><div><strong>${escapeHtml(book.title)}</strong><span>${escapeHtml(book.author || "Autor desconocido")}</span></div></div><div class="progress-row-track"><div class="progress-track"><span style="width:${progress}%"></span></div><span>${progress}%</span></div><span class="progress-row-status ${escapeHtml(book.status)}">${statusLabel(book.status)}</span><span class="progress-row-date">${book.createdAt ? formatDate(book.createdAt) : ""}</span></div>`;
  }).join("");
}

function formatDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function renderStudyBookOptions() {
  const select = $("#study-book-select");
  const previous = select.value || "all";
  select.innerHTML = '<option value="all">Todos los libros</option>' + books.map(book => `<option value="${escapeHtml(book.id)}">${escapeHtml(book.title)}</option>`).join("");
  select.value = books.some(book => book.id === previous) ? previous : "all";
}

function availableStudyQuestions() {
  const bookId = $("#study-book-select").value;
  return books.filter(book => bookId === "all" || book.id === bookId)
    .filter(book => book.fileName && book.extractedText)
    .flatMap(book => (book.questions || []).map(question => ({ ...question, bookId: book.id, bookTitle: book.title })));
}

function renderStudyStage() {
  const stage = $("#study-stage");
  const questions = availableStudyQuestions();
  if (!questions.length) {
    stage.innerHTML = `<div class="study-empty"><span class="empty-symbol">✳</span><h2>Aún no hay preguntas</h2><p>Importa un PDF o EPUB con texto para que BookMind analice su contenido y prepare el cuestionario.</p><button class="primary-button" type="button" data-action="add-book"><span class="plus-icon">+</span> Añadir libro</button></div>`;
    return;
  }
  if (!studyQuestion || !questions.some(item => item.id === studyQuestion.id)) {
    studyQuestion = questions[Math.floor(Math.random() * questions.length)];
    studyRevealed = false;
  }
  stage.innerHTML = `<article class="study-card"><span class="study-overline">PREGUNTA ALEATORIA</span><div class="study-book-title">${escapeHtml(studyQuestion.bookTitle)}</div><p class="study-question">${escapeHtml(studyQuestion.question)}</p>${studyRevealed ? `<p class="study-answer">${escapeHtml(studyQuestion.answer)}</p><button class="primary-button" type="button" data-study-next>Otra pregunta <span aria-hidden="true">→</span></button>` : '<div class="study-actions"><button class="primary-button" type="button" data-study-reveal>Revelar respuesta</button><button class="secondary-button" type="button" data-study-next>Pasar</button></div>'}</article>`;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function openBookDialog(book = null) {
  const form = $("#book-form");
  form.reset();
  $("#book-id").value = book?.id || "";
  $("#book-title").value = book?.title || "";
  $("#book-author").value = book?.author || "";
  $("#book-category").value = book?.category || "";
  $("#book-status").value = book?.status || "pending";
  $("#book-progress").value = book?.progress ?? 0;
  $("#book-notes").value = book?.notes || "";
  $("#book-file").value = "";
  pendingBookFile = null;
  pendingExtractedText = book?.extractedText || "";
  $("#book-file-status").textContent = book?.fileName ? `Archivo adjunto: ${book.fileName}. Selecciona otro para reemplazarlo.` : "El archivo se guardará en este dispositivo.";
  $("#book-file-status").classList.remove("is-error");
  $("#book-dialog-title").textContent = book ? "Editar libro" : "Añadir un libro";
  $("#book-submit").textContent = book ? "Guardar cambios" : "Guardar libro";
  $("#book-dialog").showModal();
  $("#book-title").focus();
}

function openProfileDialog() {
  $("#profile-form").reset();
  $("#profile-input-name").value = profile?.name || "";
  $("#profile-input-email").value = profile?.email || "";
  $("#profile-dialog-title").textContent = profile ? "Editar perfil" : "Crear perfil local";
  $("#profile-submit").textContent = profile ? "Guardar cambios" : "Guardar perfil";
  $("#profile-dialog").showModal();
  $("#profile-input-name").focus();
}

function openQuestionDialog(bookId, question = null) {
  $("#question-form").reset();
  $("#question-book-id").value = bookId;
  $("#question-id").value = question?.id || "";
  $("#question-text").value = question?.question || "";
  $("#answer-text").value = question?.answer || "";
  $("#question-dialog-title").textContent = question ? "Editar pregunta" : "Nueva pregunta";
  $("#question-dialog").showModal();
  $("#question-text").focus();
}

function selectView(view) {
  activeView = view;
  renderNavigation();
  if (view === "study") renderStudyStage();
}

document.addEventListener("click", event => {
  const target = event.target.closest("button");
  if (!target) return;

  if (target.dataset.view) {
    selectView(target.dataset.view);
  } else if (target.dataset.genre !== undefined) {
    activeGenre = target.dataset.genre;
    renderGenreFilters();
    renderLibrary();
    renderDetail();
  } else if (target.dataset.action === "home") {
    window.location.reload();
  } else if (target.dataset.action === "profile") {
    openProfileDialog();
  } else if (target.dataset.action === "add-book") {
    openBookDialog();
  } else if (target.dataset.action === "generate-book-questions") {
    const book = books.find(item => item.id === target.dataset.bookId);
    if (!book?.fileName || !book.extractedText) {
      showToast("Adjunta un PDF o EPUB con texto para analizarlo.");
      return;
    }
    book.questions = analyzeBookText(book.extractedText);
    saveBooks();
    render();
    showToast(book.questions.length ? `Cuestionario generado: ${book.questions.length} preguntas basadas en el libro.` : "No se encontró suficiente texto para crear preguntas.");
  } else if (target.dataset.openFile) {
    openBookAttachment(target.dataset.openFile);
  } else if (target.dataset.close) {
    $(`#${target.dataset.close}`).close();
  } else if (target.dataset.filter) {
    activeFilter = target.dataset.filter;
    $$("[data-filter]").forEach(button => button.classList.toggle("is-selected", button === target));
    renderLibrary();
    renderDetail();
  } else if (target.dataset.selectBook) {
    selectedBookId = target.dataset.selectBook;
    renderLibrary();
    renderDetail();
  } else if (target.dataset.editBook) {
    openBookDialog(books.find(book => book.id === target.dataset.editBook));
  } else if (target.dataset.deleteBook) {
    const book = books.find(item => item.id === target.dataset.deleteBook);
    if (book && window.confirm(`¿Eliminar “${book.title}” y todas sus preguntas?`)) {
      books = books.filter(item => item.id !== book.id);
      deleteBookFile(book.id).catch(() => {});
      if (selectedBookId === book.id) selectedBookId = books[0]?.id ?? null;
      saveBooks();
      render();
      showToast("Libro eliminado de tu biblioteca.");
    }
  } else if (target.dataset.addQuestion) {
    openQuestionDialog(target.dataset.addQuestion);
  } else if (target.dataset.editQuestion) {
    const book = books.find(item => item.id === target.dataset.bookId);
    const question = book?.questions?.find(item => item.id === target.dataset.editQuestion);
    if (book && question) openQuestionDialog(book.id, question);
  } else if (target.dataset.deleteQuestion) {
    const book = books.find(item => item.id === target.dataset.bookId);
    if (book && window.confirm("¿Eliminar esta pregunta?")) {
      book.questions = book.questions.filter(item => item.id !== target.dataset.deleteQuestion);
      saveBooks();
      render();
      showToast("Pregunta eliminada.");
    }
  } else if (target.dataset.reveal) {
    const answer = $(`#answer-${CSS.escape(target.dataset.reveal)}`);
    if (answer) {
      answer.hidden = !answer.hidden;
      target.textContent = answer.hidden ? "Mostrar respuesta" : "Ocultar respuesta";
    }
  } else if (target.hasAttribute("data-study-reveal")) {
    studyRevealed = true;
    renderStudyStage();
  } else if (target.hasAttribute("data-study-next")) {
    const questions = availableStudyQuestions();
    if (questions.length > 1) {
      const choices = questions.filter(item => item.id !== studyQuestion?.id);
      studyQuestion = choices[Math.floor(Math.random() * choices.length)];
    } else {
      studyQuestion = questions[0] || null;
    }
    studyRevealed = false;
    renderStudyStage();
  }
});

$("#profile-form").addEventListener("submit", event => {
  event.preventDefault();
  profile = {
    name: $("#profile-input-name").value.trim(),
    email: $("#profile-input-email").value.trim()
  };
  saveProfile();
  $("#profile-dialog").close();
  renderProfile();
  showToast("Perfil local guardado.");
});

$("#book-file").addEventListener("change", event => handleBookFile(event.target.files[0]));

$("#book-form").addEventListener("submit", async event => {
  event.preventDefault();
  const id = $("#book-id").value;
  const status = $("#book-status").value;
  const progress = status === "finished" ? 100 : Math.max(0, Math.min(100, Number($("#book-progress").value) || 0));
  const existing = books.find(book => book.id === id);
  const bookId = id || crypto.randomUUID();
  if (pendingBookFile) {
    try {
      await storeBookFile(bookId, pendingBookFile);
    } catch (error) {
      showToast(error.message || "No se pudo guardar el archivo adjunto.");
      return;
    }
  }
  const bookData = {
    id: bookId,
    title: $("#book-title").value.trim(),
    author: $("#book-author").value.trim(),
    category: $("#book-category").value.trim(),
    status,
    progress,
    notes: $("#book-notes").value.trim(),
    fileName: pendingBookFile?.name || existing?.fileName || "",
    fileType: pendingBookFile?.type || existing?.fileType || "",
    extractedText: pendingBookFile ? pendingExtractedText : existing?.extractedText || "",
    createdAt: existing?.createdAt || new Date().toISOString().slice(0, 10),
    questions: pendingBookFile
      ? (pendingExtractedText ? analyzeBookText(pendingExtractedText) : [])
      : (existing?.questions || [])
  };
  if (status === "finished") bookData.progress = 100;
  if (bookData.progress === 100) bookData.status = "finished";
  else if (status === "pending" && progress > 0) bookData.status = "reading";
  const importedNewFile = Boolean(pendingBookFile);
  if (existing) Object.assign(existing, bookData);
  else books.unshift(bookData);
  selectedBookId = bookData.id;
  pendingBookFile = null;
  pendingExtractedText = "";
  saveBooks();
  $("#book-dialog").close();
  render();
  showToast(importedNewFile ? (bookData.questions.length ? `Libro guardado; ${bookData.questions.length} ${bookData.questions.length === 1 ? "pregunta generada" : "preguntas generadas"} con análisis local.` : "Libro guardado; no se pudo extraer texto para el cuestionario.") : existing ? "Cambios guardados." : "Libro añadido a tu estante.");
});

$("#question-form").addEventListener("submit", event => {
  event.preventDefault();
  const book = books.find(item => item.id === $("#question-book-id").value);
  if (!book) return;
  book.questions ||= [];
  const questionId = $("#question-id").value;
  const existing = book.questions.find(item => item.id === questionId);
  const questionData = { id: questionId || crypto.randomUUID(), question: $("#question-text").value.trim(), answer: $("#answer-text").value.trim() };
  if (existing) Object.assign(existing, questionData);
  else book.questions.push(questionData);
  selectedBookId = book.id;
  saveBooks();
  $("#question-dialog").close();
  render();
  showToast(existing ? "Pregunta actualizada." : "Pregunta guardada.");
});

$("#global-search").addEventListener("input", event => {
  searchTerm = event.target.value;
  renderLibrary();
  renderDetail();
});
$("#sort-books").addEventListener("change", renderLibrary);
$("#study-book-select").addEventListener("change", () => { studyQuestion = null; studyRevealed = false; renderStudyStage(); });
$("#detail-panel").addEventListener("input", event => {
  if (!event.target.matches("[data-progress-book]")) return;
  const book = books.find(item => item.id === event.target.dataset.progressBook);
  if (!book) return;
  const progress = Number(event.target.value);
  $("#detail-progress-value").textContent = `${progress}%`;
  $("#detail-progress-fill").style.width = `${progress}%`;
});
$("#detail-panel").addEventListener("change", event => {
  if (!event.target.matches("[data-progress-book]")) return;
  const book = books.find(item => item.id === event.target.dataset.progressBook);
  if (!book) return;
  book.progress = Number(event.target.value);
  book.status = book.progress === 100 ? "finished" : book.progress > 0 ? "reading" : "pending";
  saveBooks();
  render();
  showToast("Progreso actualizado.");
});
document.addEventListener("keydown", event => {
  if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) && !$(".app-dialog[open]")) {
    event.preventDefault();
    $("#global-search").focus();
  }
  if (event.key === "Escape") $$(".app-dialog[open]").forEach(dialog => dialog.close());
});

render();