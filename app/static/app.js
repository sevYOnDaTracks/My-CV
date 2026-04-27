const form = document.querySelector("#cvForm");
const homeView = document.querySelector("#homeView");
const workflowDashboard = document.querySelector("#workflowDashboard");
const profileQuickStart = document.querySelector("#profileQuickStart");
const profilesListSection = document.querySelector("#profilesListSection");
const applicationPanel = document.querySelector("#applicationPanel");
const draftListSection = document.querySelector("#draftListSection");
const editorView = document.querySelector("#editorView");
const preview = document.querySelector("#cvPreview");
const statusEl = document.querySelector("#status");
const keywordsEl = document.querySelector("#keywords");
const profileGrid = document.querySelector("#profileGrid");
const profileCount = document.querySelector("#profileCount");
const cvDraftGrid = document.querySelector("#cvDraftGrid");
const cvDraftCount = document.querySelector("#cvDraftCount");
const applicationTitle = document.querySelector("#applicationTitle");
const applicationCompany = document.querySelector("#applicationCompany");
const applicationOffer = document.querySelector("#applicationOffer");
const applicationStatus = document.querySelector("#applicationStatus");
const activeProfileName = document.querySelector("#activeProfileName");
const template = document.querySelector("#itemTemplate");
const educationTemplate = document.querySelector("#educationTemplate");
const skillGroupTemplate = document.querySelector("#skillGroupTemplate");
const cvFont = document.querySelector("#cvFont");
const cvTheme = document.querySelector("#cvTheme");
const STORAGE_KEY = "generator_cv_draft_v1";
const DRAFT_ID = "default";
const AUTO_GENERATE_DELAY = 700;
const DATABASE_SAVE_DELAY = 300;

let autoGenerateTimer;
let databaseSaveTimer;
let generationId = 0;
let currentProfileId = null;
let currentProfileLabel = "";
let currentCvDraftId = null;
let currentCvDraftTitle = "";
let currentCvDraftCompany = "";
let currentSelectedProfileId = "";
let currentApplicationOffer = "";
let currentMatchScore = 0;
let pendingDatabaseDraft = null;

const groups = {
  skillGroups: document.querySelector("#skillGroups"),
  experiences: document.querySelector("#experiences"),
  educationItems: document.querySelector("#educationItems"),
};

const modeLabels = {
  auto: "Auto",
  data: "Data",
  ai: "IA",
  dev: "Dev",
  hybrid: "Hybride",
};

function showHome() {
  editorView.classList.add("is-hidden");
  homeView.classList.remove("is-hidden");
  document.body.classList.remove("editor-open");
  showHomeDashboard();
}

function showHomeDashboard() {
  workflowDashboard.classList.remove("is-hidden");
  profileQuickStart.classList.add("is-hidden");
  profilesListSection.classList.add("is-hidden");
  applicationPanel.classList.add("is-hidden");
  draftListSection.classList.add("is-hidden");
}

function showWorkflow(workflow) {
  workflowDashboard.classList.add("is-hidden");
  profileQuickStart.classList.toggle("is-hidden", workflow !== "profiles");
  profilesListSection.classList.toggle("is-hidden", workflow !== "profiles");
  applicationPanel.classList.toggle("is-hidden", workflow !== "applications");
  draftListSection.classList.toggle("is-hidden", workflow !== "applications");

  if (workflow === "profiles") loadProfiles();
  if (workflow === "applications") loadCvDrafts();
}

function showEditor() {
  homeView.classList.add("is-hidden");
  editorView.classList.remove("is-hidden");
  document.body.classList.add("editor-open");
}

function makeBlankDraft(mode = "hybrid", name = "") {
  return {
    profile: {
      name: "",
      target_title: modeLabels[mode] ? `Profil ${modeLabels[mode]}` : name,
      location: "",
      email: "",
      phone: "",
      links: "",
      summary: "",
      skills: "",
      skill_groups: defaultSkillGroups(mode),
      languages: "",
      experiences: [],
      education_items: [],
    },
    job_offer: "",
    profile_mode: mode,
    cv_font: "Arial, Helvetica, sans-serif",
    cv_theme: mode === "data" ? "theme-navy" : "theme-slate",
    use_ollama: false,
  };
}

