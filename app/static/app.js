const $ = (selector) => document.querySelector(selector);
const form = $("#cvForm");
const preview = $("#cvPreview");
const groups = { skillGroups: $("#skillGroups"), experiences: $("#experiences"), educationItems: $("#educationItems") };
const templates = { skillGroups: $("#skillGroupTemplate"), experiences: $("#itemTemplate"), educationItems: $("#educationTemplate") };
let account = null;
let resumes = [];
let currentResumeId = null;
let currentStatus = "draft";
let currentTemplateId = "";
let saveTimer = null;
let generateTimer = null;
let generation = 0;

function toast(message) {
  const node = $("#toast"); node.textContent = message; node.classList.add("is-visible");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("is-visible"), 2400);
}

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  if (response.status === 404 && url.startsWith("/api/")) throw new Error("Le serveur utilise une ancienne version. Redémarrez l’application puis actualisez la page.");
  if (!response.ok) throw new Error(`Erreur ${response.status}`);
  return response.json();
}

function escapeHtml(value = "") {
  const div = document.createElement("div"); div.textContent = value; return div.innerHTML;
}

function formatDate(value) { return new Date(value).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }); }

function blankPayload() {
  const fullName = account ? `${account.first_name || ""} ${account.last_name || ""}`.trim() : "";
  return { profile: { name: fullName, target_title: "", location: account?.location || account?.address || "", email: account?.email || "", phone: account?.phone || "", links: account?.links || "", summary: "", summary_alignment: "left", skill_groups: [], experiences: [], education_items: [], languages: "" }, job_offer: "", profile_mode: "auto", use_ollama: false, cv_font: "Arial, Helvetica, sans-serif", cv_theme: "theme-slate" };
}

function itemData(node) {
  const out = {};
  node.querySelectorAll("[data-field]").forEach((field) => { out[field.dataset.field] = field.type === "checkbox" ? field.checked : field.value; });
  return out;
}

function refreshItem(node) {
  const data = itemData(node); node.querySelector("[data-item-title]").textContent = data.title || data.name || "Nouvel élément";
  node.querySelector("[data-item-meta]").textContent = [data.organization, data.period].filter(Boolean).join(" · ");
}

function addItem(groupName, data = {}) {
  const node = templates[groupName].content.firstElementChild.cloneNode(true);
  node.querySelectorAll("[data-field]").forEach((field) => {
    const value = data[field.dataset.field];
    if (field.type === "checkbox") field.checked = value !== false; else field.value = value || "";
  });
  node.querySelector("[data-toggle-item]").addEventListener("click", (event) => {
    if (event.target.closest("[data-move-up],[data-move-down]")) return;
    node.classList.toggle("is-collapsed");
  });
  node.querySelector("[data-remove]").addEventListener("click", () => { node.remove(); changed(); });
  node.querySelector("[data-move-up]").addEventListener("click", () => { if (node.previousElementSibling) node.parentElement.insertBefore(node, node.previousElementSibling); changed(); });
  node.querySelector("[data-move-down]").addEventListener("click", () => { if (node.nextElementSibling) node.parentElement.insertBefore(node.nextElementSibling, node); changed(); });
  node.addEventListener("input", () => refreshItem(node));
  refreshItem(node); groups[groupName].appendChild(node); return node;
}

function readItems(groupName) { return [...groups[groupName].children].map(itemData); }

function readPayload() {
  const data = new FormData(form);
  return { profile: { name: data.get("name") || "", target_title: data.get("target_title") || "", location: data.get("location") || "", email: data.get("email") || "", phone: data.get("phone") || "", links: data.get("links") || "", summary: data.get("summary") || "", summary_alignment: data.get("summary_alignment") || "left", skill_groups: readItems("skillGroups"), experiences: readItems("experiences"), education_items: readItems("educationItems"), languages: data.get("languages") || "", skills: "", education: "" }, job_offer: data.get("job_offer") || "", profile_mode: "auto", use_ollama: $("#useOllama").checked, cv_font: $("#cvFont").value, cv_theme: $("#cvTheme").value };
}