function defaultSkillGroups(mode = "hybrid") {
  const common = [
    { name: "Langages", skills: "Python, JavaScript, SQL", include: true },
    { name: "Cloud / DevOps", skills: "Docker, Git, Linux", include: true },
  ];

  const presets = {
    data: [
      { name: "Data Engineering", skills: "Airflow, Spark, ETL, ELT, dbt", include: true },
      { name: "Bases de données", skills: "PostgreSQL, MySQL, MongoDB", include: true },
      { name: "BI / Analyse", skills: "Power BI, Tableau, Excel", include: true },
    ],
    ai: [
      { name: "IA / LLM", skills: "Machine Learning, LLM, RAG, Ollama", include: true },
      { name: "Data", skills: "Pandas, NumPy, Scikit-learn", include: true },
      { name: "Backend IA", skills: "FastAPI, API REST", include: true },
    ],
    dev: [
      { name: "Backend", skills: "FastAPI, Flask, API REST, Spring Boot", include: true },
      { name: "Frontend", skills: "React, Angular, HTML, CSS", include: true },
      { name: "Bases de données", skills: "PostgreSQL, SQL", include: true },
    ],
    hybrid: [
      { name: "Backend / APIs", skills: "FastAPI, Flask, API REST", include: true },
      { name: "Frontend", skills: "React, Angular, JavaScript", include: true },
      { name: "Data / IA", skills: "Pandas, Spark, Airflow, Machine Learning, LLM, RAG", include: true },
    ],
  };

  return [...(presets[mode] || presets.hybrid), ...common];
}

function migrateLegacySkills(skills) {
  const rawSkills = String(skills || "").split(/[,;\n]/).map((skill) => skill.trim()).filter(Boolean);
  if (!rawSkills.length) return [];

  const buckets = {
    "Langages": ["java", "python", "javascript", "typescript", "sql", "html", "css"],
    "Backend / APIs": ["fastapi", "flask", "django", "spring", "api", "rest", "node"],
    "Frontend": ["react", "angular", "vue"],
    "Data": ["postgresql", "mysql", "mongodb", "pandas", "spark", "airflow", "etl", "dbt"],
    "IA": ["machine learning", "llm", "rag", "ollama", "pytorch", "tensorflow"],
    "Cloud / DevOps": ["docker", "git", "kubernetes", "aws", "azure", "gcp", "linux"],
    "BI / Analyse": ["power bi", "powerbi", "tableau", "excel"],
    "Autres": [],
  };

  const grouped = Object.fromEntries(Object.keys(buckets).map((name) => [name, []]));

  rawSkills.forEach((skill) => {
    const key = skill.toLowerCase();
    const category = Object.entries(buckets).find(([, aliases]) => (
      aliases.some((alias) => key.includes(alias))
    ))?.[0] || "Autres";
    grouped[category].push(skill);
  });

  return Object.entries(grouped)
    .filter(([, values]) => values.length)
    .map(([name, values]) => ({ name, skills: values.join(", "), include: true }));
}

function addItem(groupName, data = {}) {
  const sourceTemplate = groupName === "educationItems"
    ? educationTemplate
    : groupName === "skillGroups"
      ? skillGroupTemplate
      : template;
  const node = sourceTemplate.content.firstElementChild.cloneNode(true);
  const itemData = { ...data };

  if (
    groupName === "educationItems" &&
    itemData.include === undefined &&
    /certification/i.test(itemData.title || "")
  ) {
    itemData.include = false;
  }

  Object.entries(itemData).forEach(([key, value]) => {
    const field = node.querySelector(`[data-field="${key}"]`);
    if (!field) return;
    if (field.type === "checkbox") {
      field.checked = value !== false;
      return;
    }
    field.value = value;
  });
  refreshItemHeader(node, groupName);

  setupDragAndDrop(node);

  node.querySelector("[data-toggle-item]").addEventListener("click", () => {
    node.classList.toggle("is-collapsed");
  });

  node.querySelectorAll("[data-field]").forEach((field) => {
    field.addEventListener("input", () => refreshItemHeader(node, groupName));
    field.addEventListener("change", () => refreshItemHeader(node, groupName));
  });

  node.querySelector("[data-remove]").addEventListener("click", () => {
    node.remove();
    saveDraft("Sauvegarde automatique");
    scheduleAutoGenerate();
  });
  groups[groupName].appendChild(node);
  if (Object.keys(data).length) node.classList.add("is-collapsed");
}

function setupDragAndDrop(node) {
  const handle = node.querySelector("[data-drag-handle]");
  handle.addEventListener("pointerdown", () => {
    node.draggable = true;
  });

  handle.addEventListener("pointerup", () => {
    node.draggable = false;
  });

  node.addEventListener("dragstart", (event) => {
    if (!event.target.closest("[data-drag-handle]")) {
      event.preventDefault();
      return;
    }

    node.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", "");
  });

  node.addEventListener("dragend", () => {
    node.classList.remove("is-dragging");
    node.draggable = false;
    document.querySelectorAll(".item-editor.is-drop-target").forEach((item) => {
      item.classList.remove("is-drop-target");
    });
    saveDraft("Ordre mis à jour");
    scheduleAutoGenerate();
  });

  node.addEventListener("dragover", (event) => {
    const dragging = document.querySelector(".item-editor.is-dragging");
    if (!dragging || dragging === node || dragging.parentElement !== node.parentElement) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    node.classList.add("is-drop-target");

    const rect = node.getBoundingClientRect();
    const shouldInsertAfter = event.clientY > rect.top + rect.height / 2;
    if (shouldInsertAfter) {
      node.after(dragging);
    } else {
      node.before(dragging);
    }
  });

  node.addEventListener("dragleave", () => {
    node.classList.remove("is-drop-target");
  });
}

function refreshItemHeader(node, groupName) {
  const titleEl = node.querySelector("[data-item-title]");
  const metaEl = node.querySelector("[data-item-meta]");
  const getValue = (fieldName) => node.querySelector(`[data-field="${fieldName}"]`)?.value?.trim() || "";

  if (groupName === "skillGroups") {
    const category = getValue("name") || "Nouvelle catégorie";
    const skills = getValue("skills").split(/[,;\n]/).map((skill) => skill.trim()).filter(Boolean);
    titleEl.textContent = category;
    metaEl.textContent = `${skills.length} compétence${skills.length > 1 ? "s" : ""}`;
    return;
  }

  const title = getValue("title") || (groupName === "educationItems" ? "Nouvelle formation" : "Nouvelle expérience");
  const organization = getValue("organization");
  const period = getValue("period");
  titleEl.textContent = title;
  metaEl.textContent = [organization, period].filter(Boolean).join(" · ");
}

function readItems(groupName) {
  return [...groups[groupName].querySelectorAll(".item-editor")].map((node) => {
    const item = {};
    node.querySelectorAll("[data-field]").forEach((field) => {
      item[field.dataset.field] = field.type === "checkbox"
        ? field.checked
        : field.value.trim();
    });
    return item;
  });
}

function readProfile() {
  const data = new FormData(form);
  return {
    name: data.get("name") || "",
    target_title: data.get("target_title") || "",
    location: data.get("location") || "",
    email: data.get("email") || "",
    phone: data.get("phone") || "",
    links: data.get("links") || "",
    summary: data.get("summary") || "",
    skills: readItems("skillGroups").map((group) => group.skills).join(", "),
    skill_groups: readItems("skillGroups"),
    languages: data.get("languages") || "",
    experiences: readItems("experiences"),
    education_items: readItems("educationItems"),
  };
}

function readDraft() {
  const data = new FormData(form);
  return {
    profile: readProfile(),
    job_offer: data.get("job_offer") || "",
    profile_mode: data.get("profile_mode") || "auto",
    cv_font: cvFont.value,
    cv_theme: cvTheme.value,
    use_ollama: data.get("use_ollama") === "on",
  };
}