function applyPayload(payload) {
  const profile = payload?.profile || {};
  ["name", "target_title", "location", "email", "phone", "links", "summary", "languages"].forEach((name) => { form.elements[name].value = profile[name] || ""; });
  form.elements.summary_alignment.value = profile.summary_alignment || "left";
  form.elements.job_offer.value = payload?.job_offer || "";
  $("#useOllama").checked = Boolean(payload?.use_ollama);
  $("#cvFont").value = payload?.cv_font || "Arial, Helvetica, sans-serif";
  $("#cvTheme").value = payload?.cv_theme || "theme-slate";
  Object.values(groups).forEach((group) => { group.innerHTML = ""; });
  (profile.skill_groups || []).forEach((item) => addItem("skillGroups", item));
  (profile.experiences || []).forEach((item) => addItem("experiences", item));
  (profile.education_items || []).forEach((item) => addItem("educationItems", item));
  if (!groups.skillGroups.children.length) addItem("skillGroups", { name: "Compétences clés", include: true });
  if (!groups.experiences.children.length) addItem("experiences");
  if (!groups.educationItems.children.length) addItem("educationItems");
  applyDesign();
}

function applyDesign() {
  preview.style.setProperty("--cv-font", $("#cvFont").value);
  preview.querySelectorAll(".cv-page").forEach((page) => { page.className = `cv-page ${$("#cvTheme").value}`; });
}

function renderMatch(result, hasJobOffer) {
  const scoreNode = $("#matchScore"); const keywordsNode = $("#keywordsRow");
  if (!hasJobOffer) { scoreNode.classList.add("is-hidden"); keywordsNode.classList.add("is-hidden"); return; }
  scoreNode.classList.remove("is-hidden");
  scoreNode.textContent = `Correspondance offre : ${result.match_score}%`;
  scoreNode.classList.remove("score-low", "score-mid", "score-high");
  scoreNode.classList.add(result.match_score >= 66 ? "score-high" : result.match_score >= 33 ? "score-mid" : "score-low");
  if (result.keywords.length) {
    keywordsNode.classList.remove("is-hidden");
    keywordsNode.innerHTML = result.keywords.map((word) => `<span>${escapeHtml(word)}</span>`).join("");
  } else { keywordsNode.classList.add("is-hidden"); }
}

async function generateNow() {
  const id = ++generation;
  $("#status").textContent = "Mise à jour…";
  try {
    const payload = readPayload();
    const result = await api("/api/generate", { method: "POST", body: JSON.stringify(payload) });
    if (id !== generation) return;
    preview.innerHTML = result.html; applyDesign(); $("#status").textContent = "Aperçu à jour";
    renderMatch(result, Boolean(payload.job_offer.trim()));
    if (payload.use_ollama && !result.used_ollama && result.note) toast(result.note);
  } catch (error) { $("#status").textContent = error.message; }
}

function changed() {
  $("#saveState").textContent = "Modifications non enregistrées";
  clearTimeout(generateTimer); generateTimer = setTimeout(generateNow, 450);
  clearTimeout(saveTimer); if (currentResumeId) saveTimer = setTimeout(() => saveResume(true), 1200);
}

function resumeBody() { return { title: $("#resumeTitle").value.trim() || "CV sans titre", status: currentStatus, template_id: currentTemplateId, payload: readPayload(), generated_html: preview.innerHTML }; }