function saveDraft(message = "Brouillon sauvegardé") {
  const draft = readDraft();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  scheduleDatabaseSave(draft);
  statusEl.textContent = message;
}

function scheduleDatabaseSave(draft) {
  pendingDatabaseDraft = draft;
  clearTimeout(databaseSaveTimer);
  databaseSaveTimer = setTimeout(() => {
    saveDraftToDatabase(draft);
  }, DATABASE_SAVE_DELAY);
}

async function saveDraftToDatabase(draft) {
  try {
    await fetch(`/api/draft/${DRAFT_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: draft }),
    });
    if (currentCvDraftId) {
      await saveCurrentCvDraft(draft);
    } else if (currentProfileId) {
      await saveCurrentProfile(draft);
    }
    if (pendingDatabaseDraft === draft) pendingDatabaseDraft = null;
  } catch (error) {
    statusEl.textContent = `Sauvegarde SQLite indisponible: ${error.message}`;
  }
}

function flushDatabaseSave() {
  if (!pendingDatabaseDraft) return;

  fetch(`/api/draft/${DRAFT_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: pendingDatabaseDraft }),
    keepalive: true,
  }).catch(() => {});

  if (currentCvDraftId) {
    const draft = pendingDatabaseDraft;
    fetch(`/api/cv-drafts/${currentCvDraftId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildCvDraftPayload(draft)),
      keepalive: true,
    }).catch(() => {});
  } else if (currentProfileId) {
    const draft = pendingDatabaseDraft;
    const mode = draft.profile_mode || "hybrid";
    const name = currentProfileLabel || draft.profile.target_title || `Profil ${modeLabels[mode] || mode}`;

    fetch(`/api/profiles/${currentProfileId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mode, payload: draft }),
      keepalive: true,
    }).catch(() => {});
  }
}

function buildCvDraftPayload(draft = readDraft()) {
  return {
    title: currentCvDraftTitle || draft.profile.target_title || "Brouillon CV",
    company: currentCvDraftCompany || "",
    selected_profile_id: currentSelectedProfileId || "",
    job_offer: currentApplicationOffer || draft.job_offer || "",
    payload: draft,
    generated_html: preview.innerHTML,
    match_score: currentMatchScore || 0,
  };
}

async function saveCurrentCvDraft(draft = readDraft()) {
  if (!currentCvDraftId) return;

  await fetch(`/api/cv-drafts/${currentCvDraftId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildCvDraftPayload(draft)),
  });
}

async function saveCurrentProfile(draft = readDraft()) {
  if (!currentProfileId) return;

  const mode = draft.profile_mode || "hybrid";
  const name = currentProfileLabel || draft.profile.target_title || `Profil ${modeLabels[mode] || mode}`;
  await fetch(`/api/profiles/${currentProfileId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mode, payload: draft }),
  });
}

function fillField(name, value) {
  const field = form.elements[name];
  if (!field) return;

  if (field instanceof RadioNodeList) {
    field.value = value || "auto";
    return;
  }

  if (field.type === "checkbox") {
    field.checked = Boolean(value);
    return;
  }

  field.value = value || "";
}

function applyDraft(draft) {
  try {
    const profile = draft.profile || {};

    [
      "name",
      "target_title",
      "location",
      "email",
      "phone",
      "links",
      "summary",
      "languages",
    ].forEach((name) => fillField(name, profile[name]));

    fillField("job_offer", draft.job_offer);
    fillField("profile_mode", draft.profile_mode);
    fillField("use_ollama", draft.use_ollama);
    cvFont.value = draft.cv_font || cvFont.value;
    cvTheme.value = draft.cv_theme || cvTheme.value;
    applyCvFont();
    applyCvTheme();

    groups.skillGroups.innerHTML = "";
    groups.experiences.innerHTML = "";
    groups.educationItems.innerHTML = "";
    (profile.skill_groups || []).forEach((item) => addItem("skillGroups", item));
    (profile.experiences || []).forEach((item) => addItem("experiences", item));
    (profile.education_items || []).forEach((item) => addItem("educationItems", item));

    if (!groups.skillGroups.children.length && profile.skills) {
      migrateLegacySkills(profile.skills).forEach((item) => addItem("skillGroups", item));
    }

    if (!groups.educationItems.children.length && profile.education) {
      profile.education.split("\n").filter(Boolean).forEach((line) => {
        addItem("educationItems", { title: line.trim() });
      });
    }

    if (!groups.skillGroups.children.length) defaultSkillGroups(draft.profile_mode).forEach((item) => addItem("skillGroups", item));
    if (!groups.experiences.children.length) addItem("experiences");
    if (!groups.educationItems.children.length) addItem("educationItems");
    statusEl.textContent = "Brouillon restauré";
    return true;
  } catch (error) {
    statusEl.textContent = `Brouillon illisible: ${error.message}`;
    return false;
  }
}

function restoreDraft() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;

  try {
    return applyDraft(JSON.parse(raw));
  } catch (error) {
    statusEl.textContent = `Brouillon local illisible: ${error.message}`;
    return false;
  }
}

async function restoreDatabaseDraft() {
  try {
    const response = await fetch(`/api/draft/${DRAFT_ID}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (!data.payload) return false;

    localStorage.setItem(STORAGE_KEY, JSON.stringify(data.payload));
    return applyDraft(data.payload);
  } catch (error) {
    statusEl.textContent = `Lecture SQLite indisponible: ${error.message}`;
    return false;
  }
}

async function loadProfiles() {
  try {
    const response = await fetch("/api/profiles");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    renderProfiles(data.profiles || []);
  } catch (error) {
    profileGrid.innerHTML = `<article class="profile-card"><p>Impossible de charger les profils : ${error.message}</p></article>`;
  }
}

async function loadCvDrafts() {
  try {
    const response = await fetch("/api/cv-drafts");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    renderCvDrafts(data.drafts || []);
  } catch (error) {
    cvDraftGrid.innerHTML = `<article class="profile-card"><p>Impossible de charger les brouillons : ${error.message}</p></article>`;
  }
}

function renderProfiles(profiles) {
  profileCount.textContent = `${profiles.length} profil${profiles.length > 1 ? "s" : ""}`;

  if (!profiles.length) {
    profileGrid.innerHTML = `
      <article class="profile-card">
        <h3>Aucun profil pour l'instant</h3>
        <p>Crée un profil Data, IA, Dev ou Hybride pour commencer.</p>
      </article>
    `;
    return;
  }

  profileGrid.innerHTML = profiles.map((profile) => `
    <article class="profile-card">
      <div>
        <h3>${escapeHtml(profile.name)}</h3>
        <p>${escapeHtml(modeLabels[profile.mode] || profile.mode)} · ${formatDate(profile.updated_at)}</p>
      </div>
      <div class="profile-card-actions">
        <button type="button" data-open-profile="${profile.id}">Ouvrir</button>
        <button class="danger" type="button" data-delete-profile="${profile.id}">Supprimer</button>
      </div>
    </article>
  `).join("");
}

function renderCvDrafts(drafts) {
  cvDraftCount.textContent = `${drafts.length} brouillon${drafts.length > 1 ? "s" : ""}`;

  if (!drafts.length) {
    cvDraftGrid.innerHTML = `
      <article class="profile-card">
        <h3>Aucun brouillon CV</h3>
        <p>Colle une offre dans Nouvelle candidature pour créer un draft ciblé.</p>
      </article>
    `;
    return;
  }

  cvDraftGrid.innerHTML = drafts.map((draft) => `
    <article class="profile-card">
      <div>
        <h3>${escapeHtml(draft.title)}</h3>
        <p>${escapeHtml(draft.company || "Sans entreprise")} · score ${draft.match_score}% · ${formatDate(draft.updated_at)}</p>
      </div>
      <div class="profile-card-actions">
        <button type="button" data-open-cv-draft="${draft.id}">Ouvrir</button>
        <button class="danger" type="button" data-delete-cv-draft="${draft.id}">Supprimer</button>
      </div>
    </article>
  `).join("");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(value) {
  if (!value) return "jamais modifié";
  return new Date(value).toLocaleDateString("fr-FR");
}

async function createProfile(mode = "hybrid", suggestedName = "") {
  const name = window.prompt("Nom du profil", suggestedName || `Profil ${modeLabels[mode] || "Hybride"}`);
  if (!name) return;

  const draft = makeBlankDraft(mode, name);
  const response = await fetch("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mode, payload: draft }),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const profile = await response.json();
  await openProfile(profile.id);
}

async function openProfile(profileId) {
  const response = await fetch(`/api/profiles/${profileId}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json();
  if (!data.profile) throw new Error("Profil introuvable");

  currentProfileId = data.profile.id;
  currentProfileLabel = data.profile.name;
  currentCvDraftId = null;
  currentCvDraftTitle = "";
  currentCvDraftCompany = "";
  currentSelectedProfileId = "";
  currentApplicationOffer = "";
  currentMatchScore = 0;
  activeProfileName.textContent = data.profile.name;
  applyDraft(data.profile.payload);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data.profile.payload));
  showEditor();
  scheduleAutoGenerate();
}