async function saveResume(silent = false) {
  const body = resumeBody();
  const data = currentResumeId
    ? await api(`/api/resumes/${currentResumeId}`, { method: "PUT", body: JSON.stringify(body) })
    : await api("/api/resumes", { method: "POST", body: JSON.stringify(body) });
  currentResumeId = data.resume.id; $("#saveState").textContent = `Enregistré à ${new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  $("#activeResumeName").textContent = body.title; if (!silent) toast("CV enregistré");
}

function showEditor() { $("#homeView").classList.add("is-hidden"); $("#editorView").classList.remove("is-hidden"); document.body.classList.add("editor-open"); }
function showHome() { $("#editorView").classList.add("is-hidden"); $("#homeView").classList.remove("is-hidden"); document.body.classList.remove("editor-open"); loadDashboard(); }

async function newResumeFrom(payload = null, templateId = "") {
  currentResumeId = null; currentStatus = "draft"; currentTemplateId = templateId; $("#resumeTitle").value = "Nouveau CV"; $("#activeResumeName").textContent = "Nouveau CV"; $("#saveState").textContent = "Brouillon non enregistré"; updateStatusButton();
  applyPayload(payload || blankPayload()); showEditor(); await generateNow();
}

async function openResume(id) {
  const data = await api(`/api/resumes/${id}`); const resume = data.resume; if (!resume) return;
  currentResumeId = resume.id; currentStatus = resume.status; currentTemplateId = resume.template_id || "";
  $("#resumeTitle").value = resume.title; $("#activeResumeName").textContent = resume.title; $("#saveState").textContent = `Enregistré le ${formatDate(resume.updated_at)}`; updateStatusButton(); applyPayload(resume.payload); showEditor();
  if (resume.generated_html) { preview.innerHTML = resume.generated_html; applyDesign(); }
  await generateNow();
}

function updateStatusButton() { $("#toggleStatus").textContent = currentStatus === "final" ? "Repasser en brouillon" : "Finaliser"; $("#toggleStatus").classList.toggle("is-final", currentStatus === "final"); }

async function loadDashboard() {
  const [resumeData, templateData] = await Promise.all([api("/api/resumes"), api("/api/templates")]);
  resumes = resumeData.resumes || []; const personalTemplates = templateData.templates || [];
  $("#resumeCount").textContent = resumes.length; $("#draftCount").textContent = resumes.filter((r) => r.status === "draft").length; $("#templateCount").textContent = personalTemplates.length;
  renderResumes(); renderTemplates(personalTemplates);
}

function renderResumes() {
  const filter = $("#resumeFilter").value; const list = resumes.filter((r) => filter === "all" || r.status === filter);
  $("#resumeGrid").innerHTML = list.length ? list.map((r) => `<article class="profile-card resume-card"><div><span class="status-pill ${r.status}">${r.status === "final" ? "Finalisé" : "Brouillon"}</span><h3>${escapeHtml(r.title)}</h3><p>Modifié le ${formatDate(r.updated_at)}</p></div><div class="profile-card-actions"><button data-open-resume="${r.id}">Ouvrir</button><button data-duplicate-resume="${r.id}">Dupliquer</button><button class="danger" data-delete-resume="${r.id}">Supprimer</button></div></article>`).join("") : `<article class="empty-library"><h3>Aucun CV ici</h3><p>Créez votre premier CV pour le retrouver automatiquement dans cet espace.</p></article>`;
}

function renderTemplates(list) {
  const starter = [{ id: "starter-modern", name: "Essentiel moderne", description: "Une mise en page ATS claire et professionnelle.", theme: "theme-navy" }, { id: "starter-classic", name: "Classique élégant", description: "Un style intemporel pour tous les secteurs.", theme: "theme-burgundy" }];
  $("#templateGrid").innerHTML = [...starter, ...list].map((t) => `<article class="profile-card template-card"><div><span class="template-swatch ${t.theme || "theme-teal"}"></span><h3>${escapeHtml(t.name)}</h3><p>${escapeHtml(t.description || "Modèle personnel")}</p></div><div class="profile-card-actions"><button class="primary" data-use-template="${t.id}">Utiliser</button>${t.theme ? "" : `<button class="danger" data-delete-template="${t.id}">Supprimer</button>`}</div></article>`).join("");
}

async function useTemplate(id) {
  if (id.startsWith("starter-")) { const payload = blankPayload(); payload.cv_theme = id === "starter-modern" ? "theme-navy" : "theme-burgundy"; return newResumeFrom(payload, id); }
  const data = await api(`/api/templates/${id}`); return newResumeFrom(data.template.payload, id);
}

async function loadAccount() {
  const data = await api("/api/account"); account = data.account?.payload || null;
  if (!account) $("#accountOverlay").classList.remove("is-hidden");
}

function openAccount() { const a = account || {}; [...$("#accountForm").elements].forEach((field) => { if (field.name) field.value = a[field.name] || ""; }); $("#accountOverlay").classList.remove("is-hidden"); }

async function withLoading(button, task) {
  const dark = !button.classList.contains("primary");
  button.classList.add("btn-loading"); if (dark) button.classList.add("btn-load-dark");
  try { return await task(); } finally { button.classList.remove("btn-loading", "btn-load-dark"); }
}

form.addEventListener("input", changed); form.addEventListener("change", changed); $("#resumeTitle").addEventListener("input", changed);
document.addEventListener("click", (event) => { const add = event.target.closest("[data-add]"); if (add) { addItem(add.dataset.add); changed(); } });
$("#newResume").addEventListener("click", () => newResumeFrom()); $("#backHome").addEventListener("click", showHome);
$("#saveResume").addEventListener("click", (event) => withLoading(event.currentTarget, () => saveResume()));
$("#browseTemplates").addEventListener("click", () => $("#templateSection").scrollIntoView({ behavior: "smooth" })); $("#resumeFilter").addEventListener("change", renderResumes);
$("#cvFont").addEventListener("change", () => { applyDesign(); changed(); }); $("#cvTheme").addEventListener("change", () => { applyDesign(); changed(); });
$("#toggleStatus").addEventListener("click", (event) => withLoading(event.currentTarget, async () => { currentStatus = currentStatus === "final" ? "draft" : "final"; updateStatusButton(); await saveResume(); toast(currentStatus === "final" ? "CV finalisé" : "CV repassé en brouillon"); }));
$("#printCv").addEventListener("click", () => {
  const originalTitle = document.title;
  document.title = " ";
  const restoreTitle = () => { document.title = originalTitle; };
  window.addEventListener("afterprint", restoreTitle, { once: true });
  window.print();
  setTimeout(restoreTitle, 1500);
});
$("#exportHtml").addEventListener("click", (event) => withLoading(event.currentTarget, async () => { const css = await fetch("/static/styles.css").then((r) => r.text()); const blob = new Blob([`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml($("#resumeTitle").value || "CV")}</title><style>${css}\nbody{overflow:auto;background:#eef2f7}.cv-page{margin:24px auto}</style></head><body>${preview.innerHTML}</body></html>`], { type: "text/html" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${($("#resumeTitle").value || "cv").replace(/[^a-z0-9]+/gi, "-")}.html`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }));
$("#saveTemplate").addEventListener("click", (event) => withLoading(event.currentTarget, async () => { const name = prompt("Nom du modèle", `${$("#resumeTitle").value || "Mon CV"} — modèle`); if (!name) return; await api("/api/templates", { method: "POST", body: JSON.stringify({ name, description: "Modèle créé depuis un CV personnel", payload: readPayload(), generated_html: preview.innerHTML }) }); toast("Modèle enregistré"); }));
$("#deleteResume").addEventListener("click", (event) => withLoading(event.currentTarget, async () => { if (!currentResumeId || !confirm("Supprimer définitivement ce CV ?")) return; await api(`/api/resumes/${currentResumeId}`, { method: "DELETE" }); toast("CV supprimé"); showHome(); }));
$("#resumeGrid").addEventListener("click", async (event) => { const open = event.target.closest("[data-open-resume]"); const duplicate = event.target.closest("[data-duplicate-resume]"); const remove = event.target.closest("[data-delete-resume]"); if (open) openResume(open.dataset.openResume); if (duplicate) { const data = await api(`/api/resumes/${duplicate.dataset.duplicateResume}`); await newResumeFrom(data.resume.payload, data.resume.template_id); $("#resumeTitle").value = `${data.resume.title} — copie`; } if (remove && confirm("Supprimer définitivement ce CV ?")) { await api(`/api/resumes/${remove.dataset.deleteResume}`, { method: "DELETE" }); loadDashboard(); } });
$("#templateGrid").addEventListener("click", async (event) => { const use = event.target.closest("[data-use-template]"); const remove = event.target.closest("[data-delete-template]"); if (use) useTemplate(use.dataset.useTemplate); if (remove && confirm("Supprimer ce modèle ?")) { await api(`/api/templates/${remove.dataset.deleteTemplate}`, { method: "DELETE" }); loadDashboard(); } });
function closeAccountModal() { $("#accountOverlay").classList.add("is-hidden"); }
$("#accountButton").addEventListener("click", openAccount); $("#closeAccount").addEventListener("click", closeAccountModal);
$("#accountOverlay").addEventListener("click", (event) => { if (event.target === $("#accountOverlay")) closeAccountModal(); });
$("#accountForm").addEventListener("submit", async (event) => { event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); const data = await api("/api/account", { method: "PUT", body: JSON.stringify(values) }); account = data.account.payload; $("#accountOverlay").classList.add("is-hidden"); toast("Compte enregistré"); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("#accountOverlay").classList.contains("is-hidden")) closeAccountModal(); if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !$("#editorView").classList.contains("is-hidden")) { event.preventDefault(); saveResume(); } });
window.addEventListener("unhandledrejection", (event) => { event.preventDefault(); toast(event.reason?.message || "Une erreur empêche l’enregistrement."); });

async function init() { await loadAccount(); await loadDashboard(); }
init().catch((error) => toast(error.message));