async function analyzeApplicationOffer() {
  const jobOffer = applicationOffer.value.trim();
  if (!jobOffer) {
    applicationStatus.textContent = "Colle une offre avant de créer un brouillon.";
    return;
  }

  applicationStatus.textContent = "Analyse des profils en cours...";
  const response = await fetch("/api/cv-drafts/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: applicationTitle.value.trim(),
      company: applicationCompany.value.trim(),
      job_offer: jobOffer,
    }),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json();
  if (result.error) {
    applicationStatus.textContent = result.error;
    return;
  }

  applicationStatus.textContent = `Profil choisi : ${result.selected_profile.name}`;
  await openCvDraft(result.draft.id);
}

async function openCvDraft(draftId) {
  const response = await fetch(`/api/cv-drafts/${draftId}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json();
  if (!data.draft) throw new Error("Brouillon introuvable");

  currentProfileId = null;
  currentProfileLabel = "";
  currentCvDraftId = data.draft.id;
  currentCvDraftTitle = data.draft.title;
  currentCvDraftCompany = data.draft.company;
  currentSelectedProfileId = data.draft.selected_profile_id;
  currentApplicationOffer = data.draft.job_offer;
  currentMatchScore = data.draft.match_score;
  activeProfileName.textContent = data.draft.title;
  applyDraft(data.draft.payload);
  preview.innerHTML = data.draft.generated_html || preview.innerHTML;
  applyCvFont();
  applyCvTheme();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data.draft.payload));
  showEditor();
}

async function deleteCvDraft(draftId) {
  if (!window.confirm("Supprimer ce brouillon CV ?")) return;

  await fetch(`/api/cv-drafts/${draftId}`, { method: "DELETE" });
  if (draftId === currentCvDraftId) {
    currentCvDraftId = null;
    currentCvDraftTitle = "";
  }
  await loadCvDrafts();
}

async function deleteProfile(profileId) {
  if (!window.confirm("Supprimer ce profil ?")) return;

  await fetch(`/api/profiles/${profileId}`, { method: "DELETE" });
  if (profileId === currentProfileId) {
    currentProfileId = null;
    currentProfileLabel = "";
  }
  await loadProfiles();
}

function resetDraft() {
  clearTimeout(databaseSaveTimer);
  localStorage.removeItem(STORAGE_KEY);
  fetch(`/api/draft/${DRAFT_ID}`, { method: "DELETE" }).catch(() => {});
  form.reset();
  groups.skillGroups.innerHTML = "";
  groups.experiences.innerHTML = "";
  groups.educationItems.innerHTML = "";
  defaultSkillGroups("hybrid").forEach((item) => addItem("skillGroups", item));
  addItem("experiences");
  addItem("educationItems");
  keywordsEl.innerHTML = "";
  cvFont.value = "Arial, Helvetica, sans-serif";
  cvTheme.value = "theme-slate";
  applyCvFont();
  applyCvTheme();
  preview.innerHTML = `
    <section class="empty-state">
      <h1>Ton CV ciblé apparaîtra ici</h1>
      <p>Remplis ta palette, colle une offre, puis génère une version adaptée.</p>
    </section>
  `;
  statusEl.textContent = "Brouillon réinitialisé";
}

function applyCvFont() {
  preview.style.setProperty("--cv-font", cvFont.value);
}

function applyCvTheme() {
  preview.querySelectorAll(".cv-page").forEach((page) => {
    page.classList.remove("theme-slate", "theme-navy", "theme-teal", "theme-burgundy", "theme-graphite");
    page.classList.add(cvTheme.value);
  });
}

function scheduleAutoGenerate() {
  clearTimeout(autoGenerateTimer);

  if (preview.contains(document.activeElement)) return;

  autoGenerateTimer = setTimeout(() => {
    generateCv(null, { automatic: true, useOllama: false });
  }, AUTO_GENERATE_DELAY);
}

async function generateCv(event, options = {}) {
  if (event) event.preventDefault();
  const currentGeneration = ++generationId;
  const payload = readDraft();
  payload.use_ollama = options.useOllama ?? payload.use_ollama;
  saveDraft(options.automatic ? "Mise à jour automatique..." : "Brouillon sauvegardé avant génération");

  statusEl.textContent = options.automatic ? "Mise à jour du CV..." : "Génération en cours...";
  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (currentGeneration !== generationId) return;

    preview.innerHTML = result.html;
    applyCvFont();
    applyCvTheme();
    currentMatchScore = result.match_score;
    keywordsEl.innerHTML = result.keywords.map((word) => `<span>${word}</span>`).join("");
    statusEl.textContent = result.used_ollama
      ? `Généré avec Ollama - score ${result.match_score}%`
      : `Généré localement - score ${result.match_score}%`;
    if (result.note) statusEl.textContent += ` (${result.note})`;
    if (currentCvDraftId) await saveCurrentCvDraft(readDraft());
  } catch (error) {
    if (currentGeneration !== generationId) return;
    statusEl.textContent = `Erreur: ${error.message}`;
  }
}

function loadSample() {
  form.elements.name.value = "Prénom Nom";
  form.elements.target_title.value = "Full Stack / Data / AI Engineer";
  form.elements.location.value = "Paris, France";
  form.elements.email.value = "prenom.nom@email.com";
  form.elements.phone.value = "+33 6 00 00 00 00";
  form.elements.links.value = "linkedin.com/in/profil | github.com/profil";
  form.elements.summary.value = "Développeur full stack et ingénieur data/IA, capable de concevoir des APIs, interfaces web, pipelines de données et prototypes IA orientés métier.";
  form.elements.languages.value = "Français courant\nAnglais professionnel";
  form.elements.job_offer.value = "Nous recherchons un Data Engineer Python pour construire des pipelines ETL avec Airflow, SQL, Spark et Docker. Expérience API appréciée.";
  cvFont.value = "Arial, Helvetica, sans-serif";
  cvTheme.value = "theme-navy";
  applyCvFont();
  applyCvTheme();

  groups.skillGroups.innerHTML = "";
  groups.experiences.innerHTML = "";
  groups.educationItems.innerHTML = "";

  [
    { name: "Langages", skills: "Java, Python, JavaScript, SQL", include: true },
    { name: "Backend / APIs", skills: "FastAPI, Flask, Spring Boot, API REST", include: true },
    { name: "Frontend", skills: "React, Angular", include: true },
    { name: "Data / IA", skills: "Pandas, Spark, Airflow, ETL, Machine Learning, LLM, RAG", include: true },
    { name: "Cloud / DevOps", skills: "Docker, Git", include: true },
    { name: "BI / Analyse", skills: "Power BI", include: true },
  ].forEach((item) => addItem("skillGroups", item));

  addItem("experiences", {
    title: "Full Stack Developer",
    organization: "Entreprise A",
    period: "2022 - 2024",
    tags: "React, FastAPI, SQL, Docker",
    description: "- Développement d'applications web avec React et APIs Python\n- Conception de schémas SQL et optimisation de requêtes\n- Industrialisation avec Docker et CI/CD",
  });
  addItem("experiences", {
    title: "Data / Analytics Engineer",
    organization: "Entreprise B",
    period: "2020 - 2022",
    tags: "Python, Airflow, Spark, ETL",
    description: "- Création de pipelines ETL Python pour alimenter des tableaux de bord\n- Orchestration de traitements avec Airflow\n- Transformation de données volumineuses avec Spark",
  });
  addItem("educationItems", {
    title: "Master Informatique / Data",
    organization: "Université / École",
    period: "2021 - 2023",
    tags: "Data, Software Engineering",
    description: "- Spécialisation data engineering et développement logiciel",
    include: true,
  });
  addItem("educationItems", {
    title: "Certification Cloud ou Data",
    organization: "Organisme de formation",
    period: "2024",
    tags: "Cloud, Data",
    description: "- Certification orientée plateformes data et industrialisation",
    include: false,
  });
  saveDraft("Exemple chargé et sauvegardé");
  scheduleAutoGenerate();
}

document.querySelectorAll("[data-add]").forEach((button) => {
  button.addEventListener("click", () => {
    addItem(button.dataset.add);
    saveDraft("Sauvegarde automatique");
    scheduleAutoGenerate();
  });
});

document.querySelector("#loadSample").addEventListener("click", loadSample);
document.querySelector("#createProfile").addEventListener("click", () => createProfile("hybrid"));
document.querySelector("#analyzeOffer").addEventListener("click", () => {
  analyzeApplicationOffer().catch((error) => {
    applicationStatus.textContent = `Erreur : ${error.message}`;
  });
});
document.querySelector("#backHome").addEventListener("click", showHome);
document.querySelector("#saveDraft").addEventListener("click", async () => {
  saveDraft("Profil sauvegardé");
  await saveCurrentProfile();
});
document.querySelector("#resetDraft").addEventListener("click", resetDraft);
document.querySelector("#printCv").addEventListener("click", () => window.print());
cvFont.addEventListener("change", () => {
  applyCvFont();
  saveDraft("Police sauvegardée");
});
cvTheme.addEventListener("change", () => {
  applyCvTheme();
  saveDraft("Thème sauvegardé");
});
document.querySelector("#copyHtml").addEventListener("click", async () => {
  await navigator.clipboard.writeText(preview.innerHTML);
  statusEl.textContent = "HTML copié";
});

document.querySelectorAll("[data-create-mode]").forEach((button) => {
  button.addEventListener("click", () => createProfile(button.dataset.createMode));
});

document.querySelectorAll("[data-workflow]").forEach((button) => {
  button.addEventListener("click", () => showWorkflow(button.dataset.workflow));
});

document.querySelectorAll("[data-home-dashboard]").forEach((button) => {
  button.addEventListener("click", showHomeDashboard);
});

profileGrid.addEventListener("click", async (event) => {
  const openButton = event.target.closest("[data-open-profile]");
  const deleteButton = event.target.closest("[data-delete-profile]");

  if (openButton) await openProfile(openButton.dataset.openProfile);
  if (deleteButton) await deleteProfile(deleteButton.dataset.deleteProfile);
});

cvDraftGrid.addEventListener("click", async (event) => {
  const openButton = event.target.closest("[data-open-cv-draft]");
  const deleteButton = event.target.closest("[data-delete-cv-draft]");

  if (openButton) await openCvDraft(openButton.dataset.openCvDraft);
  if (deleteButton) await deleteCvDraft(deleteButton.dataset.deleteCvDraft);
});

form.addEventListener("submit", (event) => generateCv(event));
form.addEventListener("input", () => {
  saveDraft("Sauvegarde automatique");
  scheduleAutoGenerate();
});
form.addEventListener("change", () => {
  saveDraft("Sauvegarde automatique");
  scheduleAutoGenerate();
});

window.addEventListener("beforeunload", flushDatabaseSave);

applyCvFont();
applyCvTheme();

async function initializeApp() {
  await loadProfiles();
  await loadCvDrafts();
  defaultSkillGroups("hybrid").forEach((item) => addItem("skillGroups", item));
  addItem("experiences");
  addItem("educationItems");
}

initializeApp();
